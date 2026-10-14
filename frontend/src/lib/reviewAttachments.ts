import type { DocumentRecord } from "../types";
import { extractLocalDocument, MAX_FILE_BYTES } from "./documents";
import { saveLocalFile } from "./knowledgeFiles";

export const MAX_REVIEW_ATTACHMENTS = 10;
export const REVIEW_ATTACHMENT_ACCEPT =
  ".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.xlsx,.pptx";

const allowed = new Set(
  REVIEW_ATTACHMENT_ACCEPT.split(",").map((x) => x.slice(1)),
);

/** Attach an original and record only text that was actually extracted locally.
 * Unsupported local extraction does not turn an accepted original into evidence.
 * This helper never sends content outside the browser. */
export async function attachReviewFile(file: File): Promise<DocumentRecord> {
  if (!file.size)
    throw new Error("This file is empty. Choose a file with content.");
  if (file.size > MAX_FILE_BYTES)
    throw new Error("This file exceeds 10 MiB. Choose a smaller file.");
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!allowed.has(extension))
    throw new Error(
      "Choose a PDF, DOCX, TXT, MD, CSV, PNG, JPG, WEBP, XLSX, or PPTX file.",
    );

  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes.slice(0, 12));
  const prefixText = new TextDecoder().decode(prefix);
  if (extension === "pdf" && !prefixText.startsWith("%PDF-"))
    throw new Error("The file contents do not match its PDF extension.");
  if (
    extension === "png" &&
    ![137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => prefix[i] === x)
  )
    throw new Error("The file contents do not match its PNG extension.");
  if (
    ["jpg", "jpeg"].includes(extension) &&
    !(prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
  )
    throw new Error("The file contents do not match its JPEG extension.");
  if (
    extension === "webp" &&
    !(prefixText.startsWith("RIFF") && prefixText.slice(8, 12) === "WEBP")
  )
    throw new Error("The file contents do not match its WEBP extension.");
  if (["docx", "xlsx", "pptx"].includes(extension)) {
    if (!(
      prefix[0] === 80 &&
      prefix[1] === 75 &&
      prefix[2] === 3 &&
      prefix[3] === 4
    ))
      throw new Error(
        `The file contents do not match its ${extension.toUpperCase()} extension.`,
      );
    // Apply the same bounded archive/active-content checks as document intake,
    // including formats that are retained for future processing only.
    const view = new DataView(bytes);
    let entries = 0;
    let expandedBytes = 0;
    for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      entries++;
      expandedBytes += view.getUint32(offset + 24, true);
      if (entries > 2000 || expandedBytes > 50 * 1024 * 1024)
        throw new Error(
          "The archive exceeds safe local file limits. Choose a smaller document.",
        );
      const length = view.getUint16(offset + 28, true);
      const entry = new TextDecoder().decode(
        bytes.slice(offset + 46, offset + 46 + length),
      );
      if (/vbaProject|embeddings\//i.test(entry))
        throw new Error(
          "Embedded executable or active content is not accepted. Choose a document without embedded active content.",
        );
    }
  }

  let document: DocumentRecord;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const original: DocumentRecord = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    classification: "unspecified",
    hash,
    text: "",
    status: "needs_processing",
  };
  if (["txt", "md", "csv"].includes(extension)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        "This text file is not UTF-8. Save it as UTF-8 and attach it again.",
      );
    }
    if (text.includes("\0"))
      throw new Error(
        "The file does not contain plain text. Choose a supported document or image.",
      );
    document =
      text.length <= 1_000_000 && text.trim()
        ? { ...original, text, status: "ready" }
        : original;
  } else if (["pdf", "docx"].includes(extension)) {
    try {
      document = await extractLocalDocument(file);
    } catch {
      // Validation above has accepted the original; parsing, encryption or local
      // extraction limits can still prevent us from reading it. Preserve that
      // original without claiming that its contents have been understood.
      document = { ...original, status: "error" };
    }
  } else {
    document = original;
  }
  try {
    await saveLocalFile(document.id, file);
  } catch {
    throw new Error(
      "The original file could not be saved in this browser. Check available browser storage and try again.",
    );
  }
  return document;
}
