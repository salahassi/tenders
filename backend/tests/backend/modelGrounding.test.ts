// @vitest-environment node
import { it, expect } from "vitest";
import {
  candidateContent,
  validateGroundingReport,
  groundingDefects,
} from "../../supabase/functions/_shared/modelGrounding";
const candidate = {
  content_blocks: [
    { type: "paragraph", text: "The deadline is 10 March 2026." },
  ],
  company_claims: [],
};
const evidence = [
  {
    id: "notice",
    text: "The deadline is 10 March 2026.",
    kind: "notice" as const,
    verified: false,
  },
];
function report() {
  return {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((c) => c.id),
    claims: [
      {
        id: "claim-1",
        claim: candidate.content_blocks[0].text,
        candidate_quote: candidate.content_blocks[0].text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "notice", quote: evidence[0].text }],
        finding: "Exact deadline.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
}
it.each([
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: true,
  },
  {
    text: "2 Architecture design\nPackage 1",
    claim: "البند ٢ يتطلب تصميم المعمارية.",
    pass: true,
  },
  {
    text: "3\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
  {
    text: "2\nUnrelated heading\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
  {
    text: "2\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires 2 engineers.",
    pass: false,
  },
  {
    text: "2\nArchitecture design\nPackage 1\n3\nArchitecture design\nPackage 1",
    claim: "BOQ item 2 requires architecture design.",
    pass: false,
  },
])(
  "checks adjacent item labels without using them to justify quantities: $claim ($pass)",
  ({ text, claim, pass }) => {
    const c = { content_blocks: [{ type: "paragraph", text: claim }] };
    const r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim,
      candidate_quote: claim,
      source_refs: [{ id: "notice", quote: "Architecture design\nPackage 1" }],
    };
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);
it("validates a supported deadline and checks undeclared text, including tables", () => {
  expect(() =>
    validateGroundingReport(report(), candidate, "a".repeat(64), evidence, []),
  ).not.toThrow();
  expect(
    candidateContent({
      content_blocks: [
        { type: "table", rows: [["An undeclared company claim"]] },
      ],
      evidence_refs: [{ id: "notice", quote: "Evidence copy" }],
    }).map((c) => c.text),
  ).toContain("An undeclared company claim");
  expect(
    candidateContent({
      evidence_refs: [{ id: "notice", quote: "Evidence copy" }],
    }),
  ).toEqual([]);
});
it.each([
  "hash",
  "missing_text",
  "extra_text",
  "fabricated_quote",
  "wrong_source",
  "unsupported_number",
  "missing_requirement",
])("rejects %s independently of a verifier claiming support", (defect) => {
  const r = report();
  let required: string[] = [];
  if (defect === "hash") r.checked_candidate_hash = "b".repeat(64);
  if (defect === "missing_text") r.processed_content_ids.pop();
  if (defect === "extra_text") r.processed_content_ids.push("fake");
  if (defect === "fabricated_quote")
    r.claims[0].candidate_quote = "Invented quote";
  if (defect === "wrong_source")
    r.claims[0].source_refs[0].id = "invented-source";
  if (defect === "unsupported_number") {
    r.claims[0].source_refs[0].quote = "March";
  }
  if (defect === "missing_requirement") required = ["required-1"];
  expect(() =>
    validateGroundingReport(r, candidate, "a".repeat(64), evidence, required),
  ).toThrow();
});
it("requires verified Company Knowledge for supported expertise instead of a notice or a style sample", () => {
  const r = report();
  r.claims[0].kind = "company_fact";
  expect(() =>
    validateGroundingReport(r, candidate, "a".repeat(64), evidence, []),
  ).toThrow();
  expect(() =>
    validateGroundingReport(
      r,
      candidate,
      "a".repeat(64),
      [{ ...evidence[0], kind: "company", verified: false }],
      [],
    ),
  ).toThrow();
});
it("allows explicit missing information without claiming eligibility failure", () => {
  const c = {
    questions: [
      { question: "[INPUT REQUIRED: Confirm the proposed delivery team.]" },
    ],
  };
  const r = {
    ...report(),
    processed_content_ids: candidateContent(c).map((x) => x.id),
    claims: [
      {
        ...report().claims[0],
        candidate_quote: c.questions[0].question,
        claim: c.questions[0].question,
        kind: "assumption",
        source_refs: [],
        finding: "Clear missing input.",
      },
    ],
  };
  expect(() =>
    validateGroundingReport(r, c, "a".repeat(64), [], []),
  ).not.toThrow();
  expect(groundingDefects(r)).toEqual([]);
  r.claims[0].status = "contradicted";
  expect(groundingDefects(r)).toHaveLength(1);
});

it.each([
  ["company_fact", "We have 50 certified engineers."],
  ["tender_fact", "The tender closes on 10 March 2026."],
  ["commercial_commitment", "Our fixed price is 50000 USD."],
])(
  "blocks an uncited supported %s as a repairable evidence defect without trusting the verifier",
  (kind, text) => {
    const c = { content_blocks: [{ type: "paragraph", text }] };
    const r = {
      ...report(),
      processed_content_ids: candidateContent(c).map((u) => u.id),
      claims: [
        {
          ...report().claims[0],
          kind,
          claim: text,
          candidate_quote: text,
          source_refs: [],
          finding: "Verifier incorrectly says this is supported.",
        },
      ],
    };
    const original = structuredClone(r);
    // Numerical claims with no references must reach candidate repair too;
    // there is no quoted evidence against which to run the numeric check.
    expect(() =>
      validateGroundingReport(r, c, "a".repeat(64), [], []),
    ).not.toThrow();
    expect(groundingDefects(r)).toEqual([
      expect.objectContaining({
        claim_id: "claim-1",
        kind,
        status: "insufficient",
        reason: "missing_supporting_evidence",
        candidate_quote: text,
        source_refs: [],
        instruction: expect.stringContaining("Never invent"),
      }),
    ]);
    expect(r).toEqual(original);
  },
);

const tableQuote = "Architectural assessment\nDeliver a documented design.";
const tableHeader = "# Description Qty Unit price Total";
const tableText = `${tableHeader}
1
Discovery package 1
Research existing workflows.
[Page 8]
8
2 Architecture package 1
${tableQuote}
3 Delivery package 1
Train the internal team.`;
it.each([
  {
    name: "a titled row separated from its quote by quantity",
    text: tableText,
    claim: "BOQ item 2 requires architectural assessment.",
    pass: true,
  },
  {
    name: "Arabic table columns and digits",
    text: tableText
      .replace(tableHeader, "# الوصف الكمية سعر الوحدة السعر الإجمالي")
      .replace(/2/g, "٢")
      .replace(/1/g, "١")
      .replace(/3/g, "٣"),
    claim: "البند ٢ يتطلب تقييم المعمارية.",
    pass: true,
  },
  {
    name: "a wrong row label",
    text: tableText,
    claim: "BOQ item 1 requires architectural assessment.",
    pass: false,
  },
  {
    name: "row number reused as an invented quantity",
    text: tableText,
    claim: "BOQ item 2 requires 2 architects.",
    pass: false,
  },
  {
    name: "quantity column reused without a supporting quotation",
    text: tableText,
    claim: "BOQ item 2 requires 1 architect.",
    pass: false,
  },
  {
    name: "an ordinary numbered list without table columns",
    text: tableText.replace(tableHeader, "# Project plan"),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "an unmarked numeric page or ambiguous boundary",
    text: tableText.replace("[Page 8]\n8\n", "8\n"),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "nonconsecutive row numbering",
    text: tableText.replace("2 Architecture", "4 Architecture"),
    claim: "BOQ item 4 requires architectural assessment.",
    pass: false,
  },
  {
    name: "an ambiguous repeated quote",
    text: tableText + "\n" + tableQuote,
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "a quote in the final unbounded row",
    text: tableText.replace(
      "3 Delivery package 1\nTrain the internal team.",
      "",
    ),
    claim: "BOQ item 2 requires architectural assessment.",
    pass: false,
  },
  {
    name: "a quantity on its own line cannot masquerade as the row label",
    text: tableText.replace(
      "2 Architecture package 1",
      "2 Architecture package\n1",
    ),
    claim: "BOQ item 1 requires architectural assessment.",
    pass: false,
  },
])("validates table labels conservatively: $name", ({ text, claim, pass }) => {
  const c = { content_blocks: [{ type: "paragraph", text: claim }] };
  const r = report();
  r.claims[0] = {
    ...r.claims[0],
    claim,
    candidate_quote: claim,
    source_refs: [{ id: "notice", quote: tableQuote }],
  };
  const check = () =>
    validateGroundingReport(
      r,
      c,
      "a".repeat(64),
      [{ ...evidence[0], text }],
      [],
    );
  if (pass) expect(check).not.toThrow();
  else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("rejects one quotation spanning two table rows", () => {
  const quote = tableQuote + "\n3 Delivery package 1\nTrain the internal team.";
  const claim = "BOQ item 2 requires architectural assessment and training.";
  const c = { content_blocks: [{ type: "paragraph", text: claim }] },
    r = report();
  r.claims[0] = {
    ...r.claims[0],
    claim,
    candidate_quote: claim,
    source_refs: [{ id: "notice", quote }],
  };
  expect(() =>
    validateGroundingReport(
      r,
      c,
      "a".repeat(64),
      [{ ...evidence[0], text: tableText }],
      [],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it.each([
  {
    name: "the final row paragraph before an explicit page break",
    suffix: "\n\n[Page 8]\n8\nUnrelated trailing text.",
    claim: "BOQ item 2 requires architectural assessment.",
    quote: tableQuote,
    pass: true,
  },
  {
    name: "Arabic page marker",
    suffix: "\n\n[صفحة ٨]\n٨\nUnrelated trailing text.",
    claim: "البند ٢ يتطلب تقييم المعمارية.",
    quote: tableQuote,
    pass: true,
  },
  {
    name: "an unrelated paragraph before the page break",
    suffix: "\n\nUnrelated trailing text.\n\n[Page 8]\n8",
    claim: "BOQ item 2 includes unrelated trailing text.",
    quote: "Unrelated trailing text.",
    pass: false,
  },
  {
    name: "text after the page break",
    suffix: "\n\n[Page 8]\n8\nUnrelated trailing text.",
    claim: "BOQ item 2 includes unrelated trailing text.",
    quote: "Unrelated trailing text.",
    pass: false,
  },
  {
    name: "a nonconsecutive row before the page break",
    suffix: "\n4 Unrelated new row.\n\n[Page 8]\n8",
    claim: "BOQ item 2 includes unrelated new work.",
    quote: "Unrelated new row.",
    pass: false,
  },
  {
    name: "an unmarked numeric boundary before the page break",
    suffix: "\n8\nUnrelated new row.\n\n[Page 9]\n9",
    claim: "BOQ item 2 includes unrelated new work.",
    quote: "Unrelated new row.",
    pass: false,
  },
  {
    name: "a fabricated quantity",
    suffix: "\n\n[Page 8]\n8",
    claim: "BOQ item 2 requires 2 architects.",
    quote: tableQuote,
    pass: false,
  },
  {
    name: "a row without any explicit boundary",
    suffix: "",
    claim: "BOQ item 2 requires architectural assessment.",
    quote: tableQuote,
    pass: false,
  },
])(
  "bounds a final table row conservatively: $name",
  ({ suffix, claim, quote, pass }) => {
    const text =
      tableText
        .replace("3 Delivery package 1\nTrain the internal team.", "")
        .trimEnd() + suffix;
    const c = { content_blocks: [{ type: "paragraph", text: claim }] },
      r = report();
    r.claims[0] = {
      ...r.claims[0],
      claim,
      candidate_quote: claim,
      source_refs: [{ id: "notice", quote }],
    };
    const check = () =>
      validateGroundingReport(
        r,
        c,
        "a".repeat(64),
        [{ ...evidence[0], text }],
        [],
      );
    if (pass) expect(check).not.toThrow();
    else expect(check).toThrow("EVIDENCE_REFERENCE_INVALID");
  },
);
