import { MIME_TYPES } from "./contracts.ts";
import { AppError } from "./http.ts";

/** Upload identity only. The caller must still run the complete canonical DOCX
 * verifier before acceptance. Its source-derived expanded-XML budget applies
 * to generated/reviewed exports; the original-RFP archive policy is separate. */
export function validateExportDocxEnvelope(
  name: string,
  mime: string,
  bytes: Uint8Array,
): void {
  if (!bytes.length || bytes.length > 10485760)
    throw new AppError(
      413,
      "FILE_SIZE_INVALID",
      "Files must contain 1 byte to 10 MiB.",
    );
  if (
    name.split(".").pop()?.toLowerCase() !== "docx" ||
    mime !== MIME_TYPES.docx
  )
    throw new AppError(
      422,
      "FILE_CONTENT_MISMATCH",
      "File extension and MIME type do not match.",
    );
  if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
    throw new AppError(
      422,
      "FILE_CONTENT_MISMATCH",
      "The reviewed Word file does not have an Office archive signature.",
    );
}
