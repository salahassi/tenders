// @vitest-environment node
import { expect, it } from "vitest";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";

const prose = "The reference describes completed strategy work.";
const markers = [
  "Paragraph 21",
  "Table 4, row 1, cell 1; Paragraph 22",
  "Paragraph 23",
];
function source() {
  return {
    id: "synthetic-block",
    kind: "rfp" as const,
    verified: false,
    text: markers.map((marker) => `[${marker}]\n${prose}`).join("\n"),
    locator: {
      kind: "extracted_character_range",
      start: 400,
      end: 900,
      preceding_anchor: "Paragraph 20",
      structural_markers: [...markers],
    },
  };
}
function fixture(text: string, quote = prose) {
  const candidate = {
    summary: text,
    questions: [],
    requirements: [],
    separate_volumes: false,
    processed_block_ids: ["synthetic-block"],
  };
  const ref = { id: "synthetic-block", quote };
  const report = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((unit) => unit.id),
    claims: [
      {
        id: "claim-1",
        claim: text,
        candidate_quote: text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [ref],
        finding: "The cited reference describes completed work.",
      },
    ],
    processed_requirement_ids: ["synthetic-block"],
    requirement_checks: [
      {
        requirement_id: "synthetic-block",
        status: "supported",
        candidate_quote: text,
        source_refs: [ref],
        finding:
          "The supplied segment is processed without inventing requirements.",
      },
    ],
    findings: [],
  };
  return { candidate, report };
}
function validate(text: string, evidence = [source()], quote = prose) {
  const { candidate, report } = fixture(text, quote);
  validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
    "synthetic-block",
  ]);
  expect(groundingDefects(report)).toEqual([]);
}

it.each([
  "This segment (Paragraphs 21–23 and Table 4) describes completed strategy work.",
  "Paragraphs 21-23 describe completed strategy work.",
  "Paragraphs 21 to 23 describe completed strategy work.",
  "Paragraph 21 describes completed strategy work.",
  "الفقرات ٢١–٢٣ والجدول ٤ تصف عملاً استراتيجياً منجزاً.",
  "الفقرات ۲۱ إلى ۲۳ تصف عملاً استراتيجياً منجزاً.",
])("recognizes source-specific structural references: %s", (text) => {
  validate(text);
});

it.each([
  "Paragraph 24 describes completed work.",
  "Paragraphs 21–24 describe completed work.",
  "Paragraphs 23–21 describe completed work.",
  "Paragraphs 21–999999999999999999999999999 describe completed work.",
  "Table 5 describes completed work.",
  "Table 4.5 describes completed work.",
  "Table 4,000 describes completed work.",
  "Table 4٫٥ describes completed work.",
  "Table 4_suffix describes completed work.",
  "Paragraphs 21–23.5 describe completed work.",
  "Paragraphs 21–23–25 describe completed work.",
  "The reference requires 21 workshops.",
  "(Table 4) requires 4 employees.",
  "Table 4, 35 employees are required.",
  "الجدول ٤ يتطلب ٤ موظفين.",
  "Paragraph 20 describes completed work.",
  "Character range 400–900 describes completed work.",
])("retains unsupported references and factual quantities: %s", (text) => {
  expect(() => validate(text)).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("requires every paragraph inside the range in the same cited source", () => {
  const gap = source();
  gap.locator.structural_markers = [markers[0], markers[2]];
  const other = source();
  other.id = "other-block";
  expect(() =>
    validate("Paragraphs 21–23 describe completed work.", [gap, other]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  const { candidate, report } = fixture(
    "Paragraphs 21–23 describe completed work.",
  );
  other.locator.structural_markers = [markers[1]];
  report.claims[0].source_refs.push({ id: other.id, quote: prose });
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      [gap, other],
      ["synthetic-block"],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it.each(["Table 4/5", "Table 4:5", "Table 4-part"])(
  "does not exempt a valid table number embedded in an unsupported identifier: %s",
  (identifier) => {
    const located = source();
    const quote = "The reference describes 5 review activities.";
    located.text += `\n${quote}`;
    expect(() =>
      validate(`${identifier} describes the review.`, [located], quote),
    ).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);

it("does not use uncited sources, metadata outside the supplied segment or invented candidate locators", () => {
  const missing = source();
  missing.locator.structural_markers = [];
  const other = { ...source(), id: "other-block" };
  expect(() =>
    validate("Table 4 describes completed work.", [missing, other]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  const outside = source();
  outside.text = prose;
  expect(() =>
    validate("Table 4 describes completed work.", [outside]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  const { candidate, report } = fixture("Table 4 describes completed work.");
  Object.assign(candidate, { locator: source().locator });
  report.processed_content_ids = candidateContent(candidate).map(
    (unit) => unit.id,
  );
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      [missing],
      ["synthetic-block"],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("requires canonical extraction metadata and prevents locator digits proving a quantity", () => {
  const wrongKind = source();
  wrongKind.locator.kind = "user_description";
  expect(() =>
    validate("Table 4 describes completed work.", [wrongKind]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(() =>
    validate(
      "The reference requires 21 workshops.",
      [source()],
      `[Paragraph 21]\n${prose}`,
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it.each([
  { marker: "Table 4, row 34, cell 1; Paragraph 22", quantity: 34 },
  { marker: "Table 4, row 1, cell 34; Paragraph 22", quantity: 34 },
])(
  "does not let full extraction coordinates prove factual quantities: $marker",
  ({ marker, quantity }) => {
    const located = source();
    located.locator.structural_markers = [marker];
    located.text = `[${marker}]\n${prose}`;
    expect(() =>
      validate(
        `The reference requires ${quantity} employees.`,
        [located],
        located.text,
      ),
    ).toThrow("EVIDENCE_REFERENCE_INVALID");
    const known = `The reference requires ${quantity} employees.`;
    located.text += ` ${known}`;
    validate(known, [located], located.text);
  },
);

it("preserves exact source/candidate quotations, complete coverage and candidate hash checks", () => {
  const text = "Paragraphs 21–23 describe completed work.";
  expect(() => validate(text, [source()], "Invented reference text.")).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
  const { candidate, report } = fixture(text);
  report.claims[0].candidate_quote = "Paragraph 21 describes different work.";
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      [source()],
      ["synthetic-block"],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  report.claims[0].candidate_quote = text;
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "b".repeat(64),
      [source()],
      ["synthetic-block"],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  report.processed_content_ids = [];
  expect(() =>
    validateGroundingReport(
      report,
      candidate,
      "a".repeat(64),
      [source()],
      ["synthetic-block"],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
});
