// @vitest-environment node
import { expect, it } from "vitest";
import {
  blueprintSections,
  complianceMatrixSections,
  deduplicateQuestions,
  expandBlueprint,
  requirementAliases,
  semanticReviewInputs,
  validateBlueprint,
} from "../../supabase/functions/_shared/proposalBlueprint";
import { proposalBlueprintSchema } from "../../supabase/functions/_shared/proposalBlueprintSchema";
import {
  createSectionOutline,
  plannedDraftInputs,
} from "../../supabase/functions/_shared/proposalOutline";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import {
  verificationBatches,
  verificationPolicy,
} from "../../supabase/functions/_shared/modelVerification";

function blueprint(count = 35): any {
  return {
    version: 2,
    processed_requirement_ids: Array.from(
      { length: count },
      (_, i) => `r-${i}`,
    ),
    decisions: [
      {
        key: "audit",
        statement: "Propose a shared audit trail",
        kind: "proposed_decision",
        requirement_ids: [],
        evidence_refs: [],
      },
    ],
    questions: [],
    sections: [
      {
        key: "summary",
        title: "Executive summary",
        purpose: "Summarize the completed approach",
        volume: "technical",
        mode: "executive_summary",
        units: [
          {
            key: "summary-unit",
            title: "Executive summary",
            purpose: "Summarize",
            requirement_ids: [],
            secondary_links: [],
            decision_ids: ["audit"],
            target_words: 200,
          },
        ],
      },
      {
        key: "approach",
        title: "Approach",
        purpose: "Describe the coherent workflow",
        volume: "technical",
        mode: "narrative",
        units: [
          {
            key: "approach-unit",
            title: "Approach",
            purpose: "Workflow and audit",
            requirement_ids: Array.from({ length: count }, (_, i) => `r-${i}`),
            secondary_links: [],
            decision_ids: ["audit"],
            target_words: 900,
          },
        ],
      },
      {
        key: "compliance",
        title: "Compliance matrix",
        purpose: "Link each reviewed answer",
        volume: "technical",
        mode: "compliance_matrix",
        units: [],
      },
    ],
  };
}
function context(count = 35): any {
  const b = blueprint(count);
  return {
    plan: {
      id: "fixture",
      stage: "planning",
      workflow_version: 2,
      execution_policy: { review_output_tokens: 16384 },
      frozen_context: {
        language: "en",
        template: { id: "fixture", required_sections: [], fixed_blocks: [] },
        notice: {
          id: "notice",
          kind: "notice",
          text: "Synthetic notice",
          reference: {
            entity_kind: "notice",
            entity_id: "notice",
            content_hash: "a".repeat(64),
          },
        },
        blocks: [
          {
            id: "rfp",
            kind: "rfp",
            text: "Synthetic workflow requirements.",
            reference: {
              entity_kind: "document",
              entity_id: "doc",
              content_hash: "b".repeat(64),
            },
          },
        ],
        knowledge: [],
        reviews: [],
        rates: [],
      },
    },
    step: { task: "advance_plan", input: {} },
    requirements: b.processed_requirement_ids.map((id: string) => ({
      id,
      text: `Workflow requirement ${id}`,
      category: "functional",
      mandatory: true,
      source_refs: [{ id: "rfp", quote: "Synthetic workflow requirements." }],
    })),
    steps: [
      {
        task: "plan_proposal",
        status: "completed",
        input: { workflow_version: 2 },
        output: b,
        ordinal: 1,
      },
    ],
  };
}

it("round-trips compact requirement references without conflating IDs or carrying UUID arrays in the queued blueprint", async () => {
  const requirements = Array.from({ length: 145 }, () => ({
    id: crypto.randomUUID(),
  }));
  const aliases = requirementAliases(requirements);
  expect(requirementAliases([...requirements].reverse())).toEqual(aliases);
  expect(new Set(aliases.values()).size).toBe(145);
  expect(JSON.stringify([...aliases.values()]).length).toBeLessThan(
    JSON.stringify(requirements.map((r) => r.id)).length / 3,
  );
  const b = blueprint(1);
  b.processed_requirement_ids = [aliases.get(requirements[0].id)];
  b.sections[1].units[0].requirement_ids = b.processed_requirement_ids;
  expect(
    expandBlueprint(b, requirements).sections[1].units[0].requirement_ids,
  ).toEqual([requirements[0].id]);
  b.sections[1].units[0].requirement_ids = ["absent"];
  expect(() => expandBlueprint(b, requirements)).toThrow(
    "EVIDENCE_REFERENCE_INVALID",
  );
});

it("validates exact primary ownership, decisions and buyer-required structure", () => {
  const b = proposalBlueprintSchema.parse(blueprint());
  expect(validateBlueprint(b, b.processed_requirement_ids).size).toBe(35);
  const duplicate = structuredClone(b);
  duplicate.sections[1].units.push({
    ...duplicate.sections[1].units[0],
    key: "duplicate",
  });
  expect(() =>
    validateBlueprint(duplicate, b.processed_requirement_ids),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  const lost = structuredClone(b);
  lost.sections[1].units[0].requirement_ids.pop();
  expect(() => validateBlueprint(lost, b.processed_requirement_ids)).toThrow();
  const unknown = structuredClone(b);
  unknown.sections[1].units[0].decision_ids = ["absent"];
  expect(() =>
    validateBlueprint(unknown, b.processed_requirement_ids),
  ).toThrow();
  expect(() =>
    validateBlueprint(b, b.processed_requirement_ids, [
      { key: "required-form", applicable: true },
    ]),
  ).toThrow();
  const invented = structuredClone(b);
  invented.decisions[0].kind = "company_fact";
  expect(() =>
    validateBlueprint(invented, b.processed_requirement_ids),
  ).toThrow();
});

it("writes a semantic unit once instead of splitting it every eight requirements and defers the summary", async () => {
  const ctx = context();
  const next = await nextStage(ctx);
  expect(next.steps).toHaveLength(1);
  expect(next.steps[0].input.requirement_ids).toHaveLength(35);
  expect(
    plannedDraftInputs({
      key: "legacy",
      title: "Legacy",
      volume: "technical",
      requirement_ids: ctx.requirements.map((r: any) => r.id),
    }),
  ).toHaveLength(5);
  ctx.step = { task: "draft_section", input: next.steps[0].input };
  const input = taskInput(ctx);
  expect(input.context.shared_decisions[0].kind).toBe("proposed_decision");
  expect(input.evidence.some((e) => e.kind === "company")).toBe(false);
  ctx.plan.stage = "commercial";
  expect((await nextStage(ctx)).steps.map((s) => s.input.section.key)).toEqual([
    "summary-unit",
  ]);
  ctx.plan.workflow_version = 1;
  expect((await nextStage(ctx)).next_stage).toBe("review");
});

it("packs reviews using full prose size and the response schema, including general sections", () => {
  const ctx = context(105);
  const sections = [
    {
      key: "large",
      requirement_ids: ctx.requirements.map((r: any) => r.id),
      content_blocks: [{ type: "paragraph", text: "Full relevant prose" }],
    },
    {
      key: "summary",
      requirement_ids: [],
      content_blocks: [{ type: "paragraph", text: "Summary" }],
    },
  ];
  const inputs = semanticReviewInputs(ctx.requirements, sections, 16384);
  expect(inputs.flatMap((i) => i.requirement_ids)).toEqual(
    ctx.requirements.map((r: any) => r.id),
  );
  expect(inputs.every((i) => i.requirement_ids.length <= 50)).toBe(true);
  expect(inputs.flatMap((i) => i.section_keys)).toContain("summary");
  expect(() => semanticReviewInputs(ctx.requirements, [], 16384)).toThrow();
});

it("pins complete commercial reconciliation only on new hierarchical work", async () => {
  const ctx = context(2);
  ctx.plan.stage = "review";
  const legacy = await nextStage(ctx);
  expect(legacy.steps[0].input.review_scope_version).toBeUndefined();
  ctx.plan.workflow_version = 3;
  const current = await nextStage(ctx);
  expect(current.steps[0].input).toMatchObject({
    coherence_review: true,
    review_scope_version: 1,
    requirement_ids: [],
  });
});

it("builds the matrix from actual review verdicts and preserves semantic outline lineage", () => {
  const ctx = context(2),
    b = ctx.steps[0].output;
  const parents = blueprintSections(b);
  const draftSteps = parents
    .flatMap((p) => plannedDraftInputs(p))
    .map((input, ordinal) => ({
      task: "draft_section",
      status: "completed",
      depth: 0,
      input,
      ordinal,
    }));
  const sections = draftSteps.map((s) => ({
    ...s.input.section,
    content_blocks: [{ type: "paragraph", text: "Proposed work" }],
    fixed: false,
  }));
  const responses = ctx.requirements.map((r: any, i: number) => ({
    requirement_id: r.id,
    status: i ? "clarification_required" : "answered",
    section_ids: ["approach-unit"],
    rationale: i
      ? "Quantity needs confirmation"
      : "The supplied response describes the workflow",
  }));
  const matrix = complianceMatrixSections(
    b,
    ctx.requirements,
    responses,
    sections,
    "en",
  )[0];
  expect(matrix.content_blocks[0].rows[1]).toEqual([
    "Workflow requirement r-1",
    "Approach",
    "Clarification required",
    "Quantity needs confirmation",
  ]);
  const outline = createSectionOutline(parents, draftSteps, [
    ...sections,
    matrix,
  ]);
  expect(outline?.groups.map((g) => g.parent_section_key)).toEqual([
    "summary",
    "approach",
    "compliance",
  ]);
  expect(() =>
    complianceMatrixSections(b, ctx.requirements, [], sections, "en"),
  ).toThrow();
});

it("deduplicates exact missing-input questions without dropping stronger blocking levels", () => {
  const questions = deduplicateQuestions([
    {
      question: "Confirm  quantity",
      blocking_level: "advisory",
      requirement_ids: ["a"],
    },
    {
      question: "Confirm quantity",
      blocking_level: "finalization",
      requirement_ids: ["b"],
    },
    { question: "Do not confirm quantity", blocking_level: "finalization" },
  ]);
  expect(questions).toHaveLength(2);
  expect(questions[0]).toMatchObject({
    blocking_level: "finalization",
    requirement_ids: ["a", "b"],
  });
});

it("reduces verification partitions only for admitted plans while retaining every undeclared text unit", () => {
  const candidate = {
    content_blocks: Array.from({ length: 12 }, (_, i) => ({
      type: "paragraph",
      text: `Undeclared assertion ${i}: ` + "synthetic content ".repeat(100),
    })),
    company_claims: [],
  };
  const old = verificationBatches(candidate);
  const current = verificationBatches(
    candidate,
    verificationPolicy({
      workflow_version: 2,
      verification_output_tokens: 16384,
    }),
  );
  expect(current.length).toBeLessThan(old.length);
  expect(current.flat()).toEqual(candidateContent(candidate));
  expect(verificationBatches(candidate, verificationPolicy({}))).toEqual(old);
  expect(
    verificationBatches(
      candidate,
      verificationPolicy({
        workflow_version: 2,
        verification_output_tokens: 4096,
      }),
    ).length,
  ).toBeGreaterThan(current.length);
});
