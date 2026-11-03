// @vitest-environment node
import { expect, it } from "vitest";
import {
  modelPrompt,
  validateModelResult,
  type Evidence,
} from "../../supabase/functions/_shared/model";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "../../supabase/functions/_shared/modelGrounding";

function fixture(sourceText: string, summary = sourceText) {
  const evidence: Evidence[] = [
    { id: "source-block", kind: "rfp", verified: false, text: sourceText },
  ];
  const candidate = {
    processed_block_ids: ["source-block"],
    requirements: [],
    questions: [],
    separate_volumes: false,
    summary,
  };
  const ref = { id: "source-block", quote: sourceText };
  const report = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((unit) => unit.id),
    claims: [
      {
        id: "claim-1",
        claim: summary,
        candidate_quote: summary,
        kind: "tender_fact",
        status: "supported",
        source_refs: [ref],
        finding: "Exact reference attribution.",
      },
    ],
    processed_requirement_ids: ["source-block"],
    requirement_checks: [
      {
        requirement_id: "source-block",
        status: "supported",
        candidate_quote: summary,
        source_refs: [ref],
        finding: "The source block was processed faithfully.",
      },
    ],
    findings: [],
  };
  return { candidate, report, evidence };
}
const validate = (f: ReturnType<typeof fixture>) => {
  validateModelResult(
    "analyze_chunk",
    f.candidate,
    f.evidence,
    ["source-block"],
    { draftInputVersion: 1 },
  );
  validateGroundingReport(f.report, f.candidate, "a".repeat(64), f.evidence, [
    "source-block",
  ]);
};

it.each([
  [
    "en",
    "This reference case study describes completed work for a different buyer.",
  ],
  ["ar", "تصف هذه الدراسة المرجعية عملاً منجزاً لمشترٍ آخر."],
] as const)(
  "supports faithfully processed reference material without inventing buyer requirements (%s)",
  (language, text) => {
    const f = fixture(text);
    validate(f);
    expect(groundingDefects(f.report)).toEqual([]);
    const prompt = JSON.parse(
      modelPrompt(
        "verify_grounding",
        {
          original_task: "analyze_chunk",
          original_context: { draft_input_version: 1 },
          candidate_hash: f.report.checked_candidate_hash,
          content_units: candidateContent(f.candidate),
        },
        f.evidence,
        ["source-block"],
        language,
        false,
        4,
        4,
      ),
    );
    expect(prompt.verification_coverage_contract).toEqual({
      kind: "source_block_extraction",
      required_source_ids: ["source-block"],
      allow_empty_inventory_for_reference_material: true,
    });
  },
);

it.each([
  "The buyer requires an audit log. Retention is mandatory.",
  "يطلب المشتري سجل تدقيق. الاحتفاظ بالسجل إلزامي.",
])(
  "retains missed buyer obligations as defects even with a canonical empty inventory: %s",
  (text) => {
    const f = fixture(text, "The source describes buyer scope.");
    f.report.requirement_checks[0].status = "insufficient";
    f.report.requirement_checks[0].finding =
      "The extraction omits the mandatory audit-log requirement.";
    validate(f);
    expect(groundingDefects(f.report)).toMatchObject([
      {
        requirement_id: "source-block",
        status: "insufficient",
      },
    ]);
  },
);

it("preserves both a contradicted extraction verdict and the hard numeric guard against a false supported verdict", () => {
  const f = fixture(
    "The buyer requests 3 workshops.",
    "The buyer requests 9 workshops.",
  );
  f.report.claims[0].status = "contradicted";
  f.report.claims[0].finding = "The candidate invents a different quantity.";
  f.report.requirement_checks[0].status = "contradicted";
  validate(f);
  expect(groundingDefects(f.report)).toHaveLength(2);
  f.report.claims[0].status = "supported";
  f.report.requirement_checks[0].status = "supported";
  expect(() => validate(f)).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("does not grant requirement authority to company or style sources", () => {
  for (const kind of ["company", "style"] as const) {
    const f = fixture("We delivered strategy workshops.");
    f.evidence[0].kind = kind;
    f.evidence[0].verified = true;
    const candidate = {
      ...f.candidate,
      requirements: [
        {
          text: "The buyer requires strategy workshops.",
          category: "deliverables",
          mandatory: true,
          source_refs: [{ id: "source-block", quote: f.evidence[0].text }],
          interpretation: "An invented buyer obligation.",
          acceptance_evidence: "Delivery review.",
          owner_question: "",
        },
      ],
    };
    expect(() =>
      validateModelResult(
        "analyze_chunk",
        candidate,
        f.evidence,
        ["source-block"],
        { draftInputVersion: 1 },
      ),
    ).toThrow("EVIDENCE_REFERENCE_INVALID");
  }
});

it("derives typed coverage solely from the trusted task scope and preserves all other task/revision payloads", () => {
  const f = fixture("Reference material.");
  for (const version of [undefined, 0, "1", 1]) {
    const context = {
      original_task: "analyze_chunk",
      original_context: { draft_input_version: version },
      verification_coverage_contract: {
        kind: "buyer_obligations",
        required_source_ids: ["invented"],
      },
    };
    const prompt = JSON.parse(
      modelPrompt(
        "verify_grounding",
        context,
        f.evidence,
        ["source-block"],
        "en",
        false,
        4,
      ),
    );
    expect(prompt.verification_coverage_contract).toEqual({
      kind: "source_block_extraction",
      required_source_ids: ["source-block"],
      allow_empty_inventory_for_reference_material: version === 1,
    });
    for (const revision of [1, 2, 3] as const)
      expect(
        JSON.parse(
          modelPrompt(
            "verify_grounding",
            context,
            f.evidence,
            ["source-block"],
            "en",
            false,
            revision,
          ),
        ),
      ).not.toHaveProperty("verification_coverage_contract");
  }
  for (const task of ["review_proposal", "draft_section", "plan_blueprint"])
    expect(
      JSON.parse(
        modelPrompt(
          "verify_grounding",
          { original_task: task },
          f.evidence,
          [],
          "en",
          false,
          4,
        ),
      ),
    ).not.toHaveProperty("verification_coverage_contract");
});

it("does not reclassify a previously insufficient source-block verdict", () => {
  const f = fixture(
    "This reference describes completed work for another buyer.",
  );
  f.report.requirement_checks[0].status = "insufficient";
  f.report.requirement_checks[0].finding =
    "No buyer requirements are present to fulfill.";
  validate(f);
  expect(groundingDefects(f.report)).toHaveLength(1);
  expect(f.report.requirement_checks[0].status).toBe("insufficient");
});
