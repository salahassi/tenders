/** Exact transport oracle for the synthetic capacity fixture. It hashes each
 * descriptor-sized result without parsing or retaining the aggregate JSON. */
import { createHash } from "node:crypto";
export interface BatchResultDescriptor {
  ordinal: number;
  byte_length: number;
  chunk_count: number;
  sha256: string;
}
export function batchStreamOracle(descriptors: BatchResultDescriptor[]) {
  if (!descriptors.length || descriptors.length > 100)
    throw Error("Invalid descriptor count");
  for (const [ordinal, value] of descriptors.entries()) {
    if (
      value.ordinal !== ordinal ||
      !Number.isSafeInteger(value.byte_length) ||
      value.byte_length < 1 ||
      value.chunk_count !== Math.ceil(value.byte_length / 262144) ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw Error("Invalid result descriptor");
  }
  const prefix = new TextEncoder().encode('{"data":[');
  const wire = createHash("sha256"),
    array = createHash("sha256").update("[");
  const hashes: string[] = [];
  let prefixOffset = 0,
    ordinal = 0,
    remaining = descriptors[0].byte_length;
  let result = createHash("sha256"),
    separator = false,
    closed = false,
    bytes = 0;
  const trailer: number[] = [];
  return {
    write(chunk: Uint8Array) {
      wire.update(chunk);
      bytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        if (prefixOffset < prefix.length) {
          if (chunk[offset++] !== prefix[prefixOffset++])
            throw Error("Wrong API envelope prefix");
        } else if (closed) {
          if (trailer.length >= 1024) throw Error("Unbounded API metadata");
          trailer.push(chunk[offset++]);
        } else if (separator) {
          const expected = ordinal === descriptors.length ? 93 : 44;
          if (chunk[offset++] !== expected)
            throw Error("Wrong result delimiter");
          array.update(new Uint8Array([expected]));
          separator = false;
          if (expected === 93) closed = true;
          else remaining = descriptors[ordinal].byte_length;
        } else {
          const size = Math.min(remaining, chunk.length - offset);
          const part = chunk.subarray(offset, offset + size);
          result.update(part);
          array.update(part);
          offset += size;
          remaining -= size;
          if (!remaining) {
            const digest = result.digest("hex");
            if (digest !== descriptors[ordinal].sha256)
              throw Error("Result bytes differ from immutable SQL receipt");
            hashes.push(digest);
            ordinal++;
            separator = true;
            result = createHash("sha256");
          }
        }
      }
    },
    finish() {
      if (!closed || ordinal !== descriptors.length)
        throw Error("Truncated batch result");
      const tail = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(trailer),
      );
      if (!tail.startsWith(',"meta":')) throw Error("Wrong API metadata");
      const parsed = JSON.parse("{" + tail.slice(1));
      if (
        Object.keys(parsed).join() !== "meta" ||
        Object.keys(parsed.meta).join() !== "request_id" ||
        !/^[0-9a-f-]{36}$/.test(parsed.meta.request_id)
      )
        throw Error("Wrong request identity");
      return {
        wire_bytes: bytes,
        wire_sha256: wire.digest("hex"),
        array_sha256: array.digest("hex"),
        result_count: hashes.length,
        result_hashes: hashes,
        array_bytes:
          descriptors.reduce((sum, value) => sum + value.byte_length, 0) +
          descriptors.length +
          1,
      };
    },
  };
}
