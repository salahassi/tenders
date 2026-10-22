// @vitest-environment node
import { expect, it } from "vitest";
import {
  batchGenerationRequirements,
  requirementModelContext,
} from "../../supabase/functions/_shared/generationBatching";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";

const requirement = (i: number, text = `Synthetic requirement ${i}`) => ({
  id: `r-${i}`,
  text,
  category: "functional",
  mandatory: true,
  interpretation: "Describe the proposed approach.",
  acceptance_evidence: "Demonstrate the result.",
  owner_question: null,
  source_refs: [{ id: "rfp", quote: "Synthetic evidence" }],
});
const fixture = (requirements = [requirement(0)]): any => ({
  plan: {
    id: "synthetic-plan",
    stage: "commercial",
    frozen_context: {
      notice: {
        id: "notice",
        text: "Synthetic notice",
        reference: {
          entity_kind: "opportunity",
          entity_id: "synthetic-opportunity",
        },
      },
      blocks: [
        {
          id: "rfp",
          text: "Synthetic evidence",
          kind: "rfp",
          reference: { entity_kind: "document", entity_id: "synthetic-rfp" },
        },
      ],
      knowledge: [],
      reviews: [],
      rates: [],
      template: { id: "synthetic-template", required_sections: [] },
    },
  },
  step: {
    task: "review_proposal",
    input: { requirement_ids: requirements.map((r) => r.id) },
  },
  requirements,
  steps: [],
});

it.each([
  ["plan_proposal", 24],
  ["review_proposal", 12],
] as const)(
  "bounds %s records without losing their order or identity",
  (task, limit) => {
    const rows = Array.from({ length: limit * 2 + 1 }, (_, i) =>
      requirement(i),
    );
    const original = structuredClone(rows);
    const batches = batchGenerationRequirements(rows, task);
    expect(batches.map((b) => b.length)).toEqual([limit, limit, 1]);
    expect(batches.flat()).toEqual(rows);
    expect(batches.flat().every((r, i) => r === rows[i])).toBe(true);
    expect(rows).toEqual(original);
    expect(batchGenerationRequirements([], task)).toEqual([]);
  },
);

it("packs the exact serialized context boundary and splits one character beyond it", () => {
  const rows = [requirement(0, ""), requirement(1, "")];
  const overhead = JSON.stringify(rows.map(requirementModelContext)).length;
  rows[1].text = "x".repeat(12000 - overhead);
  expect(JSON.stringify(rows.map(requirementModelContext)).length).toBe(12000);
  expect(batchGenerationRequirements(rows, "plan_proposal")).toEqual([rows]);
  rows[1].text += "x";
  expect(batchGenerationRequirements(rows, "plan_proposal")).toEqual([
    [rows[0]],
    [rows[1]],
  ]);
});

it("keeps oversized individual requirements intact and counts escaped Unicode context", () => {
  const rows = [
    requirement(0),
    requirement(1, '"متطلب\n'.repeat(3000)),
    requirement(2),
  ];
  const batches = batchGenerationRequirements(rows, "review_proposal");
  expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
  expect(batches.flat()).toEqual(rows);
  expect(batches[1][0].text).toBe(rows[1].text);
});

it("bounds long contextual requirements before reaching the record ceiling", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    requirement(i, "x".repeat(1800)),
  );
  const batches = batchGenerationRequirements(rows, "plan_proposal");
  expect(batches.flat()).toEqual(rows);
  expect(batches.every((b) => b.length > 0 && b.length < 24)).toBe(true);
  expect(
    batches.every(
      (b) => JSON.stringify(b.map(requirementModelContext)).length <= 12000,
    ),
  ).toBe(true);
});

it("schedules fewer new planning and review steps while covering every requirement exactly once", async () => {
  const rows = Array.from({ length: 49 }, (_, i) => requirement(i));
  const ctx = fixture(rows);
  ctx.plan.stage = "analysis";
  ctx.steps = [
    {
      task: "analyze_chunk",
      status: "completed",
      input: {},
      output: { requirements: rows },
    },
  ];
  const next = await nextStage(ctx);
  expect(next.next_stage).toBe("planning");
  expect(next.steps.map((s) => s.input.requirement_ids.length)).toEqual([
    24, 24, 1,
  ]);
  expect(next.steps.flatMap((s) => s.input.requirement_ids)).toEqual(
    next.requirements.map((r) => r.id),
  );
  expect(new Set(next.requirements.map((r) => r.id)).size).toBe(49);
  ctx.plan.stage = "commercial";
  const review = await nextStage(ctx);
  expect(review.steps.map((s) => s.input.requirement_ids.length)).toEqual([
    12, 12, 12, 12, 1,
  ]);
  expect(review.steps.flatMap((s) => s.input.requirement_ids)).toEqual(
    rows.map((r) => r.id),
  );
});

it("keeps the empty planning fallback and does not create empty review chunks", async () => {
  const ctx = fixture([]);
  ctx.plan.stage = "analysis";
  expect((await nextStage(ctx)).steps).toEqual([
    { task: "plan_proposal", input: { requirement_ids: [] } },
  ]);
  ctx.plan.stage = "commercial";
  expect((await nextStage(ctx)).steps).toEqual([]);
});

it("uses saved step IDs unchanged rather than repacking in-progress work", () => {
  const rows = Array.from({ length: 25 }, (_, i) => requirement(i));
  const ctx = fixture(rows);
  ctx.step = {
    task: "plan_proposal",
    input: { requirement_ids: rows.slice(0, 12).map((r) => r.id) },
  };
  const before = structuredClone(ctx);
  const request = taskInput(ctx);
  expect(request.requiredIds).toEqual(ctx.step.input.requirement_ids);
  expect(request.context.requirements).toEqual(
    rows.slice(0, 12).map(requirementModelContext),
  );
  expect(ctx).toEqual(before);
  expect(request).not.toHaveProperty("profile");
});

it("reviews scoped commercial proposals and their dependencies without promoting them to evidence", () => {
  const ctx = fixture([requirement(0), requirement(1)]);
  ctx.step.input.requirement_ids = ["r-0"];
  ctx.steps = [
    {
      task: "draft_section",
      status: "completed",
      input: {
        section: { key: "approach", title: "Approach", volume: "technical" },
      },
      output: {
        requirement_ids: ["r-0"],
        content_blocks: [],
        assumptions: [],
        evidence_refs: [],
      },
    },
  ];
  const initial = taskInput(ctx);
  const selectedLine = {
    description: "Proposed work",
    requirement_ids: ["r-0"],
    section_ids: ["approach"],
    quantity: null,
    rate_id: null,
  };
  const otherLine = {
    description: "Other work",
    requirement_ids: ["r-1"],
    section_ids: ["other"],
    quantity: "5",
    rate_id: null,
  };
  const scopedBySection = {
    description: "Section proposal",
    requirement_ids: [],
    section_ids: ["approach"],
    quantity: null,
    rate_id: null,
  };
  const build = {
    key: "build",
    title: "Proposed build",
    predecessors: ["design"],
    effort_days: null,
  };
  const design = {
    key: "design",
    title: "Proposed dependency",
    predecessors: [],
    effort_days: "2",
  };
  ctx.steps.push(
    {
      task: "plan_commercial",
      status: "completed",
      input: { requirement_ids: ["r-0"] },
      output: {
        lines: [selectedLine, otherLine],
        tasks: [build],
        questions: [
          { question: "Confirm scope", requirement_ids: ["r-0"] },
          { question: "Confirm unrelated scope", requirement_ids: ["r-1"] },
          { question: "Confirm pricing basis", requirement_ids: [] },
        ],
      },
    },
    {
      task: "plan_commercial",
      status: "completed",
      input: { requirement_ids: ["r-1"] },
      output: {
        lines: [otherLine],
        tasks: [
          design,
          { key: "other", title: "Other task", predecessors: [] },
        ],
        questions: [],
      },
    },
    {
      task: "plan_commercial",
      status: "completed",
      input: { requirement_ids: ["r-1"] },
      output: { lines: [scopedBySection], tasks: [], questions: [] },
    },
  );
  const snapshot = structuredClone(ctx);
  const request = taskInput(ctx);
  expect(request.context.commercial_draft).toEqual({
    status: "proposed_unconfirmed",
    lines: [selectedLine, scopedBySection],
    tasks: [build, design],
    questions: [
      { question: "Confirm scope", requirement_ids: ["r-0"] },
      { question: "Confirm pricing basis", requirement_ids: [] },
    ],
  });
  expect(request.evidence).toEqual(initial.evidence);
  expect(request.manifest).toEqual(initial.manifest);
  expect(request.context.instruction).toContain(
    "not supporting evidence or approved prices",
  );
  expect(ctx).toEqual(snapshot);
  ctx.step.input.review_scope_version = 1;
  const scoped = taskInput(ctx);
  expect(scoped.context.commercial_draft).toEqual(
    request.context.commercial_draft,
  );
  expect(scoped.context.commercial_review_scope).toEqual({
    complete: false,
    available_line_count: 4,
    included_line_count: 2,
    all_line_requirement_ids: ["r-0", "r-1"],
  });
  expect(scoped.context.instruction).toContain("SCOPED projection");

  // Final reconciliation has no assigned requirement IDs: it still needs all
  // commercial prose, dependencies and questions, including duplicate lines.
  ctx.step.input.coherence_review = true;
  ctx.step.input.requirement_ids = [];
  const complete = taskInput(ctx);
  expect(complete.context.commercial_draft).toEqual({
    status: "proposed_unconfirmed",
    lines: [selectedLine, otherLine, otherLine, scopedBySection],
    tasks: [
      build,
      design,
      { key: "other", title: "Other task", predecessors: [] },
    ],
    questions: snapshot.steps[1].output.questions,
  });
  expect(complete.context.commercial_review_scope).toMatchObject({
    complete: true,
    included_line_count: 4,
  });
  expect(complete.evidence).toEqual(initial.evidence);
  expect(complete.manifest).toEqual(initial.manifest);
});

it("retains unmapped commercial questions and proposed scope when the planning batch had no explicit requirement IDs", () => {
  const ctx = fixture();
  const output = {
    lines: [
      {
        description: "Unmapped scope",
        requirement_ids: [],
        section_ids: [],
        quantity: null,
        rate_id: null,
      },
    ],
    tasks: [
      { key: "scope", title: "Proposed scope", predecessors: ["missing"] },
    ],
    questions: [{ question: "Confirm the price", requirement_ids: [] }],
  };
  ctx.steps = [
    {
      task: "plan_commercial",
      status: "completed",
      input: { requirement_ids: [] },
      output,
    },
  ];
  expect(taskInput(ctx).context.commercial_draft).toEqual({
    status: "proposed_unconfirmed",
    ...output,
  });
});

it("does not invent a commercial draft from incomplete commercial steps", () => {
  const ctx = fixture();
  ctx.steps = [
    {
      task: "plan_commercial",
      status: "queued",
      input: { requirement_ids: [] },
      output: {
        lines: [{ description: "Incomplete" }],
        tasks: [],
        questions: [],
      },
    },
  ];
  expect(taskInput(ctx).context.commercial_draft).toEqual({
    status: "proposed_unconfirmed",
    lines: [],
    tasks: [],
    questions: [],
  });
});
