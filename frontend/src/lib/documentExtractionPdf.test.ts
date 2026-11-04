// @vitest-environment node
import { File as NodeFile } from "node:buffer";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { extractDocumentOnWorker } from "./documentExtraction";
// Use the real pinned PDF.js parser/worker against a synthetic three-page PDF:
// page 1 is text, page 2 empty, page 3 an embedded image without a text layer.
// The pinned legacy distribution supplies the Node compatibility polyfills;
// extraction uses the same PDF.js parser rather than a simulated document.
vi.mock(
  "pdfjs-dist",
  async () =>
    import(
      /* @vite-ignore */ new URL(
        "../../node_modules/pdfjs-dist/legacy/build/pdf.mjs",
        import.meta.url,
      ).href
    ),
);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: new URL(
    "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href,
}));
afterEach(() => vi.unstubAllGlobals());
it("reads real PDF text and distinguishes blank from image-only pages", async () => {
  vi.stubGlobal("self", { location: { href: import.meta.url } });
  const bytes = await readFile(
    new URL("../test/fixtures/synthetic-mixed-pages.pdf", import.meta.url),
  );
  const file = new NodeFile(
    [bytes],
    "synthetic-mixed-pages.pdf",
  ) as unknown as File;
  const extracted = await extractDocumentOnWorker(file);
  expect(extracted.status).toBe("partial");
  expect(extracted.text).toContain(
    "Synthetic buyer requires a handover guide.",
  );
  expect(extracted.extractionCoverage).toMatchObject({
    complete: false,
    pages: [
      { page: 1, status: "readable" },
      { page: 2, status: "blank", characters: 0 },
      { page: 3, status: "needs_ocr", characters: 0 },
    ],
  });
});
