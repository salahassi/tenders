// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it, vi, afterEach } from "vitest";
const temporary = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdtemp: temporary,
}));
import { readUploadedPdfPage } from "../../scripts/backend/uploaded-document-ocr-worker.ts";
afterEach(() => vi.clearAllMocks());
const original = Buffer.from("%PDF-synthetic capacity boundary");
const request = {
  original_hash: createHash("sha256").update(original).digest("hex"),
  total_pages: 1,
  page: 1,
  language: "en" as const,
};
it.each(["ENOSPC", "EDQUOT"])(
  "classifies unavailable temporary capacity as %s technical failure, preserving valid source classification",
  async (code) => {
    temporary.mockRejectedValue(
      Object.assign(new Error("Synthetic temporary capacity failure"), {
        code,
      }),
    );
    await expect(readUploadedPdfPage(original, request)).rejects.toThrow(
      "DOCUMENT_OCR_CAPACITY",
    );
    expect(temporary).toHaveBeenCalledTimes(1);
  },
);
it("rejects changed source bytes before requesting temporary capacity", async () => {
  temporary.mockRejectedValue(
    Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" }),
  );
  await expect(
    readUploadedPdfPage(original, {
      ...request,
      original_hash: "b".repeat(64),
    }),
  ).rejects.toThrow("DOCUMENT_OCR_SOURCE_CHANGED");
  expect(temporary).not.toHaveBeenCalled();
});
