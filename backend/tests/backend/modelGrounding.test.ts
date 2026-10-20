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
