import { Inflate } from "fflate";
import { AppError } from "./http.ts";

const bad = (message = "The Word archive is invalid."): never => {
  throw new AppError(422, "INVALID_EXPORT_ARCHIVE", message);
};
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  crcTable[i] = c >>> 0;
}
export interface DocxEntry {
  name: string;
  size: number;
}
/** Validate both ZIP indexes before inflating. Expanded document allowance is
 * proportional to the trusted model, never an archive-supplied allocation. */
export function* readDocxArchiveChunks(
  bytes: Uint8Array,
  documentLimit: number,
  visit: (entry: DocxEntry) => (chunk: Uint8Array, final: boolean) => void,
) {
  if (!bytes.length || bytes.length > 10485760)
    throw new AppError(
      413,
      "FILE_SIZE_INVALID",
      "Files must contain 1 byte to 10 MiB.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < 22 || u32(0) !== 0x04034b50) bad();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  if (end < 0 || u16(end + 4) || u16(end + 6)) bad();
  const count = u16(end + 10),
    directorySize = u32(end + 12),
    directory = u32(end + 16);
  if (
    !count ||
    count > 256 ||
    u16(end + 8) !== count ||
    directory + directorySize !== end
  )
    bad();
  const decode = (start: number, size: number) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(start, start + size),
      );
    } catch {
      return bad();
    }
  };
  const entries: (DocxEntry & {
    start: number;
    compressed: number;
    method: number;
    crc: number;
    finish: number;
  })[] = [];
  const names = new Set<string>();
  let pos = directory,
    expanded = 0;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50) bad();
    const flags = u16(pos + 8),
      method = u16(pos + 10),
      crc = u32(pos + 16),
      compressed = u32(pos + 20),
      size = u32(pos + 24);
    const nameLength = u16(pos + 28),
      extra = u16(pos + 30),
      comment = u16(pos + 32),
      offset = u32(pos + 42);
    if (
      pos + 46 + nameLength + extra + comment > end ||
      u16(pos + 34) ||
      flags & ~0x080e ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      bad();
    const name = decode(pos + 46, nameLength);
    if (
      !name ||
      nameLength > 1024 ||
      names.has(name) ||
      /[\\\x00-\x1f]|^\/|(^|\/)\.\.?($|\/)|vbaProject|embeddings\//i.test(name)
    )
      bad();
    names.add(name);
    const limit =
      name === "word/document.xml" ? documentLimit : 4 * 1024 * 1024;
    expanded += size;
    if (
      size > limit ||
      expanded > documentLimit + 16 * 1024 * 1024 ||
      !Number.isSafeInteger(expanded)
    )
      bad("The Word archive exceeds its authorized content budget.");
    if (
      offset + 30 > directory ||
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method
    )
      bad();
    const localNameLength = u16(offset + 26),
      localExtra = u16(offset + 28);
    const start = offset + 30 + localNameLength + localExtra;
    if (
      start + compressed > directory ||
      localNameLength !== nameLength ||
      decode(offset + 30, localNameLength) !== name
    )
      bad();
    let finish = start + compressed;
    if (flags & 8) {
      if (finish + 12 > directory) bad();
      const descriptor = u32(finish) === 0x08074b50 ? finish + 4 : finish;
      if (
        descriptor + 12 > directory ||
        u32(descriptor) !== crc ||
        u32(descriptor + 4) !== compressed ||
        u32(descriptor + 8) !== size
      )
        bad();
      finish = descriptor + 12;
      if (
        (u32(offset + 14) && u32(offset + 14) !== crc) ||
        (u32(offset + 18) && u32(offset + 18) !== compressed) ||
        (u32(offset + 22) && u32(offset + 22) !== size)
      )
        bad();
    } else if (
      u32(offset + 14) !== crc ||
      u32(offset + 18) !== compressed ||
      u32(offset + 22) !== size
    )
      bad();
    entries.push({ name, size, start, compressed, method, crc, finish });
    pos += 46 + nameLength + extra + comment;
  }
  if (
    pos !== end ||
    !names.has("[Content_Types].xml") ||
    !names.has("word/document.xml")
  )
    bad();
  const physical = entries.map((entry) => ({ entry }));
  // The actual local offset includes the extra field; obtain it from the central
  // index again rather than guessing from a compressed payload signature.
  let c = directory;
  const offsets = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    offsets.set(decode(c + 46, u16(c + 28)), u32(c + 42));
    c += 46 + u16(c + 28) + u16(c + 30) + u16(c + 32);
  }
  physical.sort(
    (a, b) => offsets.get(a.entry.name)! - offsets.get(b.entry.name)!,
  );
  let boundary = 0;
  for (const { entry } of physical) {
    if (offsets.get(entry.name) !== boundary) bad();
    boundary = entry.finish;
  }
  if (boundary !== directory) bad();
  for (const entry of entries) {
    const consume = visit(entry);
    let actual = 0,
      crc = 0xffffffff;
    const output = (chunk: Uint8Array, final: boolean) => {
      // A512-byte raw DEFLATE push cannot legitimately expand beyond this
      // guard, including its32KiB back-reference history. Never accept an
      // inflater that allocates an unbounded entry-sized callback.
      if (chunk.length > 1024 * 1024) bad();
      actual += chunk.length;
      if (actual > entry.size) bad();
      for (let i = 0; i < chunk.length; i++)
        crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
      consume(chunk, final);
    };
    try {
      if (entry.method === 0) {
        if (entry.compressed !== entry.size) bad();
        for (let offset = 0; offset < entry.compressed; offset += 32768) {
          output(
            bytes.subarray(
              entry.start + offset,
              entry.start + Math.min(offset + 32768, entry.compressed),
            ),
            offset + 32768 >= entry.compressed,
          );
          yield;
        }
        if (!entry.compressed) output(new Uint8Array(), true);
      } else {
        // DEFLATE's bounded expansion per input byte plus its32KiB dictionary
        // keeps each output callback small even for very compressible tables.
        const inflater = new Inflate(output);
        for (let offset = 0; offset < entry.compressed; offset += 512) {
          inflater.push(
            bytes.subarray(
              entry.start + offset,
              entry.start + Math.min(offset + 512, entry.compressed),
            ),
            offset + 512 >= entry.compressed,
          );
          yield;
        }
        if (!entry.compressed) inflater.push(new Uint8Array(), true);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      bad();
    }
    if (actual !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) bad();
  }
  return names;
}
