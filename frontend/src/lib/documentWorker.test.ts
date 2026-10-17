import { afterEach, expect, it, vi } from "vitest";
import { extractLocalDocument } from "./documents";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("ignores PDF.js worker handshakes and waits for the actual extraction result", async () => {
  vi.stubEnv("MODE", "production");
  let worker: any;
  const terminate = vi.fn();
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    terminate = terminate;
    constructor() {
      worker = this;
    }
    postMessage() {}
  }
  vi.stubGlobal("Worker", TestWorker);
  const resolved = vi.fn();
  const pending = extractLocalDocument(new File(["%PDF-"], "synthetic.pdf"));
  void pending.then(resolved);
  worker.onmessage({
    data: {
      sourceName: "worker",
      targetName: "main",
      action: "ready",
      data: {},
    },
  });
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled();
  const document = {
    id: "synthetic",
    text: "Arabic and English extracted content",
    status: "ready",
  };
  worker.onmessage({ data: { kind: "document-result", document } });
  await expect(pending).resolves.toEqual(document);
  expect(terminate).toHaveBeenCalledTimes(1);
});
