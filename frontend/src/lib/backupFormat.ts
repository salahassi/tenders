import JSZip from "jszip";
import { z } from "zod";
import { unsafeBusinessContent } from "./contentEligibility";
export const BACKUP_LIMIT = 419430400;
const rowKey = z.string().regex(/^[a-z_]+\/[0-9a-f-]{36}$/),
  digest = z.string().regex(/^[0-9a-f]{64}$/);
export const backupManifestSchema = z
  .object({
    format: z.literal("tenderdesk-backup-v1"),
    schema_hash: digest,
    source_workspace: z.uuid(),
    workspace_name: z.string().min(1).max(200),
    settings: z.record(z.string(), z.unknown()),
    root_hash: digest,
    rows: z
      .array(
        z
          .object({
            key: rowKey,
            hash: digest,
            size: z.number().int().min(2).max(9437184),
          })
          .strict(),
      )
      .max(100000),
    files: z
      .array(
        z
          .object({
            key: z
              .string()
              .regex(/^(?:documents|export_artifacts)\/[0-9a-f-]{36}$/),
            hash: digest,
            size: z.number().int().min(1).max(10485760),
            name: z.string().min(1).max(1000),
            mime: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupRow = { key: string; data: string; hash: string };
export type BackupBundle = {
  manifest: BackupManifest;
  rows: BackupRow[];
  files: Record<string, Uint8Array>;
};
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export async function backupHash(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length)
    throw Error("The backup contains duplicate records or files.");
}
export async function validateBackup(bundle: BackupBundle) {
  const manifest = backupManifestSchema.parse(bundle.manifest);
  unique(manifest.rows.map((r) => r.key));
  unique(manifest.files.map((f) => f.key));
  unique(bundle.rows.map((r) => r.key));
  if (
    manifest.rows.reduce((n, r) => n + r.size, 0) > 134217728 ||
    manifest.files.reduce((n, f) => n + f.size, 0) > 262144000
  )
    throw Error("The backup exceeds the workspace limits.");
  if (
    bundle.rows.length !== manifest.rows.length ||
    Object.keys(bundle.files).length !== manifest.files.length
  )
    throw Error("The backup is incomplete.");
  const expected = new Map(manifest.rows.map((r) => [r.key, r]));
  for (const row of bundle.rows) {
    const entry = expected.get(row.key);
    if (
      !entry ||
      encoder.encode(row.data).length !== entry.size ||
      (await backupHash(row.data)) !== entry.hash
    )
      throw Error("A backup record failed its hash check.");
    row.hash = entry.hash;
    const data = JSON.parse(row.data);
    if (
      data.id !== row.key.split("/")[1] ||
      data.workspace_id !== manifest.source_workspace
    )
      throw Error("A backup record has the wrong identity.");
    if (
      !/^(?:audit_events|workspace_actors)\//.test(row.key) &&
      unsafeBusinessContent(row.data)
    )
      throw Error(
        "Review confidential, personal or secret content before restoring this backup.",
      );
  }
  for (const file of manifest.files) {
    const bytes = bundle.files[file.key];
    if (
      !expected.has(file.key) ||
      !bytes ||
      bytes.byteLength !== file.size ||
      (await backupHash(bytes)) !== file.hash
    )
      throw Error("An original file failed its hash check.");
    if (unsafeBusinessContent(file.name))
      throw Error("Review file names before restoring this backup.");
  }
  return bundle;
}
// The application writes STORE archives. Reject compression before opening an archive, so forged expansion sizes cannot cause a decompression bomb.
export function checkBackupZip(bytes: Uint8Array) {
  if (bytes.byteLength > BACKUP_LIMIT || bytes.byteLength < 22)
    throw Error("Backup size is invalid.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u16 = (n: number) => view.getUint16(n, true),
    u32 = (n: number) => view.getUint32(n, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== u16(end + 10) ||
    u16(end + 10) > 6000
  )
    throw Error("Unsupported backup archive.");
  const count = u16(end + 10),
    offset = u32(end + 16),
    length = u32(end + 12);
  if (offset + length !== end) throw Error("Invalid backup directory.");
  let cursor = offset,
    total = 0;
  const names = new Set<string>(),
    ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50)
      throw Error("Invalid backup entry.");
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      packed = u32(cursor + 20),
      size = u32(cursor + 24),
      nameLength = u16(cursor + 28),
      extra = u16(cursor + 30),
      comment = u16(cursor + 32),
      local = u32(cursor + 42);
    if (
      flags & 1 ||
      method !== 0 ||
      packed !== size ||
      cursor + 46 + nameLength + extra + comment > end
    )
      throw Error("Use an unmodified Tenderdesk backup ZIP.");
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !/^(?:manifest\.json|records\/[0-9]{5}\.ndjson|files\/(?:documents|export_artifacts)\/[0-9a-f-]{36})$/.test(
        name,
      ) ||
      names.has(name) ||
      size > (name === "manifest.json" ? 16777216 : 10485760)
    )
      throw Error("Invalid or duplicate backup path.");
    names.add(name);
    total += size;
    if (
      total > BACKUP_LIMIT ||
      local + 30 > offset ||
      u32(local) !== 0x04034b50 ||
      u16(local + 6) & 1 ||
      u16(local + 8) !== 0 ||
      u32(local + 18) !== packed ||
      u32(local + 22) !== size
    )
      throw Error("Invalid backup file bounds.");
    const localName = u16(local + 26),
      start = local + 30 + localName + u16(local + 28);
    if (
      start + size > offset ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + localName)) !==
        name
    )
      throw Error("Invalid backup local entry.");
    ranges.push([local, start + size]);
    cursor += 46 + nameLength + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (
    cursor !== end ||
    !names.has("manifest.json") ||
    ranges.some((r, i) => i > 0 && r[0] < ranges[i - 1][1])
  )
    throw Error("Invalid backup layout.");
  return names;
}
export async function packBackup(bundle: BackupBundle) {
  await validateBackup(bundle);
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(bundle.manifest), {
    createFolders: false,
  });
  let batch: string[] = [],
    size = 0,
    index = 0;
  const flush = () => {
    if (batch.length) {
      zip.file(
        `records/${String(index++).padStart(5, "0")}.ndjson`,
        batch.join("\n"),
        { createFolders: false },
      );
      batch = [];
      size = 0;
    }
  };
  for (const row of bundle.rows) {
    const line = row.key + "\t" + row.data,
      n = encoder.encode(line).length;
    if (size + n + 1 > 10485760) flush();
    batch.push(line);
    size += n + 1;
  }
  flush();
  for (const [key, bytes] of Object.entries(bundle.files))
    zip.file("files/" + key, bytes, { createFolders: false });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
    streamFiles: false,
  });
  checkBackupZip(bytes);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
export async function unpackBackup(file: Blob): Promise<BackupBundle> {
  if (file.size > BACKUP_LIMIT) throw Error("The backup exceeds 400 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    names = checkBackupZip(bytes),
    zip = await JSZip.loadAsync(bytes, {
      checkCRC32: true,
      createFolders: false,
    }),
    manifest = backupManifestSchema.parse(
      JSON.parse(await zip.file("manifest.json")!.async("string")),
    ),
    rows: BackupRow[] = [],
    files: Record<string, Uint8Array> = {};
  for (const name of names) {
    if (name.startsWith("records/")) {
      const text = await zip.file(name)!.async("string");
      for (const line of text.split("\n")) {
        if (!line) continue;
        const split = line.indexOf("\t");
        if (split < 1) throw Error("Invalid backup record.");
        rows.push({
          key: line.slice(0, split),
          data: line.slice(split + 1),
          hash: "",
        });
        if (rows.length > 100000) throw Error("Too many backup records.");
      }
    } else if (name.startsWith("files/"))
      files[name.slice(6)] = await zip.file(name)!.async("uint8array");
  }
  return validateBackup({ manifest, rows, files });
}
