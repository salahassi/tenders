/** Orthographic normalization for pre-authored synthetic native OCR gold.
 * Preserve lexical additions, ordering, negation, identifiers and numeric
 * punctuation. This is an exact fixture oracle, never a semantic classifier.
 */
export function normalizeOcrGold(value: string) {
  return value
    .normalize("NFKC")
    .replace(
      /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u200e\u200f]/gu,
      "",
    )
    .replace(/[.,،«»]/gu, (character, offset: number, text: string) => {
      // Preserve leading decimals and punctuation inside identifiers as well
      // as numeric separators. Only sentence/quote boundaries may be ignored.
      if (
        (/[.,،]/u.test(character) &&
          /\p{Number}/u.test(text[offset + 1] ?? "")) ||
        (/[\p{Letter}\p{Number}]/u.test(text[offset - 1] ?? "") &&
          /[\p{Letter}\p{Number}]/u.test(text[offset + 1] ?? ""))
      )
        return character;
      return "";
    })
    .replace(/\s+/gu, " ")
    .trim();
}

export function matchesOcrPageGold(
  actual: string,
  expected: readonly string[],
) {
  return normalizeOcrGold(actual) === normalizeOcrGold(expected.join("\n"));
}
