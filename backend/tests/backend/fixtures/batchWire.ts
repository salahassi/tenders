import { createHash } from "node:crypto";

// Synthetic independent protocol fixtures. These deliberately retain original
// JSON whitespace, scalar values and escaped strings; no SQL/Auth claim.
export const batchReceipt = "81ebfb9a-5633-48e0-b08a-ce889cb25d1a";
export const batchChunkBytes = 262144;
export const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function batchWire(raw: string[]) {
  const encoded = raw.map((value) => new TextEncoder().encode(value));
  const manifest = {
    version: 1,
    receipt_id: batchReceipt,
    result_count: raw.length,
    chunk_bytes: batchChunkBytes,
    results: encoded.map((bytes, ordinal) => ({
      ordinal,
      byte_length: bytes.length,
      chunk_count: Math.ceil(bytes.length / batchChunkBytes),
      sha256: hash(bytes),
    })),
  };
  const chunk = (ordinal: number, index: number) => {
    const bytes = encoded[ordinal].subarray(
      index * batchChunkBytes,
      (index + 1) * batchChunkBytes,
    );
    return {
      version: 1,
      receipt_id: batchReceipt,
      result_ordinal: ordinal,
      chunk_index: index,
      byte_length: bytes.length,
      sha256: hash(bytes),
      data_base64: Buffer.from(bytes).toString("base64"),
    };
  };
  return { manifest, chunk, encoded };
}
