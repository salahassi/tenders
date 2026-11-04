/** Explicit native acceptance: node --experimental-transform-types --test
 * scripts/testing/uploadedOcrQuality.integration.test.ts in the OCR image.
 * Missing Poppler/Tesseract/ara data is a failure, never a skipped success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
// This dedicated suite resolves the native module inside the built OCR image.
const { readUploadedPdfPage } = await import(new URL("../backend/uploaded-document-ocr-worker.ts", import.meta.url).href);

const fixtureRoot = new URL("../../tests/backend/fixtures/uploaded-ocr/", import.meta.url);
const manifestBytes = await readFile(new URL("manifest.json", fixtureRoot));
const manifest = JSON.parse(manifestBytes.toString());
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
// Ignore only orthographic presentation (diacritics/punctuation/whitespace),
// never digits, negation, word order, actors, dates, amounts or units.
const normalized = (value: string) => value.normalize("NFKC")
  .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u200e\u200f]/gu, "")
  .replace(/[.,،]/gu, "").replace(/\s+/gu, " ").trim();

async function fixture(name: string) {
  const bytes = await readFile(new URL(name, fixtureRoot));
  assert.equal(hash(bytes), manifest.files[name], "Frozen PDF hash changed");
  return bytes;
}

for (const language of ["en", "ar"] as const) {
  test(`actual ${language} scan preserves all frozen obligations, amounts and dates`, { timeout: 100000 }, async () => {
    const bytes = await fixture(`scanned-${language}.pdf`);
    const started = performance.now();
    const result = await readUploadedPdfPage(bytes, { original_hash: hash(bytes), total_pages: 1, page: 1, language });
    assert.equal(result.engine, "tesseract");
    assert.deepEqual(result.languages, ["ara", "eng"]);
    assert.match(result.engine_version, /^\d+\.\d+/);
    assert.equal(result.text_hash, hash(result.text));
    assert.match(result.image_hash, /^[a-f0-9]{64}$/);
    assert.ok(result.confidence >= 0 && result.confidence <= 100);
    const actual = normalized(result.text);
    let previous = -1;
    for (const obligation of manifest.recognition_oracle[language]) {
      const position = actual.indexOf(normalized(obligation));
      assert.ok(position > previous, `Missing/reordered/changed obligation: ${obligation}\nRecognized: ${result.text}`);
      previous = position;
    }
    console.log(JSON.stringify({ native_ocr: language, fixture_sha256: hash(bytes), manifest_sha256: hash(manifestBytes),
      engine_version: result.engine_version, text_sha256: result.text_hash, elapsed_ms: Math.round(performance.now() - started),
      confidence: result.confidence, numeric_uncertainty: result.numeric_uncertainty, oracle: "all_exact_obligations" }));
  });
}

test("mixed PDF selects the exact scan page and leaves a blank page empty", { timeout: 190000 }, async () => {
  const bytes = await fixture("mixed-five-pages.pdf");
  const request = { original_hash: hash(bytes), total_pages: 5, page: 3, language: "auto" as const };
  const scan = await readUploadedPdfPage(bytes, request);
  for (const line of manifest.recognition_oracle.en) assert.ok(normalized(scan.text).includes(normalized(line)));
  assert.equal(scan.page, 3);
  assert.ok(!scan.text.includes("Native page"));
  const blank = await readUploadedPdfPage(bytes, { ...request, page: 5 });
  assert.equal(blank.page, 5);
  assert.equal(blank.text, "");
  assert.equal(blank.confidence, 0);
  assert.equal(blank.text_hash, hash(""));
  assert.notEqual(blank.image_hash, scan.image_hash);
});

test("changed original bytes and wrong page count are rejected by the native path", { timeout: 100000 }, async () => {
  const bytes = await fixture("scanned-en.pdf");
  await assert.rejects(readUploadedPdfPage(bytes, { original_hash: "0".repeat(64), total_pages: 1, page: 1, language: "en" }), /DOCUMENT_OCR_SOURCE_CHANGED/);
  await assert.rejects(readUploadedPdfPage(bytes, { original_hash: hash(bytes), total_pages: 2, page: 1, language: "en" }), /DOCUMENT_OCR_SOURCE_CHANGED/);
});
