import { extractDocumentOnWorker } from "./documentExtraction";
import { DocumentExtractionError } from "./documentExtractionError";
self.onmessage = async (event: MessageEvent) => {
  try {
    self.postMessage({
      kind: "document-result",
      document: await extractDocumentOnWorker(
        event.data.file,
        event.data.classification,
      ),
    });
  } catch (error) {
    self.postMessage({
      kind: "document-result",
      error: error instanceof Error ? error.message : "File extraction failed.",
      code:
        error instanceof DocumentExtractionError
          ? error.code
          : "EXTRACTION_FAILED",
    });
  }
};
