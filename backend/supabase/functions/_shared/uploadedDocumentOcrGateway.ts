import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";

const identity = (request_id: string, lease: string) => ({ request_id, lease });
async function originalBytes(
  blob: Blob | null,
  expectedHash: string,
  expectedSize: number,
) {
  if (!blob)
    throw new AppError(
      503,
      "DOCUMENT_OCR_STORAGE_UNAVAILABLE",
      "The uploaded original is not available for this attempt.",
    );
  if (blob.size !== Number(expectedSize) || blob.size > 10485760)
    throw new AppError(
      422,
      "UPLOAD_MISMATCH",
      "The saved original differs from its admitted size.",
    );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== expectedHash)
    throw new AppError(
      422,
      "UPLOAD_MISMATCH",
      "The saved original differs from its admitted hash.",
    );
  return { bytes, hash, size: bytes.length };
}
export async function uploadedOcrInput(
  backend: Backend,
  request_id: string,
  lease: string,
) {
  const args = identity(request_id, lease);
  const context = await backend.internal("uploaded_document_ocr_context", args);
  if (context.request.active_page === null)
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      "This attempt does not read a page.",
    );
  const actual = await originalBytes(
    await backend.deliveryObject(context.document.storage_key),
    context.document.original_hash,
    context.document.expected_size,
  );
  await backend.internal("uploaded_document_ocr_context", args);
  let binary = "";
  for (let offset = 0; offset < actual.bytes.length; offset += 32768)
    binary += String.fromCharCode(
      ...actual.bytes.subarray(offset, offset + 32768),
    );
  return { bytes: btoa(binary), original_hash: actual.hash };
}

/** A pending successor row reserves real physical capacity before copying.
 * Existing/lost-reply copies are reused only after an independent stored-byte
 * hash/size read. Publication rechecks lease, source and current identity. */
export async function publishUploadedOcr(
  backend: Backend,
  request_id: string,
  lease: string,
) {
  const args = identity(request_id, lease);
  try {
    const reservation = await backend.internal(
      "prepare_uploaded_document_ocr_publication",
      args,
    );
    let blob = await backend.deliveryObject(reservation.destination_key);
    if (!blob) {
      try {
        await backend.copyOriginalForOcr(
          reservation.source_key,
          reservation.destination_key,
        );
      } catch {
        /* A lost reply is resolved solely by reading the immutable key. */
      }
      blob = await backend.deliveryObject(reservation.destination_key);
    }
    const actual = await originalBytes(
      blob,
      reservation.original_hash,
      reservation.expected_size,
    );
    const current = await backend.internal(
      "prepare_uploaded_document_ocr_publication",
      args,
    );
    if (
      current.successor_id !== reservation.successor_id ||
      current.destination_key !== reservation.destination_key ||
      current.output_hash !== reservation.output_hash
    )
      throw new AppError(
        409,
        "STALE_INPUT",
        "The OCR successor reservation changed.",
      );
    return await backend.internal(
      "complete_uploaded_document_ocr_publication",
      { ...args, actual_hash: actual.hash, actual_size: actual.size },
    );
  } catch (failure) {
    const allowed = [
      "STORAGE_CAP_REACHED",
      "EXTRACTION_CAP_REACHED",
      "PACKAGE_CAP_REACHED",
      "DATA_POLICY_BLOCKED",
      "ROLE_FORBIDDEN",
      "STALE_INPUT",
      "RESTORE_IN_PROGRESS",
      "UPLOAD_MISMATCH",
      "INVALID_EXTRACTION_COVERAGE",
    ];
    const code =
      failure instanceof AppError && allowed.includes(failure.code)
        ? failure.code
        : "DOCUMENT_OCR_STORAGE_UNAVAILABLE";
    // Revocation can block publication after the copy. Retain its reservation;
    // cancellation or cleanup cannot pretend possibly stored bytes are absent.
    await backend.internal("fail_uploaded_document_ocr_publication", {
      ...args,
      error_code: code,
    });
    return { status: "pending", error_code: code };
  }
}
