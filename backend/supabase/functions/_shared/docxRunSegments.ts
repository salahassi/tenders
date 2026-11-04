/** Native Word text-run segmentation, without a paragraph-sized split array.
 * Keep punctuation/spacing attached to the same ASCII token exactly as the
 * historical renderer. Other scripts and unmatched separators form gap runs.
 * No XML/archive data participates in this calculation. */
export function* docxRunSegments(text: string): Generator<string> {
  let end = 0;
  for (const match of text.matchAll(
    /[A-Za-z0-9](?:[A-Za-z0-9 .,:%_/@()+\-]*[A-Za-z0-9%])?/g,
  )) {
    const start = match.index;
    if (start > end) yield text.slice(end, start);
    yield match[0];
    end = start + match[0].length;
  }
  if (end < text.length) yield text.slice(end);
}

// Includes native font/bold/bidi/size/highlight properties, XML tags and two
// optional direction marks. Escaped source text is budgeted separately. This
// allowance is multiplied only by runs required by the trusted render model.
export const NATIVE_DOCX_RUN_OVERHEAD = 512;
