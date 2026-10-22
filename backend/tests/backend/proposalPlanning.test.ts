// @vitest-environment node
import { expect, it } from "vitest";
import type { ProposalBlueprint } from "../../supabase/functions/_shared/proposalBlueprintSchema";
import {
  expandStructure,
  validateStructure,
  planningDetailInputs,
  validatePlanningDetails,
  mergePlanningDetails,
  splitPlanningDetails,
} from "../../supabase/functions/_shared/proposalPlanning";
import { requirementAliases } from "../../supabase/functions/_shared/proposalBlueprint";
import {
  taskInput,
  nextStage,
  splitStep,
} from "../../supabase/functions/_shared/generation";
import {
  caps,
  modelPrompt,
  taskSystemInstructions,
} from "../../supabase/functions/_shared/model";
import {
  resolveProfile,
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";

function fixture() {
  const requirements = Array.from({ length: 24 }, (_, i) => ({
    id: `r-${String(i).padStart(2, "0")}`,
    text:
      `المتطلب ${i}: preserve the original condition and exception. ` +
      "original evidence ".repeat(130),
    category: "functional",
    mandatory: true,
    interpretation: "Do not weaken the condition",
    acceptance_evidence: "Verify the observable result",
    owner_question: null,
    source_refs: [
      { id: "source", quote: "The service must preserve every exception." },
    ],
  }));
  const aliases = requirementAliases(requirements);
  const decision = {
    key: "shared",
    statement: "Propose shared authentication",
    kind: "proposed_decision",
    requirement_ids: [],
    evidence_refs: [],
  };
  const structure: any = {
    version: 3,
    decisions: [decision],
    questions: [],
    sections: [
      ...[0, 1, 2].map((n) => ({
        key: `subject-${n}`,
        title: `Subject ${n}`,
        purpose: `Explain subject ${n}`,
        volume: "technical",
        mode: "narrative",
        requirement_ids: requirements.slice(n * 8, n * 8 + 8).map((r) => r.id),
      })),
      {
        key: "summary",
        title: "Summary",
        purpose: "Explain the completed solution",
        volume: "technical",
        mode: "executive_summary",
        requirement_ids: [],
      },
      {
        key: "matrix",
        title: "Matrix",
        purpose: "Link reviewed answers",
        volume: "technical",
        mode: "compliance_matrix",
        requirement_ids: [],
      },
    ],
  };
  const stored = {
    ...structure,
    sections: structure.sections.map((s: any) => ({
      ...s,
      requirement_ids: s.requirement_ids.map((id: string) => aliases.get(id)),
    })),
  };
  const ctx: any = {
    plan: {
      id: "synthetic",
      workflow_version: 3,
      stage: "planning",
      execution_policy: { verification_output_tokens: 40000 },
      frozen_context: {
        language: "en",
        template: { id: "template", required_sections: [], fixed_blocks: [] },
        notice: { id: "notice", kind: "notice", text: "Synthetic notice" },
        knowledge: [],
        reviews: [],
        rates: [],
        blocks: [
          {
            id: "source",
            kind: "rfp",
            text: "The service must preserve every exception.",
            reference: {
              entity_kind: "document",
              entity_id: "doc",
              content_hash: "a".repeat(64),
            },
          },
        ],
      },
    },
    requirements,
    step: { task: "advance_plan", input: {} },
    steps: [
      {
        task: "plan_proposal",
        status: "completed",
        input: { planning_phase: "structure" },
        output: stored,
        ordinal: 1,
      },
    ],
  };
  const detail = (input: any): ProposalBlueprint => ({
    version: 2,
    processed_requirement_ids: input.requirement_ids.map((id: string) =>
      aliases.get(id),
    ),
    decisions: [],
    questions: [],
    sections: structure.sections
      .filter((s: any) => input.section_keys.includes(s.key))
      .map((s: any) => ({
        key: s.key,
        title: s.title,
        purpose: s.purpose,
        volume: s.volume,
        mode: s.mode,
        units: [
          {
            key: s.key + "-unit",
            title: s.title,
            purpose: s.purpose,
            target_words: 600,
            decision_ids: ["shared"],
            secondary_links: [],
            requirement_ids: s.requirement_ids
              .filter((id: string) => input.requirement_ids.includes(id))
              .map((id: string) => aliases.get(id)),
          },
        ],
      })),
  });
  return { requirements, aliases, structure, stored, ctx, detail };
}

it("uses one 40,000 default for every task, honors a lower provider capability, and instructs completion without padding", () => {
  for (const task of Object.keys(
    taskRegistry,
  ) as (keyof typeof taskRegistry)[]) {
    expect(taskRegistry[task].profile.max_output_tokens).toBe(40000);
    expect(caps[task]).toBe(40000);
  }
  expect(
    resolveProfile("plan_structure", {
      ...defaultCapabilities("openai"),
      max_output_tokens: 32000,
    }).max_output_tokens,
  ).toBe(32000);
  const text = taskSystemInstructions("draft_section", 1, 2);
  expect(text).toContain("ceiling, never a target or minimum");
  expect(text).toContain("Preserve every required fact");
  expect(
    modelPrompt("draft_section", {}, [], [], "en", false, 1, 0),
  ).not.toContain("output_policy");
  expect(modelPrompt("draft_section", {}, [], [], "en", false, 1, 2)).toContain(
    "output_policy",
  );
});

it("maps every requirement once and rejects omissions, duplicate ownership, missing mandatory forms and factual decisions without evidence", () => {
  const { structure, stored, requirements } = fixture();
  expect(expandStructure(stored, requirements)).toEqual(structure);
  expect(() =>
    validateStructure(
      structure,
      requirements.map((r) => r.id),
      [],
    ),
  ).not.toThrow();
  const duplicate = structuredClone(structure);
  duplicate.sections[1].requirement_ids.push(requirements[0].id);
  expect(() =>
    validateStructure(
      duplicate,
      requirements.map((r) => r.id),
      [],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  const missing = structuredClone(structure);
  missing.sections[0].requirement_ids.pop();
  expect(() =>
    validateStructure(
      missing,
      requirements.map((r) => r.id),
      [],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  expect(() =>
    validateStructure(
      structure,
      requirements.map((r) => r.id),
      [{ key: "required-form", applicable: true, volume: "financial" }],
    ),
  ).toThrow();
  const falseFact = structuredClone(structure);
  falseFact.decisions[0].kind = "company_fact";
  expect(() =>
    validateStructure(
      falseFact,
      requirements.map((r) => r.id),
      [],
    ),
  ).toThrow();
});

it("packs whole model-selected subjects by size, retains all original details and shares one accepted decision set", async () => {
  const { ctx, structure, requirements } = fixture();
  const transition = await nextStage(ctx);
  expect(transition.next_stage).toBe("detailing");
  expect(transition.steps.length).toBeGreaterThan(1);
  expect(
    transition.steps.flatMap((s) => s.input.requirement_ids).sort(),
  ).toEqual(requirements.map((r) => r.id).sort());
  for (const step of transition.steps) {
    const input = taskInput({
      ...ctx,
      step,
      plan: { ...ctx.plan, stage: "detailing" },
    });
    expect(input.task).toBe("plan_blueprint");
    expect(input.evidence[0].text).toContain("preserve every exception");
    expect(input.context.shared_decisions).toEqual(structure.decisions);
    expect(input.context.requirements.map((r: any) => r.text)).toEqual(
      requirements
        .filter((r) => step.input.requirement_ids.includes(r.id))
        .map((r) => r.text),
    );
    expect(input.context.instruction).toContain("decisions:[]");
  }
});

it("splits only the truncated detail group, keeps shared decisions immutable and merges saved groups into one coherent writing map", () => {
  const { ctx, structure, requirements, detail } = fixture();
  const inputs = planningDetailInputs(structure, requirements);
  const split = splitStep({
    ...ctx,
    step: { task: "plan_proposal", input: inputs[0], depth: 0 },
  })!;
  expect(split).toHaveLength(2);
  expect(split.flatMap((s) => s.requirement_ids)).toEqual(
    inputs[0].requirement_ids,
  );
  expect(split[0].section_keys).toEqual(inputs[0].section_keys);
  const all = [...split, ...inputs.slice(1)];
  const steps = [
    ...ctx.steps,
    { task: "plan_proposal", status: "split", input: inputs[0], ordinal: 2 },
    ...all.map((input, i) => ({
      task: "plan_proposal",
      status: "completed",
      input,
      output: detail(input),
      ordinal: i + 3,
    })),
  ];
  const result = mergePlanningDetails(steps, requirements)!;
  expect(result.decisions).toEqual(structure.decisions);
  expect(result.sections.map((s) => s.key)).toEqual(
    structure.sections.map((s: any) => s.key),
  );
  expect(
    result.sections
      .flatMap((s) => s.units.flatMap((u) => u.requirement_ids))
      .sort(),
  ).toEqual(requirements.map((r) => r.id).sort());
  expect(
    new Set(result.sections.flatMap((s) => s.units.map((u) => u.key))).size,
  ).toBe(result.sections.flatMap((s) => s.units).length);
  const mutated = detail(all[0]);
  mutated.decisions = [structure.decisions[0]];
  expect(() =>
    validatePlanningDetails(mutated, all[0], structure, requirements),
  ).toThrow();
  const moved = detail(all[0]);
  moved.sections[0].volume = "financial";
  expect(() =>
    validatePlanningDetails(moved, all[0], structure, requirements),
  ).toThrow();
  const incomplete = steps.filter((s: any) => s.ordinal !== 3);
  expect(() => mergePlanningDetails(incomplete, requirements)).toThrow();
});

it("splits at section boundaries before subdividing a single oversized subject", () => {
  const { structure, requirements } = fixture();
  const grouped = planningDetailInputs(structure, requirements, 500000)[0];
  const halves = splitPlanningDetails(grouped, structure)!;
  expect(halves).toHaveLength(2);
  expect(halves.flatMap((x) => x.section_keys)).toEqual(grouped.section_keys);
  expect(halves.flatMap((x) => x.requirement_ids).sort()).toEqual(
    grouped.requirement_ids.sort(),
  );
});
