import { extractDocumentOnWorker } from "./documentExtraction";
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
    });
  }
};
