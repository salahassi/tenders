// @vitest-environment node
import { expect, it } from "vitest";
import {
  ModelError,
  validateModelResult,
  type ModelTask,
  type Evidence,
} from "../../supabase/functions/_shared/model";
import {
  candidateContent,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";
import { modelSchemas } from "../../supabase/functions/_shared/modelSchemas";
import { typedVerificationFixtures } from "./typedVerificationFixtures";
const evidence: Evidence[] = [
  {
    id: "source",
    kind: "rfp",
    verified: false,
    text: "The buyer requests an optional workshop. Supply 12 reports.",
  },
  {
    id: "review",
    kind: "review",
    verified: false,
    text: "Clarify delivery assumptions.",
  },
  {
    id: "page",
    kind: "notice",
    verified: false,
    text: "Public tender listing. Operations workshop notice on the public listing.",
  },
  { id: "L1", kind: "notice", verified: false, text: "Operations workshop" },
];
function fail(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw Error("Expected failed validation");
}
const clone = (task: ModelTask) =>
  structuredClone(typedVerificationFixtures[task].candidate);
const paths = (error: ModelError) =>
  error.validationDiagnostics.flatMap((d) => d.paths);
it.each(Object.keys(modelSchemas) as ModelTask[])(
  "keeps valid typed %s candidate unchanged",
  (task) => {
    const candidate = clone(task),
      before = JSON.stringify(candidate),
      ids =
        task === "analyze_chunk" || task === "repair_result"
          ? ["source"]
          : task === "summarize_review"
            ? ["review"]
            : [];
    expect(validateModelResult(task, candidate, evidence, ids)).toEqual(
      candidate,
    );
    expect(JSON.stringify(candidate)).toBe(before);
  },
);
it("collects source-page quote, link and independent notice-field defects with exact paths", () => {
  const value = clone("inspect_source_page");
  value.reason_quote = "Invented reason";
  value.notices[0].title = "Invented title";
  value.notices[0].buyer = "Invented buyer";
  value.notices[0].link_id = "L9";
  value.follow_link_id = "L8";
  const error = fail(() =>
    validateModelResult("inspect_source_page", value, evidence),
  );
  expect(paths(error)).toEqual([
    "$.follow_link_id",
    "$.notices[0].buyer",
    "$.notices[0].link_id",
    "$.notices[0].title",
    "$.reason_quote",
  ]);
  expect(error.omittedValidationDiagnosticCount).toBe(0);
  value.reason_quote = "Public tender listing";
  value.notices[0].title = "Operations workshop";
  value.notices[0].buyer = null;
  value.notices[0].link_id = "L1";
  value.follow_link_id = null;
  expect(() =>
    validateModelResult("inspect_source_page", value, evidence),
  ).not.toThrow();
});
it("collects all independently unrated-evidence failures instead of first factor", () => {
  const value = clone("classify_opportunity");
  for (const factor of Object.values(value.factors) as any[]) factor.rating = 1;
  const error = fail(() =>
    validateModelResult("classify_opportunity", value, evidence),
  );
  expect(error.validationDiagnostics).toHaveLength(4);
  expect(paths(error)).toContain("$.factors.scope.company_evidence");
});
it("retains missing draft ownership together with invalid citations", () => {
  const value = clone("draft_section");
  value.evidence_refs = [{ id: "missing", quote: "Private unrelated words" }];
  const error = fail(() =>
    validateModelResult("draft_section", value, evidence, ["R1"]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason)).toEqual([
    "source_missing",
    "required_content_missing",
  ]);
  expect(paths(error)).toContain("$.requirement_ids");
});
it("collects proposal processed IDs, ownership and each forbidden template override", () => {
  const value = clone("plan_proposal");
  value.sections[0].key = "fixed-scope";
  value.sections.push({ ...value.sections[0], key: "fixed-terms" });
  const error = fail(() =>
    validateModelResult("plan_proposal", value, evidence, ["R1"]),
  );
  expect(error.code).toBe("TEMPLATE_BLOCK_OVERRIDE");
  expect(error.validationDiagnostics).toHaveLength(4);
  expect(paths(error)).toContain("$.sections[1].key");
});
it("retains every attempted model approval even alongside bad source references", () => {
  const value = clone("review_proposal");
  value.processed_requirement_ids = ["R1", "R2"];
  value.responses = ["R1", "R2"].map((requirement_id) => ({
    requirement_id,
    status: "not_applicable_approved",
    section_ids: [],
    evidence_refs: [{ id: "missing", quote: "Private sentence" }],
    rationale: "No proof",
  }));
  const error = fail(() =>
    validateModelResult("review_proposal", value, evidence, ["R1", "R2"]),
  );
  expect(error.code).toBe("MODEL_CANNOT_APPROVE");
  expect(error.validationDiagnostics).toHaveLength(4);
  expect(paths(error)).toContain("$.responses[1].status");
});
function grounding() {
  const candidate = { body: "Supply 19 reports. Buyer approval is required." };
  const report = clone("verify_grounding");
  report.processed_content_ids = candidateContent(candidate).map((x) => x.id);
  report.claims = [
    {
      id: "C1",
      claim: "Supply reports.",
      candidate_quote: "Supply 19 reports.",
      kind: "tender_fact",
      status: "supported",
      source_refs: [{ id: "source", quote: "Supply 12 reports." }],
      finding: "Checked",
    },
    {
      id: "C2",
      claim: "Invented",
      candidate_quote: "Not in candidate.",
      kind: "assumption",
      status: "supported",
      source_refs: [],
      finding: "Checked",
    },
  ];
  report.processed_requirement_ids = ["R1"];
  report.requirement_checks = [
    {
      requirement_id: "R1",
      status: "supported",
      candidate_quote: "Missing clause.",
      source_refs: [{ id: "source", quote: "Supply 12 reports." }],
      finding: "Checked",
    },
  ];
  report.findings = [
    {
      severity: "blocking",
      code: "INVALID_CLAIM",
      detail: "A precise test finding.",
      claim_ids: ["unknown"],
      requirement_ids: [],
    },
  ];
  return { candidate, report };
}
it("collects independent candidate quote, numeric, requirement quote and finding errors in one report", () => {
  const { candidate, report } = grounding();
  const error = fail(() =>
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason).sort()).toEqual(
    [
      "numeric_evidence_mismatch",
      "candidate_quote_mismatch",
      "requirement_quote_mismatch",
      "invalid_finding_reference",
    ].sort(),
  );
  report.claims[0].status = "insufficient";
  report.claims[1].candidate_quote = "Buyer approval is required.";
  report.requirement_checks[0].candidate_quote = "Buyer approval is required.";
  report.findings = [];
  expect(() =>
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]),
  ).not.toThrow();
});
it("does not invent downstream quote/numeric defects for a report bound to a different candidate", () => {
  const { candidate, report } = grounding();
  report.checked_candidate_hash = "b".repeat(64);
  const error = fail(() =>
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason).sort()).toEqual(
    ["candidate_hash_mismatch", "invalid_finding_reference"].sort(),
  );
});
it("does not derive numeric mismatches from an invalid citation but collects another independent claim", () => {
  const { candidate, report } = grounding();
  report.claims[0].source_refs[0].quote = "Invented source number 11";
  report.findings = [];
  report.requirement_checks[0].candidate_quote = "Buyer approval is required.";
  const error = fail(() =>
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason).sort()).toEqual(
    ["source_quote_mismatch", "candidate_quote_mismatch"].sort(),
  );
});
it.each([31, 32, 33, 60])(
  "retains exact overflow for %i independent candidate-quote failures and no source text",
  (count) => {
    const { candidate, report } = grounding();
    report.claims = Array.from({ length: count }, (_, i) => ({
      ...report.claims[1],
      id: `C${i}`,
    }));
    report.findings = [];
    report.requirement_checks[0].candidate_quote =
      "Buyer approval is required.";
    const error = fail(() =>
      validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
        "R1",
      ]),
    );
    expect(error.validationDiagnostics).toHaveLength(Math.min(32, count));
    expect(error.omittedValidationDiagnosticCount).toBe(
      Math.max(0, count - 32),
    );
    expect(JSON.stringify(error.validationDiagnostics)).not.toContain(
      "Not in candidate",
    );
  },
);

it("keeps review directive citations and independent question scope errors together", () => {
  const value = clone("summarize_review");
  value.directives.push(structuredClone(value.directives[0]));
  value.directives.forEach(
    (d: any) => (d.source_refs[0].quote = "An invented directive."),
  );
  value.questions[0].requirement_ids = ["unexpected"];
  const error = fail(() =>
    validateModelResult("summarize_review", value, evidence, ["review"]),
  );
  expect(error.validationDiagnostics).toHaveLength(3);
  expect(paths(error)).toContain("$.questions[0].requirement_ids");
});
it("counts independent overflows from reference and candidate traversals exactly", () => {
  const { candidate, report } = grounding();
  report.claims = Array.from({ length: 34 }, (_, i) => ({
    ...report.claims[1],
    id: `C${i}`,
    source_refs: [
      { id: "missing", quote: "Not available in supplied sources." },
    ],
  }));
  report.findings = [];
  report.requirement_checks[0].candidate_quote = "Buyer approval is required.";
  const error = fail(() =>
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]),
  );
  expect(error.validationDiagnostics).toHaveLength(32);
  expect(error.omittedValidationDiagnosticCount).toBe(36);
});
it("collects each uncovered declared company claim instead of first declaration", () => {
  const { candidate, report } = grounding();
  const expanded = {
    ...candidate,
    company_claims: [
      { claim: "Synthetic declared capability A." },
      { claim: "Synthetic declared capability B." },
    ],
  };
  report.processed_content_ids = candidateContent(expanded).map((u) => u.id);
  report.claims = [
    { ...report.claims[1], candidate_quote: "Buyer approval is required." },
  ];
  report.findings = [];
  report.requirement_checks[0].candidate_quote = "Buyer approval is required.";
  const error = fail(() =>
    validateGroundingReport(report, expanded, "a".repeat(64), evidence, ["R1"]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason)).toEqual([
    "declared_claim_uncovered",
    "declared_claim_uncovered",
  ]);
});
it("keeps malformed typed verifier schemas as prerequisites rather than inventing missing data", () => {
  const { candidate, report } = grounding();
  report.claims = null;
  try {
    validateGroundingReport(report, candidate, "a".repeat(64), evidence, [
      "R1",
    ]);
    throw Error("Expected schema failure");
  } catch (error) {
    expect(error).not.toBeInstanceOf(ModelError);
    expect((error as Error).name).toBe("ZodError");
  }
});

it("distinguishes duplicate claim identities from two independent requirement coverage failures", () => {
  const value = clone("verify_grounding");
  value.claims.push({ ...value.claims[0] });
  const error = fail(() =>
    validateModelResult("verify_grounding", value, evidence, ["R1"]),
  );
  expect(error.validationDiagnostics.map((d) => d.reason).sort()).toEqual(
    [
      "duplicate_claim_ids",
      "required_ids_mismatch",
      "required_ids_mismatch",
    ].sort(),
  );
  expect(paths(error)).toEqual([
    "$.claims",
    "$.processed_requirement_ids",
    "$.requirement_checks",
  ]);
});
