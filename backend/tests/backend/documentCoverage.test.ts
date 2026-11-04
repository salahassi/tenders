// @vitest-environment node
import { expect, it } from "vitest";
import {
  documentCoverageSchema,
  validateDocumentCoverage,
} from "../../supabase/functions/_shared/documentCoverage";
import { completeUploadSchema } from "../../supabase/functions/_shared/contracts";
const text = "[Page 1]\nيجب التسليم.\n\n[Page 2]\n";
const coverage = {
  version: 1 as const,
  kind: "pdf_pages" as const,
  complete: false,
  pages: [
    {
      page: 1,
      status: "readable" as const,
      characters: Array.from("يجب التسليم.").length,
    },
    { page: 2, status: "needs_ocr" as const, characters: 0 },
  ],
};
it("accepts exact mixed-page coverage while rejecting false completion and source mismatch", () => {
  expect(documentCoverageSchema.parse(coverage)).toEqual(coverage);
  expect(validateDocumentCoverage(coverage, text, "partial", 2)).toBe(true);
  expect(validateDocumentCoverage(coverage, text, "ready", 2)).toBe(false);
  expect(validateDocumentCoverage(coverage, text, "partial", 3)).toBe(false);
  expect(
    validateDocumentCoverage(
      coverage,
      text.replace("يجب", "لا يجب"),
      "partial",
      2,
    ),
  ).toBe(false);
  expect(
    documentCoverageSchema.safeParse({ ...coverage, complete: true }).success,
  ).toBe(false);
});
it("rejects missing, duplicate, out of order and invented readable page metadata", () => {
  for (const pages of [
    [coverage.pages[1], coverage.pages[0]],
    [coverage.pages[0], coverage.pages[0]],
    [{ ...coverage.pages[0], characters: 0 }, coverage.pages[1]],
  ])
    expect(
      documentCoverageSchema.safeParse({ ...coverage, pages }).success,
    ).toBe(false);
  expect(
    completeUploadSchema.safeParse({ from_parts: true, status: "partial" })
      .success,
  ).toBe(false);
  expect(
    completeUploadSchema.safeParse({
      from_parts: true,
      status: "partial",
      extraction_coverage: coverage,
    }).success,
  ).toBe(true);
});
