import type { DocumentRecord, DocumentExtractionCoverage } from "../types";
import { structuredDocxText } from "./structuredDocx";
import { DocumentExtractionError } from "./documentExtractionError";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export async function extractDocumentOnWorker(
  file: File,
  classification: DocumentRecord["classification"] = "unspecified",
): Promise<DocumentRecord> {
  try {
    return await extractDocument(file, classification);
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError(
      "EXTRACTION_FAILED",
      "The document could not be read. Its content has not been established; readable remaining inputs can still be used.",
    );
  }
}
async function extractDocument(
  file: File,
  classification: DocumentRecord["classification"] = "unspecified",
): Promise<DocumentRecord> {
  if (file.size > MAX_FILE_BYTES)
    throw new DocumentExtractionError(
      "EXTRACTION_LIMIT",
      "The file exceeds the 10 MiB trial limit.",
    );
  if (!file.size)
    throw new DocumentExtractionError("EMPTY_FILE", "The file is empty.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "md", "pdf", "docx"].includes(extension || ""))
    throw new DocumentExtractionError(
      "UNSUPPORTED_FORMAT",
      "Choose a PDF, DOCX, TXT, or Markdown file.",
    );
  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes.slice(0, 8));
  let text = "";
  let extractionCoverage: DocumentExtractionCoverage | undefined;
  if (extension === "pdf") {
    if (new TextDecoder().decode(prefix).slice(0, 5) !== "%PDF-")
      throw new DocumentExtractionError(
        "INVALID_FILE",
        "The file signature does not match PDF.",
      );
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    const workerUrl = new URL(worker.default, self.location.href);
    // Bypass octet-stream responses cached before this MIME repair.
    workerUrl.searchParams.set("module-mime", "javascript-v2");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(0),
      enableXfa: false,
      stopAtErrors: true,
    });
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > 200)
        throw new DocumentExtractionError(
          "EXTRACTION_LIMIT",
          "The trial supports up to 200 PDF pages per file.",
        );
      const pages: string[] = [];
      extractionCoverage = {
        version: 1,
        kind: "pdf_pages",
        complete: true,
        pages: [],
      };
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        let pageText = "";
        let status: DocumentExtractionCoverage["pages"][number]["status"] =
          "extraction_failed";
        try {
          const page = await pdf.getPage(pageNumber);
          try {
            const content = await page.getTextContent();
            pageText = content.items
              .map((item) =>
                "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
              )
              .join("")
              .trim();
            if (pageText) status = "readable";
            else {
              // Absence of text alone does not establish a blank page: a scan
              // or drawing still needs processing. Only no drawing operators
              // is positive evidence of an empty page in this extraction.
              try {
                status =
                  (await page.getOperatorList()).fnArray.length === 0
                    ? "blank"
                    : "needs_ocr";
              } catch {
                status = "needs_ocr";
              }
            }
          } finally {
            try {
              page.cleanup();
            } catch {
              /* Cleanup cannot erase extracted text. */
            }
          }
        } catch {
          // A damaged page cannot discard text from the rest of the original.
          pageText = "";
        }
        extractionCoverage.pages.push({
          page: pageNumber,
          status,
          characters: Array.from(pageText).length,
        });
        if (status === "needs_ocr" || status === "extraction_failed")
          extractionCoverage.complete = false;
        pages.push(`[Page ${pageNumber}]\n${pageText}`);
        if (pages.join("").length > 1_000_000)
          throw new DocumentExtractionError(
            "EXTRACTION_LIMIT",
            "Extracted content exceeds the 1,000,000-character trial limit.",
          );
      }
      text = pages.join("\n\n");
    } finally {
      await loadingTask.destroy();
    }
  } else if (extension === "docx") {
    if (prefix[0] !== 80 || prefix[1] !== 75)
      throw new DocumentExtractionError(
        "INVALID_FILE",
        "The file signature does not match DOCX.",
      );
    // Reject archive expansion before handing the bounded file to Mammoth.
    const view = new DataView(bytes);
    let entries = 0;
    let expandedBytes = 0;
    for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      entries++;
      expandedBytes += view.getUint32(offset + 24, true);
      if (entries > 256 || expandedBytes > 40 * 1024 * 1024)
        throw new DocumentExtractionError(
          "EXTRACTION_LIMIT",
          "The DOCX archive exceeds safe local extraction limits.",
        );
      const length = view.getUint16(offset + 28, true);
      const entryName = new TextDecoder().decode(
        bytes.slice(offset + 46, offset + 46 + length),
      );
      if (/vbaProject|embeddings\//i.test(entryName))
        throw new DocumentExtractionError(
          "INVALID_FILE",
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
      throw new DocumentExtractionError(
        "INVALID_FILE",
        "The file does not appear to be plain text.",
      );
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (text.length > 1_000_000)
    throw new DocumentExtractionError(
      "EXTRACTION_LIMIT",
      "Extracted content exceeds the 1,000,000-character trial limit.",
    );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  let status: DocumentRecord["status"] = text.trim()
    ? "ready"
    : "needs_processing";
  if (extractionCoverage) {
    const readable = extractionCoverage.pages.some(
      (page) => page.status === "readable",
    );
    status = readable
      ? extractionCoverage.complete
        ? "ready"
        : "partial"
      : extractionCoverage.pages.some((page) => page.status === "needs_ocr")
        ? "needs_ocr"
        : extractionCoverage.pages.some(
              (page) => page.status === "extraction_failed",
            )
          ? "error"
          : "needs_processing";
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text,
    status,
    ...(extractionCoverage ? { extractionCoverage } : {}),
    classification,
    hash,
  };
}
