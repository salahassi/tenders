import type { Evidence } from "./model.ts";

type LocatedEvidence = Evidence & { locator?: unknown };
const digits = "[0-9٠-٩۰-۹]+";
const reference = new RegExp(
  `(?<![\\p{L}\\p{N}_-])` +
    `(paragraphs?|tables?|و?(?:الفقرات|الفقرة|فقرات|فقرة|الجداول|الجدول|جداول|جدول))\\s+` +
    `(${digits})(?:\\s*(?:[-–—]|to|إلى|الى)\\s*(${digits}))?` +
    `(?![\\p{L}\\p{N}_/-]|[.:,٫٬][0-9٠-٩۰-۹]|\\s*[-–—]\\s*[0-9٠-٩۰-۹])`,
  "giu",
);
const integer = (value: string) =>
  Number(
    value
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)),
  );

/** Structural labels locate evidence; they do not establish quantities. Use
 * only canonical extraction markers present in the cited source's supplied
 * segment and frozen locator. Never derive an allowance from generated text. */
export function withoutStructuralReferences(
  text: string,
  citedSourceIds: string[],
  evidence: LocatedEvidence[],
) {
  const exactMarkers = new Set<string>();
  const sources = evidence
    .filter(
      (source) => source.kind === "rfp" && citedSourceIds.includes(source.id),
    )
    .flatMap((source) => {
      const locator = source.locator;
      if (!locator || typeof locator !== "object") return [];
      const fields = locator as Record<string, unknown>;
      if (
        fields.kind !== "extracted_character_range" ||
        !Array.isArray(fields.structural_markers)
      )
        return [];
      const paragraphs = new Set<number>(),
        tables = new Set<number>();
      for (const marker of fields.structural_markers) {
        if (typeof marker !== "string" || !source.text.includes(`[${marker}]`))
          continue;
        const parsed =
          /^(?:Table ([1-9][0-9]*), row [1-9][0-9]*, cell [1-9][0-9]*; )?Paragraph ([1-9][0-9]*)$/.exec(
            marker,
          );
        if (!parsed) continue;
        exactMarkers.add(marker);
        if (parsed[1]) tables.add(Number(parsed[1]));
        paragraphs.add(Number(parsed[2]));
      }
      return [{ paragraphs, tables }];
    });
  // Quoted extraction markers must not turn their row/cell coordinates into
  // evidence for a factual quantity elsewhere in the same claim.
  return text
    .replace(/\[([^\]\r\n]+)\]/g, (match, marker: string) =>
      exactMarkers.has(marker) ? "" : match,
    )
    .replace(
      reference,
      (match, label: string, first: string, last?: string) => {
        const start = integer(first),
          end = last ? integer(last) : start;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 1 ||
          end < start
        )
          return match;
        const kind = /paragraph|فقر/iu.test(label) ? "paragraphs" : "tables";
        const supported = sources.some((source) => {
          const markers = source[kind];
          // Endpoints alone do not prove a continuous range, nor may separate
          // source blocks be combined to manufacture one.
          if (end - start + 1 > markers.size) return false;
          for (let value = start; value <= end; value++)
            if (!markers.has(value)) return false;
          return true;
        });
        return supported ? "" : match;
      },
    );
}
