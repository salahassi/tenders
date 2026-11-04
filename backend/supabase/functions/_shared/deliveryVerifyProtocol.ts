import { AppError } from "./http.ts";

export const DOCX_FRAME_LIMIT = 10 * 1024 * 1024;
export const DOCX_VERDICT_LIMIT = 2048;
export const DOCX_CONTENT_ERRORS = new Set([
  "INVALID_EXPORT_ARCHIVE",
  "EXPORT_CONTENT_MISMATCH",
  "EXPORT_UNSAFE_CONTENT",
  "EXPORT_PLACEHOLDER_MISMATCH",
  "EXPORT_FIELDS_MISSING",
  "EXPORT_METADATA_REVIEW_REQUIRED",
]);
export async function docxDigest(bytes: Uint8Array) {
  // Frame buffers are privately owned snapshots. Hash their exact view without
  // an additional document-sized copy; copy a shared backing buffer defensively.
  const backing = bytes.buffer;
  const source =
    backing instanceof ArrayBuffer
      ? new Uint8Array(backing, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
export function verificationFailure() {
  return new AppError(
    503,
    "DELIVERY_RENDER_FAILED",
    "The Word verifier could not complete this attempt.",
  );
}
export function verificationTimeout() {
  return new AppError(
    503,
    "DELIVERY_RENDER_TIMEOUT",
    "The Word verifier exceeded this attempt's time limit.",
  );
}
export function frameHeader(modelBytes: number, documentBytes: number) {
  if (
    modelBytes < 1 ||
    modelBytes > DOCX_FRAME_LIMIT ||
    documentBytes < 1 ||
    documentBytes > DOCX_FRAME_LIMIT
  )
    throw new AppError(
      413,
      "FILE_SIZE_INVALID",
      "The Word verification input is outside the supported size.",
    );
  const header = new Uint8Array(8),
    view = new DataView(header.buffer);
  view.setUint32(0, modelBytes);
  view.setUint32(4, documentBytes);
  return header;
}
/** Lengths are checked before allocation. EOF is required after both fields. */
export async function readVerificationFrame(
  stream: ReadableStream<Uint8Array>,
) {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array();
  let position = 0;
  const read = async (length: number) => {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (position === chunk.length) {
        const next = await reader.read();
        if (next.done) throw verificationFailure();
        chunk = next.value;
        position = 0;
      }
      const size = Math.min(length - offset, chunk.length - position);
      result.set(chunk.subarray(position, position + size), offset);
      position += size;
      offset += size;
    }
    return result;
  };
  try {
    const header = await read(8),
      view = new DataView(header.buffer);
    const modelSize = view.getUint32(0),
      documentSize = view.getUint32(4);
    frameHeader(modelSize, documentSize);
    const model = await read(modelSize),
      bytes = await read(documentSize);
    if (position !== chunk.length || !(await reader.read()).done)
      throw verificationFailure();
    return { model, bytes };
  } finally {
    reader.releaseLock();
  }
}
export function acceptVerificationVerdict(
  bytes: Uint8Array,
  success: boolean,
  expected: { model_hash: string; document_hash: string; size: number },
) {
  let value: any;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw verificationFailure();
  } catch {
    throw verificationFailure();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw verificationFailure();
  if (!success) {
    if (
      Object.keys(value).sort().join(",") === "code,status,version" &&
      value.version === 1 &&
      ((value.status === 422 && DOCX_CONTENT_ERRORS.has(value.code)) ||
        (value.status === 413 && value.code === "FILE_SIZE_INVALID"))
    )
      throw new AppError(
        value.status,
        value.code,
        "The Word document did not pass canonical verification.",
      );
    throw verificationFailure();
  }
  if (
    Object.keys(value).sort().join(",") !==
      "document_hash,model_hash,size,verified,version" ||
    value.version !== 1 ||
    value.verified !== true ||
    value.model_hash !== expected.model_hash ||
    value.document_hash !== expected.document_hash ||
    value.size !== expected.size
  )
    throw verificationFailure();
  return true as const;
}
