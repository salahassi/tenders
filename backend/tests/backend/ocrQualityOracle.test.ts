// @vitest-environment node
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  matchesOcrPageGold,
  normalizeOcrGold,
} from "../../scripts/testing/ocrQualityOracle.ts";

it("compares the entire page while allowing presentation-only Arabic marks", () => {
  const gold = ["يجب تسليم 12 تقريرا.", "يمنع التعاقد دون موافقة."];
  expect(
    matchesOcrPageGold(
      "«يَجِب تسليم 12 تقريرا.\n.يمنع التعاقد دون موافقة»",
      gold,
    ),
  ).toBe(true);
  // The historical ordered-substring oracle accepted this added negation.
  const changed = "يجب تسليم 12 تقريرا.\nلا يمنع التعاقد دون موافقة.";
  expect(
    gold.every((line) =>
      normalizeOcrGold(changed).includes(normalizeOcrGold(line)),
    ),
  ).toBe(true);
  expect(matchesOcrPageGold(changed, gold)).toBe(false);
});

it.each([
  ["Amount 15 ريال", "Amount 1.5 ريال"],
  ["Amount 15 ريال", "Amount 1,5 ريال"],
  ["المبلغ ١٥ ريال", "المبلغ ١،٥ ريال"],
  ["المبلغ .850 ريال", "المبلغ 850 ريال"],
  ["المبلغ ,850 ريال", "المبلغ 850 ريال"],
  ["Date 2027-02-18", "Date 2027-18-02"],
  ["Reference MX-2047-B", "Reference MX2047B"],
  ["Reference ARCH.IVE-Q9", "Reference ARCHIVE-Q9"],
  ["Reference ARCH«IVE-Q9", "Reference ARCHIVE-Q9"],
  ["يجوز للمورد تغيير السعر", "لا يجوز للمورد تغيير السعر"],
  ["يجب على العميل الدفع", "يجب على المورد الدفع"],
  [
    "Second condition. First obligation.",
    "First obligation. Second condition.",
  ],
  ["Required response. Extra unreviewed obligation.", "Required response."],
])(
  "does not normalize factual or lexical differences: %s",
  (actual, expected) => {
    expect(matchesOcrPageGold(actual, [expected])).toBe(false);
  },
);

it("reproduces the frozen native failure without confusing the one diagnostic pass with general qualification", async () => {
  const matrix = JSON.parse(
    await readFile(
      new URL(
        "../../docs/evidence/uploaded-ocr-parameter-matrix-20261104.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const historical = JSON.parse(
    await readFile(
      new URL("./fixtures/uploaded-ocr-ar-failure.json", import.meta.url),
      "utf8",
    ),
  );
  const original = JSON.parse(
    await readFile(
      new URL("./fixtures/uploaded-ocr/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const baseline = matrix.cases.find(
    (record: any) =>
      record.scale === 2000 && record.lang === "ara+eng" && record.psm === 3,
  );
  expect(baseline.text).toBe(historical.text);
  expect(baseline.image_sha256).toBe(historical.image_sha256);
  expect(createHash("sha256").update(baseline.text).digest("hex")).toBe(
    historical.text_sha256,
  );
  expect(baseline.confidence).toBe(82);
  const exact = matrix.cases.filter((record: any) =>
    matchesOcrPageGold(record.text, original.recognition_oracle.ar),
  );
  expect(exact).toHaveLength(1);
  expect(exact[0]).toMatchObject({ scale: 1000, lang: "ara", psm: 6 });
});

it("keeps the diagnostic winner unqualified when frozen independent pages lose mixed identifiers", async () => {
  const fixtures = new URL("./fixtures/uploaded-ocr-holdout/", import.meta.url);
  const freeze = JSON.parse(
    await readFile(new URL("freeze.json", fixtures), "utf8"),
  );
  const goldBytes = await readFile(new URL("gold-manifest.json", fixtures));
  const digest = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  expect(digest(goldBytes)).toBe(freeze.files["gold-manifest.json"].sha256);
  const gold = JSON.parse(goldBytes.toString());
  const receipt = JSON.parse(
    await readFile(
      new URL(
        "../../docs/evidence/uploaded-ocr-independent-holdouts-20261104.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const item of gold.cases) {
    expect(digest(await readFile(new URL(item.filename, fixtures)))).toBe(
      freeze.files[item.filename].sha256,
    );
    const candidate = receipt.cases.find(
      (record: any) => record.case === item.id && record.lang === "ara",
    );
    expect(candidate).toBeDefined();
    expect(
      matchesOcrPageGold(candidate.text, [item.heading, ...item.lines]),
    ).toBe(false);
    const mixedId = item.critical_literals.find((literal: string) =>
      /[A-Z]/.test(literal),
    );
    expect(candidate.text).not.toContain(mixedId);
  }
  const original = JSON.parse(
    await readFile(
      new URL("./fixtures/uploaded-ocr/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const english = receipt.cases.filter(
    (record: any) => record.case === "english-existing-control",
  );
  expect(
    matchesOcrPageGold(
      english.find((record: any) => record.lang === "ara+eng").text,
      original.recognition_oracle.en,
    ),
  ).toBe(true);
  expect(
    matchesOcrPageGold(
      english.find((record: any) => record.lang === "ara").text,
      original.recognition_oracle.en,
    ),
  ).toBe(false);
});
