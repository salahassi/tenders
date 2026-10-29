import type { DocumentRecord } from "../types";
import { structuredDocxText } from "./structuredDocx";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export async function extractDocumentOnWorker(
  file: File,
  classification: DocumentRecord["classification"] = "unspecified",
): Promise<DocumentRecord> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error("The file exceeds the 10 MiB trial limit.");
  if (!file.size) throw new Error("The file is empty.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "md", "pdf", "docx"].includes(extension || ""))
    throw new Error("Choose a PDF, DOCX, TXT, or Markdown file.");
  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes.slice(0, 8));
  let text = "";
  let partialExtraction = false;
  if (extension === "pdf") {
    if (new TextDecoder().decode(prefix).slice(0, 5) !== "%PDF-")
      throw new Error("The file signature does not match PDF.");
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    const workerUrl = new URL(worker.default, self.location.href);
    // Skip the former octet-stream response cached as immutable for one year.
    workerUrl.searchParams.set("module-mime", "javascript-v1");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(0),
      enableXfa: false,
      stopAtErrors: true,
    });
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > 200)
        throw new Error("The trial supports up to 200 PDF pages per file.");
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        if (
          content.items.filter((item) => "str" in item && item.str.trim())
            .length === 0
        )
          partialExtraction = true;
        pages.push(
          `[Page ${pageNumber}]\n${content.items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")).join("")}`,
        );
        if (pages.join("").length > 1_000_000)
          throw new Error(
            "Extracted content exceeds the 1,000,000-character trial limit.",
          );
      }
      text = pages.join("\n\n");
    } finally {
      await loadingTask.destroy();
    }
  } else if (extension === "docx") {
    if (prefix[0] !== 80 || prefix[1] !== 75)
      throw new Error("The file signature does not match DOCX.");
    // Reject archive expansion before handing the bounded file to Mammoth.
    const view = new DataView(bytes);
    let entries = 0;
    let expandedBytes = 0;
    for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      entries++;
      expandedBytes += view.getUint32(offset + 24, true);
      if (entries > 256 || expandedBytes > 40 * 1024 * 1024)
        throw new Error(
          "The DOCX archive exceeds safe local extraction limits.",
        );
      const length = view.getUint16(offset + 28, true);
      const entryName = new TextDecoder().decode(
        bytes.slice(offset + 46, offset + 46 + length),
      );
      if (/vbaProject|embeddings\//i.test(entryName))
        throw new Error(
          "Embedded executable or active content is not accepted.",
        );
    }
    const mammoth = await import("mammoth");
    await mammoth.convertToHtml(
      { arrayBuffer: bytes },
      {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
        transformDocument(document) {
          text = structuredDocxText(document);
          return { ...document, children: [] };
        },
      },
    );
  } else {
    if (prefix.some((byte) => byte === 0))
      throw new Error("The file does not appear to be plain text.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (text.length > 1_000_000)
    throw new Error(
      "Extracted content exceeds the 1,000,000-character trial limit.",
    );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const readable =
    text.replace(/\[Page \d+\]/g, "").trim().length >= 30 && !partialExtraction;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text,
    status: readable ? "ready" : "needs_ocr",
    classification,
    hash,
  };
}
