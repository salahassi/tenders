import { z } from "zod";

export const documentCoverageSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("pdf_pages"),
    complete: z.boolean(),
    pages: z
      .array(
        z
          .object({
            page: z.number().int().min(1).max(200),
            status: z.enum([
              "readable",
              "blank",
              "needs_ocr",
              "extraction_failed",
            ]),
            characters: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (
      coverage.pages.some(
        (page, index) =>
          page.page !== index + 1 ||
          (page.status === "readable") !== page.characters > 0,
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Page coverage must be ordered, contiguous and match readable text.",
      });
    if (
      coverage.complete !==
      coverage.pages.every(
        (page) => page.status === "readable" || page.status === "blank",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Extraction completeness must match page coverage.",
      });
  });
export type DocumentCoverage = z.infer<typeof documentCoverageSchema>;

/** Coverage describes extracted text, never model/provider availability. */
export function coverageStatus(coverage: DocumentCoverage) {
  return coverage.pages.some((page) => page.status === "readable")
    ? coverage.complete
      ? "ready"
      : "partial"
    : coverage.pages.some((page) => page.status === "needs_ocr")
      ? "needs_ocr"
      : coverage.pages.some((page) => page.status === "extraction_failed")
        ? "error"
        : "needs_processing";
}

export function validateDocumentCoverage(
  coverage: DocumentCoverage,
  text: string,
  status: string,
  actualPages: number,
) {
  if (
    coverage.pages.length !== actualPages ||
    status !== coverageStatus(coverage)
  )
    return false;
  const matches = [...text.matchAll(/^\[Page (\d+)\]\n/gm)];
  if (matches.length !== actualPages || matches[0]?.index !== 0) return false;
  return coverage.pages.every((page, index) => {
    const marker = matches[index];
    const pageText = text
      .slice(
        marker.index! + marker[0].length,
        matches[index + 1]?.index ?? text.length,
      )
      .trim();
    return (
      Number(marker[1]) === page.page &&
      Array.from(pageText).length === page.characters
    );
  });
}
