import { extractDocumentOnWorker } from "./documentExtraction";
self.onmessage = async (event: MessageEvent) => {
  try {
    self.postMessage({
      document: await extractDocumentOnWorker(
        event.data.file,
        event.data.classification,
      ),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "File extraction failed.",
    });
  }
};
