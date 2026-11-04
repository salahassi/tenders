// @vitest-environment node
import { expect, it, vi } from "vitest";
import { ModelError } from "../../supabase/functions/_shared/model";
import { runModelValidationChecks } from "../../supabase/functions/_shared/modelContextDiagnostics";
import { validationDiagnostic } from "../../supabase/functions/_shared/modelValidationDiagnostics";
import { validateGenerationResult } from "../../supabase/functions/_shared/generation";
import {
  expandBlueprint,
  validateBlueprint,
  validateReviewSectionReferences,
} from "../../supabase/functions/_shared/proposalBlueprint";
import {
  expandStructure,
  validatePlanningDetails,
  validateStructure,
} from "../../supabase/functions/_shared/proposalPlanning";

function caught(check: () => unknown): ModelError {
  try {
    check();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected validation failure");
}
const paths = (error: ModelError) =>
  error.validationDiagnostics.flatMap((d) => d.paths);
const requirement = { id: "r1" };
function blueprint(): any {
  return {
    version: 2,
    processed_requirement_ids: ["r1"],
    decisions: [],
    questions: [],
    sections: [
      {
        key: "approach",
        title: "Approach",
        purpose: "Describe the approach",
        volume: "technical",
        mode: "narrative",
        units: [
          {
            key: "approach-unit",
            title: "Work",
            purpose: "Explain work",
            requirement_ids: ["r1"],
            secondary_links: [],
            decision_ids: [],
            target_words: 100,
          },
        ],
      },
    ],
  };
}
function structure(): any {
  const b = blueprint();
  return {
    version: 3,
    decisions: [],
    questions: [],
    sections: b.sections.map(({ units, ...s }: any) => ({
      ...s,
      requirement_ids: units[0].requirement_ids,
    })),
  };
}
function context(task: string): any {
  return {
    plan: {
      workflow_version: 2,
      frozen_context: {
        notice: {
          id: "notice",
          text: "Public source text.",
          kind: "notice",
          verified: false,
        },
        blocks: [],
        knowledge: [],
        reviews: [],
        rates: [],
        template: { required_sections: [] },
      },
    },
    step: { id: "step", task, input: { section: { key: "approach" } } },
    requirements: [requirement],
    steps: [],
  };
}
function input(task: string): any {
  return { task, context: {}, evidence: [], requiredIds: ["r1"], manifest: [] };
}
function draft(): any {
  return {
    key: "approach",
    title: "Approach",
    content_blocks: [{ type: "paragraph", text: "Proposed workflow." }],
    requirement_ids: ["r1"],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
}

it("collects base source-reference and independent section-key failures without changing the result", () => {
  const result = draft();
  result.key = "other";
  result.evidence_refs = [
    { id: "notice", quote: "Private fabricated quotation." },
  ];
  const before = structuredClone(result);
  const error = caught(() =>
    validateGenerationResult(
      context("draft_section"),
      input("draft_section"),
      result,
    ),
  );
  expect(error.code).toBe("EVIDENCE_REFERENCE_INVALID");
  expect(paths(error)).toEqual(["$.evidence_refs[0].quote", "$.key"]);
  expect(error.omittedValidationDiagnosticCount).toBe(0);
  expect(JSON.stringify(error.validationDiagnostics)).not.toContain(
    "Private fabricated",
  );
  expect(result).toEqual(before);
});

it("collects a base citation failure and independent blueprint ownership/template failures", () => {
  const result = blueprint();
  result.sections[0].units[0].requirement_ids = [];
  result.decisions = [
    {
      key: "decision",
      statement: "Proposed approach",
      kind: "buyer_fact",
      requirement_ids: [],
      evidence_refs: [{ id: "notice", quote: "Invented source quote" }],
    },
  ];
  const ctx = context("plan_blueprint");
  ctx.plan.frozen_context.template.required_sections = [
    { key: "mandatory", volume: "technical", applicable: true },
  ];
  const error = caught(() =>
    validateGenerationResult(ctx, input("plan_blueprint"), result),
  );
  expect(paths(error)).toEqual(
    expect.arrayContaining([
      "$.decisions[0].evidence_refs[0].quote",
      "$.sections",
    ]),
  );
  expect(
    error.validationDiagnostics.some(
      (d) =>
        d.reason === "required_content_missing" &&
        d.requirement_ids?.includes("r1"),
    ),
  ).toBe(true);
  expect(
    error.validationDiagnostics.some((d) =>
      d.content_ids?.includes("mandatory"),
    ),
  ).toBe(true);
});

it("collects source references and structure rules after alias expansion", () => {
  const result = structure();
  result.sections[0].requirement_ids = ["req_a"];
  result.sections[0].mode = "executive_summary";
  result.decisions = [
    {
      key: "decision",
      statement: "Proposed approach",
      kind: "buyer_fact",
      requirement_ids: [],
      evidence_refs: [{ id: "notice", quote: "Invented quote" }],
    },
  ];
  const error = caught(() =>
    validateGenerationResult(
      context("plan_structure"),
      input("plan_structure"),
      result,
    ),
  );
  expect(paths(error)).toEqual(
    expect.arrayContaining([
      "$.decisions[0].evidence_refs[0].quote",
      "$.sections[0].requirement_ids",
    ]),
  );
  expect(paths(error).some((path) => path.includes(".units"))).toBe(false);
});

it("enumerates unknown blueprint aliases across every typed reference field before expansion", () => {
  const result = blueprint();
  result.processed_requirement_ids = ["bad-processed"];
  result.sections[0].units[0].requirement_ids = ["bad-owner"];
  result.sections[0].units[0].secondary_links = [
    { requirement_id: "bad-secondary", reason: "Additional location" },
  ];
  result.decisions = [
    {
      key: "decision",
      statement: "Proposed approach",
      kind: "proposed_decision",
      requirement_ids: ["bad-decision"],
      evidence_refs: [],
    },
  ];
  result.questions = [
    {
      question: "Confirm scope",
      blocking_level: "finalization",
      requirement_ids: ["bad-question"],
    },
  ];
  const before = structuredClone(result),
    error = caught(() => expandBlueprint(result, [requirement]));
  expect(paths(error)).toEqual(
    expect.arrayContaining([
      "$.processed_requirement_ids[0]",
      "$.sections[0].units[0].requirement_ids[0]",
      "$.sections[0].units[0].secondary_links[0].requirement_id",
      "$.decisions[0].requirement_ids[0]",
      "$.questions[0].requirement_ids[0]",
    ]),
  );
  expect(error.validationDiagnostics).toHaveLength(5);
  expect(result).toEqual(before);
});

it("counts all 40 structure alias failures rather than silently truncating paths at 16", () => {
  const result = structure();
  result.sections[0].requirement_ids = Array.from(
    { length: 38 },
    (_, i) => `bad-${i}`,
  );
  result.decisions = [
    {
      key: "decision",
      statement: "Proposed approach",
      kind: "proposed_decision",
      requirement_ids: ["bad-decision"],
      evidence_refs: [],
    },
  ];
  result.questions = [
    {
      question: "Confirm scope",
      blocking_level: "finalization",
      requirement_ids: ["bad-question"],
    },
  ];
  const error = caught(() => expandStructure(result, [requirement]));
  expect(error.validationDiagnostics).toHaveLength(32);
  expect(error.omittedValidationDiagnosticCount).toBe(8);
  expect(new Set(paths(error)).size).toBe(32);
});

it.each(["plan_structure", "plan_blueprint"])(
  "keeps independent %s metadata visible after alias rejection without counting unknown aliases twice",
  (task) => {
    const result = task === "plan_structure" ? structure() : blueprint();
    const references = Array.from({ length: 40 }, (_, i) => `unknown-${i}`);
    result.sections[0].key = "fixed-approach";
    if (task === "plan_structure")
      result.sections[0].requirement_ids = references;
    else {
      result.processed_requirement_ids = ["req_a"];
      result.sections[0].units[0].requirement_ids = references;
    }
    const ctx = context(task);
    ctx.step.input.id_aliases_version = 1;
    const error = caught(() =>
      validateGenerationResult(ctx, input(task), result),
    );
    expect(error.code).toBe("EVIDENCE_REFERENCE_INVALID");
    expect(error.validationDiagnostics).toHaveLength(32);
    expect(error.omittedValidationDiagnosticCount).toBe(9); // 40 unknown references + one independent reserved key.
    expect(paths(error)).toContain("$.sections[0].key");
    expect(
      error.validationDiagnostics.filter(
        (d) => d.reason === "required_ids_mismatch",
      ),
    ).toHaveLength(0);
  },
);

it("counts all independent review context failures plus a separately bounded base failure", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `r${i}`),
    modelInput = input("review_proposal");
  modelInput.requiredIds = ids;
  modelInput.context.sections = [{ key: "approach" }];
  const result = {
    processed_requirement_ids: ids,
    responses: ids.map((requirement_id) => ({
      requirement_id,
      status: "partial",
      section_ids: ["absent"],
      evidence_refs: [],
      rationale: "Needs source review",
    })),
    findings: ids.map((requirement_id) => ({
      severity: "blocking",
      category: "scope",
      detail: "Needs source review",
      section_ids: ["absent"],
      requirement_ids: [requirement_id],
    })),
  };
  (result.responses[0] as any).evidence_refs = [
    { id: "notice", quote: "Invented quote" },
  ];
  const error = caught(() =>
    validateGenerationResult(context("review_proposal"), modelInput, result),
  );
  expect(error.validationDiagnostics).toHaveLength(32);
  expect(error.omittedValidationDiagnosticCount).toBe(9);
  expect(new Set(paths(error)).size).toBe(32);
  const direct = caught(() =>
    validateReviewSectionReferences(result, modelInput.context),
  );
  expect(direct.omittedValidationDiagnosticCount).toBe(8);
});

it("collects 300 commercial section/requirement/rate failures with exact omitted count", () => {
  const result = {
    lines: Array.from({ length: 100 }, () => ({
      description: "Synthetic work",
      quantity: null,
      unit: "",
      rate_id: "missing-rate",
      period_count: null,
      included_in_base: true,
      charge_group: "one_time",
      tax_category: "",
      requirement_ids: ["missing-requirement"],
      section_ids: ["missing-section"],
      deliverable: "Synthetic",
      basis: "Unconfirmed",
    })),
    tasks: [],
    questions: [],
  };
  const error = caught(() =>
    validateGenerationResult(
      context("plan_commercial"),
      input("plan_commercial"),
      result,
    ),
  );
  expect(error.validationDiagnostics).toHaveLength(32);
  expect(error.omittedValidationDiagnosticCount).toBe(268);
  expect(new Set(paths(error)).size).toBe(32);
});

it("collects independent structure ownership and blueprint template failures", () => {
  const result = structure();
  result.sections[0].mode = "compliance_matrix";
  const error = caught(() =>
    validateStructure(
      result,
      ["r1"],
      [{ key: "required-section", volume: "financial", applicable: true }],
    ),
  );
  expect(paths(error)).toEqual(
    expect.arrayContaining(["$.sections[0].requirement_ids", "$.sections"]),
  );
  expect(error.validationDiagnostics).toHaveLength(3);
});

it("projects virtual structure paths before deduplicating and counting overflow", () => {
  const result = structure();
  result.sections = Array.from({ length: 64 }, () => ({
    ...result.sections[0],
    key: "fixed-section",
    requirement_ids: [],
  }));
  const error = caught(() => validateStructure(result, [], []));
  expect(error.validationDiagnostics).toHaveLength(32);
  expect(error.omittedValidationDiagnosticCount).toBe(32);
  expect(new Set(paths(error)).size).toBe(32);
  expect(
    paths(error).every((path) => /^\$\.sections\[\d+\]\.key$/.test(path)),
  ).toBe(true);
});

it("continues independent detail metadata checks after rejecting aliases without using invalid ownership IDs", () => {
  const saved = structure(),
    result = blueprint();
  result.processed_requirement_ids = ["req_a"];
  result.sections[0].title = "Changed title";
  result.sections[0].units[0].requirement_ids = ["invalid-alias"];
  const error = caught(() =>
    validatePlanningDetails(
      result,
      { section_keys: ["approach"], requirement_ids: ["r1"] },
      saved,
      [requirement],
    ),
  );
  expect(error.code).toBe("EVIDENCE_REFERENCE_INVALID");
  expect(paths(error)).toEqual([
    "$.sections[0]",
    "$.sections[0].units[0].requirement_ids[0]",
  ]);
  expect(error.validationDiagnostics).toHaveLength(2);
});

it("keeps malformed schemas and unexpected exceptions as immediate failures", () => {
  const ctx = context("draft_section");
  Object.defineProperty(ctx.step.input, "section", {
    get: () => {
      throw new Error("Context must not be traversed");
    },
  });
  expect(() =>
    validateGenerationResult(ctx, input("draft_section"), { key: "invalid" }),
  ).toThrow(expect.objectContaining({ name: "ZodError" }));
  const next = vi.fn(),
    failure = new Error("Unexpected implementation failure");
  expect(() =>
    runModelValidationChecks([
      () => {
        throw failure;
      },
      next,
    ]),
  ).toThrow(failure);
  expect(next).not.toHaveBeenCalled();
});

it.each([
  "MODEL_OUTPUT_POLICY_BLOCKED",
  "TEMPLATE_BLOCK_OVERRIDE",
  "MODEL_CANNOT_APPROVE",
])("retains terminal %s even when typed diagnostics accompany it", (code) => {
  const next = vi.fn(),
    failure = new ModelError(code, null, [
      validationDiagnostic("EVIDENCE_REFERENCE_INVALID", "invalid_scope", {
        paths: ["$.key"],
      }),
    ]);
  expect(() =>
    runModelValidationChecks([
      () => {
        throw failure;
      },
      next,
    ]),
  ).toThrow(failure);
  expect(next).not.toHaveBeenCalled();
});

it("keeps an actual model approval attempt terminal before context accumulation", () => {
  const result = {
    processed_requirement_ids: ["r1"],
    responses: [
      {
        requirement_id: "r1",
        status: "not_applicable_approved",
        section_ids: ["absent"],
        evidence_refs: [],
        rationale: "Unpermitted approval",
      },
    ],
    findings: [],
  };
  const error = caught(() =>
    validateGenerationResult(
      context("review_proposal"),
      input("review_proposal"),
      result,
    ),
  );
  expect(error.code).toBe("MODEL_CANNOT_APPROVE");
  expect(paths(error)).toEqual(["$.responses[0].status"]);
});

it("keeps valid results and canonical ownership unchanged", () => {
  const result = draft(),
    before = structuredClone(result);
  expect(
    validateGenerationResult(
      context("draft_section"),
      input("draft_section"),
      result,
    ),
  ).toBeUndefined();
  expect(result).toEqual(before);
  const b = blueprint();
  expect([...validateBlueprint(b, ["r1"])]).toEqual([["r1", "approach-unit"]]);
  const aliased = structuredClone(b);
  aliased.processed_requirement_ids = ["req_a"];
  aliased.sections[0].units[0].requirement_ids = ["req_a"];
  expect(expandBlueprint(aliased, [requirement])).toEqual(b);
  expect(
    validatePlanningDetails(
      aliased,
      { section_keys: ["approach"], requirement_ids: ["r1"] },
      structure(),
      [requirement],
    ),
  ).toBeUndefined();
});
