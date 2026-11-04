// @vitest-environment node
import { File as NodeFile } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractDocumentOnWorker } from "./documentExtraction";
const fixture = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({
  getDocument: fixture.getDocument,
  GlobalWorkerOptions: {},
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf.worker.mjs",
}));
function file(content = "%PDF-synthetic", name = "synthetic.pdf") {
  return new NodeFile([content], name) as unknown as File;
}
function pdf(
  pages: {
    text?: string;
    operators?: readonly number[];
    failed?: boolean;
    operatorFailed?: boolean;
  }[],
) {
  const destroy = vi.fn();
  fixture.getDocument.mockReturnValue({
    destroy,
    promise: Promise.resolve({
      numPages: pages.length,
      async getPage(number: number) {
        const page = pages[number - 1];
        if (page.failed) throw new Error("Synthetic page extraction failure");
        return {
          getTextContent: async () => ({
            items: page.text ? [{ str: page.text, hasEOL: false }] : [],
          }),
          getOperatorList: async () => {
            if (page.operatorFailed) throw new Error("operator read failed");
            return { fnArray: page.operators || [] };
          },
          cleanup: vi.fn(),
        };
      },
    }),
  });
  return destroy;
}
beforeEach(() =>
  vi.stubGlobal("self", { location: { href: "https://example.test/worker" } }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("preserves readable pages around a confirmed blank separator", async () => {
  const destroy = pdf([
    { text: "The buyer requires handover." },
    {},
    { text: "يجب تسليم دليل التشغيل." },
  ]);
  const document = await extractDocumentOnWorker(file());
  expect(document.status).toBe("ready");
  expect(document.text).toBe(
    "[Page 1]\nThe buyer requires handover.\n\n[Page 2]\n\n\n[Page 3]\nيجب تسليم دليل التشغيل.",
  );
  expect(document.extractionCoverage).toMatchObject({
    complete: true,
    pages: [
      { page: 1, status: "readable" },
      { page: 2, status: "blank", characters: 0 },
      { page: 3, status: "readable" },
    ],
  });
  expect(destroy).toHaveBeenCalledOnce();
});
it("retains source text while marking a scanned page as unresolved", async () => {
  pdf([{ text: "Payment is due after acceptance." }, { operators: [85] }]);
  const document = await extractDocumentOnWorker(file());
  expect(document.status).toBe("partial");
  expect(document.text).toContain("Payment is due after acceptance.");
  expect(document.extractionCoverage).toMatchObject({
    complete: false,
    pages: [
      { status: "readable" },
      { page: 2, status: "needs_ocr", characters: 0 },
    ],
  });
});
it("isolates a failed page and continues reading later pages", async () => {
  pdf([
    { text: "First source text." },
    { failed: true },
    { text: "Later source text must survive." },
  ]);
  const document = await extractDocumentOnWorker(file());
  expect(document.status).toBe("partial");
  expect(document.text).toContain("Later source text must survive.");
  expect(document.extractionCoverage?.pages[1]).toEqual({
    page: 2,
    status: "extraction_failed",
    characters: 0,
  });
});
it("does not infer a blank page when its drawing operators cannot be read", async () => {
  pdf([{ text: "Known scope." }, { operatorFailed: true }]);
  const document = await extractDocumentOnWorker(file());
  expect(document.status).toBe("partial");
  expect(document.extractionCoverage?.pages[1].status).toBe("needs_ocr");
});
it.each([
  [[{ operators: [85] }], "needs_ocr", "needs_ocr"],
  [[{}], "needs_processing", "blank"],
  [[{ failed: true }], "error", "extraction_failed"],
] as const)(
  "keeps textless input state honest: %s",
  async (pages, expectedStatus, pageStatus) => {
    pdf([...pages]);
    const document = await extractDocumentOnWorker(file());
    expect(document.status).toBe(expectedStatus);
    expect(document.extractionCoverage?.pages[0]).toMatchObject({
      status: pageStatus,
      characters: 0,
    });
  },
);
it("retains short readable text without inventing an OCR requirement", async () => {
  const document = await extractDocumentOnWorker(
    file("يجب التسليم.", "synthetic.txt"),
  );
  expect(document.status).toBe("ready");
  expect(document.extractionCoverage).toBeUndefined();
});
it("classifies whitespace-only text as no usable text, not a scan", async () => {
  expect(
    (await extractDocumentOnWorker(file("  \n", "synthetic.txt"))).status,
  ).toBe("needs_processing");
});
it("still rejects zero-byte and mismatched-signature originals", async () => {
  await expect(
    extractDocumentOnWorker(file("", "synthetic.txt")),
  ).rejects.toThrow("empty");
  await expect(extractDocumentOnWorker(file("not a PDF"))).rejects.toThrow(
    "signature",
  );
});
