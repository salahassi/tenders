// @vitest-environment node
import { expect, it } from "vitest";
import {
  ModelError,
  validateModelResult,
  type Evidence,
} from "../../supabase/functions/_shared/model";
const evidence: Evidence[] = [
  {
    id: "source",
    kind: "rfp",
    verified: false,
    text: "Delivery requires buyer approval. Maintain an audit log.",
  },
];
function candidate(count = 2) {
  return {
    processed_block_ids: ["source"],
    requirements: Array.from({ length: count }, () => ({
      text: "Maintain an audit log.",
      category: "scope",
      mandatory: true,
      source_refs: [
        { id: "source", quote: "Incorrect first quotation." },
        { id: "source", quote: "Incorrect second quotation." },
      ],
      interpretation: "Known buyer requirement.",
      acceptance_evidence: "Audit log.",
      owner_question: null,
    })),
    questions: [],
    separate_volumes: false,
    summary: "Buyer requirements.",
  };
}
function failure(value: unknown) {
  try {
    validateModelResult("analyze_chunk", value, evidence, ["source"]);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw Error("Expected reference rejection");
}
it("reports four quote defects across separate requirements before a repair, then retains the unfixed fourth", () => {
  const value = candidate();
  const error = failure(value);
  expect(error.validationDiagnostics.map((d) => d.paths[0])).toEqual([
    "$.requirements[0].source_refs[0].quote",
    "$.requirements[0].source_refs[1].quote",
    "$.requirements[1].source_refs[0].quote",
    "$.requirements[1].source_refs[1].quote",
  ]);
  for (const [i, j] of [
    [0, 0],
    [0, 1],
    [1, 0],
  ])
    value.requirements[i].source_refs[j].quote = "Maintain an audit log.";
  expect(failure(value).validationDiagnostics).toMatchObject([
    {
      paths: ["$.requirements[1].source_refs[1].quote"],
      reason: "source_quote_mismatch",
    },
  ]);
  value.requirements[1].source_refs[1].quote = "Maintain an audit log.";
  expect(() =>
    validateModelResult("analyze_chunk", value, evidence, ["source"]),
  ).not.toThrow();
});
it("does not let a coverage defect hide independent quote failures", () => {
  const value = candidate();
  value.processed_block_ids = [];
  const error = failure(value);
  expect(error.validationDiagnostics).toHaveLength(5);
  expect(error.validationDiagnostics.map((d) => d.reason)).toContain(
    "required_ids_mismatch",
  );
});
it("bounds emitted diagnostics and preserves overflow until remaining references are repaired", () => {
  const value = candidate(17);
  const error = failure(value);
  expect(error.validationDiagnostics).toHaveLength(32);
  expect((error as any).omittedValidationDiagnosticCount).toBe(2);
  for (const diagnostic of error.validationDiagnostics) {
    const [, i, j] = diagnostic.paths[0].match(
      /requirements\[(\d+)\].source_refs\[(\d+)\]/,
    )!;
    value.requirements[Number(i)].source_refs[Number(j)].quote =
      "Maintain an audit log.";
  }
  const remaining = failure(value);
  expect(remaining.validationDiagnostics).toHaveLength(2);
  expect((remaining as any).omittedValidationDiagnosticCount).toBe(0);
});
it("retains unknown-source failures without exposing source text", () => {
  const value = candidate();
  value.requirements[0].source_refs[0].id = "missing-source";
  value.requirements[0].source_refs[1] = {
    id: "source",
    quote: "Maintain an audit log.",
  };
  const error = failure(value);
  expect(error.validationDiagnostics).toHaveLength(3);
  expect(error.validationDiagnostics[0].reason).toBe("source_missing");
  expect(JSON.stringify(error.validationDiagnostics)).not.toContain(
    evidence[0].text,
  );
});

it.each([31, 32, 33])(
  "keeps exactly bounded quote diagnostics at the %s-defect boundary",
  (defects) => {
    const value = candidate(Math.ceil(defects / 2));
    if (defects % 2) value.requirements.at(-1)!.source_refs.pop();
    const error = failure(value);
    expect(error.validationDiagnostics).toHaveLength(Math.min(defects, 32));
    expect(error.omittedValidationDiagnosticCount).toBe(
      Math.max(0, defects - 32),
    );
    expect(
      error.validationDiagnostics.length +
        error.omittedValidationDiagnosticCount,
    ).toBe(defects);
  },
);

it("collects separate wrong-role and unverified-company citations in a verifier report", () => {
  const report = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: ["content-0"],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
    claims: [
      {
        id: "c1",
        claim: "Company certification.",
        candidate_quote: "Company certification.",
        kind: "company_fact",
        status: "supported",
        source_refs: [{ id: "source", quote: "Maintain an audit log." }],
        finding: "Claimed support.",
      },
      {
        id: "c2",
        claim: "Company delivery.",
        candidate_quote: "Company delivery.",
        kind: "company_fact",
        status: "supported",
        source_refs: [{ id: "company", quote: "Company delivery." }],
        finding: "Claimed support.",
      },
    ],
  };
  let error: ModelError | undefined;
  try {
    validateModelResult("verify_grounding", report, [
      ...evidence,
      {
        id: "company",
        kind: "company",
        verified: false,
        text: "Company delivery.",
      },
    ]);
  } catch (value) {
    error = value as ModelError;
  }
  expect(error?.validationDiagnostics.map((d) => d.reason)).toEqual([
    "source_kind_mismatch",
    "company_not_verified",
  ]);
});
