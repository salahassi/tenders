import { MIME_TYPES } from "./contracts.ts";
import { AppError } from "./http.ts";

/** Bounded validation of original bytes. Parsing/rendering remains in browser. */
export function validateOriginal(
  name: string,
  mime: string,
  bytes: Uint8Array,
): void {
  const ext = name.split(".").pop()?.toLowerCase() as keyof typeof MIME_TYPES;
  const reject = (message: string): never => {
    throw new AppError(422, "FILE_CONTENT_MISMATCH", message);
  };
  if (!bytes.length || bytes.length > 10485760)
    throw new AppError(
      413,
      "FILE_SIZE_INVALID",
      "Files must contain 1 byte to 10 MiB.",
    );
  if (!ext || MIME_TYPES[ext] !== mime)
    reject("File extension and MIME type do not match.");
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  if (ext === "pdf" && !prefix.startsWith("%PDF-"))
    reject("The original does not have a PDF signature.");
  if (
    ext === "png" &&
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    reject("The original does not have a PNG signature.");
  if (
    ["jpg", "jpeg"].includes(ext) &&
    !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
  )
    reject("The original does not have a JPEG signature.");
  if (
    ext === "webp" &&
    !(prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP")
  )
    reject("The original does not have a WEBP signature.");
  if (["txt", "md", "csv"].includes(ext)) {
    try {
      if (
        new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")
      )
        reject("The original is not plain text.");
    } catch {
      reject("Text originals must be UTF-8.");
    }
  }
  if (["docx", "xlsx", "pptx"].includes(ext)) {
    if (!(
      bytes[0] === 80 &&
      bytes[1] === 75 &&
      bytes[2] === 3 &&
      bytes[3] === 4
    ))
      reject("The original does not have an Office archive signature.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let count = 0,
      expanded = 0;
    const names = new Set<string>();
    for (let i = 0; i + 46 <= bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      count++;
      expanded += view.getUint32(i + 24, true);
      if (count > 256 || expanded > 40 * 1024 * 1024)
        reject(
          "The Office archive exceeds 256 entries or 40 MiB expanded size.",
        );
      const length = view.getUint16(i + 28, true);
      if (i + 46 + length > bytes.length)
        reject("The Office archive is incomplete.");
      const entry = new TextDecoder().decode(
        bytes.slice(i + 46, i + 46 + length),
      );
      names.add(entry);
      if (view.getUint16(i + 8, true) & 1)
        reject("Password-protected Office files are not supported.");
      if (/vbaProject|embeddings\/|(^|\/)\.\.\//i.test(entry))
        reject("Active or embedded executable content is not supported.");
    }
    const required =
      ext === "docx"
        ? "word/document.xml"
        : ext === "xlsx"
          ? "xl/workbook.xml"
          : "ppt/presentation.xml";
    if (!names.has("[Content_Types].xml") || !names.has(required))
      reject("The archive does not contain the expected Office document.");
  }
}
