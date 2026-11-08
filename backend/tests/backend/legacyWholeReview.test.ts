// @vitest-environment node
import { expect, it } from "vitest";
import { nextStage, taskInput } from "../../supabase/functions/_shared/generation";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { assessGeneratedDelivery } from "../../supabase/functions/_shared/generatedProposalConsistency";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency";
import { legacyWholeReviewContext, legacyWholeReviewInput } from "./legacyWholeReviewFixture";

it("keeps absent-marker context and English/Arabic wires at the deployed baseline", async () => {
  const context = legacyWholeReviewContext(), input = taskInput(context);
  expect(await sha256(JSON.stringify(input))).toBe("82aaa3cdb0f6d4ffd75c58124e89416d95177dc11ab489eef792909fd9feafb3");
  expect(await sha256(modelPrompt(input.task, input.context, input.evidence, input.requiredIds, "en")))
    .toBe("018e70ebf240b7a366311d320cb028a435b899ccc274dc21350ca57998866935");
  expect(await sha256(modelPrompt(input.task, input.context, input.evidence, input.requiredIds, "ar")))
    .toBe("5ccd17cf02c1187c921136a5ab611d628e623009a0a0337454bf7fa2687bdf44");
  for (const marker of [0, "1", null, 2]) {
    context.step.input.legacy_zero_inventory_review_version = marker;
    expect(taskInput(context)).toEqual(input);
  }
  expect(input.context.sections).toEqual([]);
});

it("reviews full saved prose, fixed text and all commercial content without a semantic blueprint", () => {
  const context = legacyWholeReviewContext(); context.step.input = legacyWholeReviewInput();
  const before = structuredClone(context), input = taskInput(context);
  expect(context).toEqual(before);
  expect(context.steps[0].output.version).toBeUndefined();
  expect(input.context.workflow_version).toBeUndefined();
  expect(input.context.shared_decisions).toEqual([]);
  expect(input.context.legacy_zero_inventory_review_version).toBe(1);
  expect(input.context.sections.map((section: any) => section.key)).toEqual(context.step.input.section_keys);
  expect(input.context.commercial_review_scope).toMatchObject({ complete: true, available_line_count: 1, included_line_count: 1 });
  const audit = input.evidence.find((source) => source.id === "proposal-review:synthetic-review")!;
  expect(audit.kind).toBe("review"); expect(audit.verified).toBe(false);
  for (const step of context.steps.filter((step: any) => step.task === "draft_section"))
    expect(audit.text).toContain(step.output.content_blocks[0].text);
  expect(audit.text).toContain(context.plan.frozen_context.template.fixed_blocks[0].body);
  expect(audit.text).toContain("Confirm the approved tax category and applicable rate.");
  expect(audit.text).toContain("Subject to resource confirmation.");
  expect(input.context.instruction).toContain("Do not invent requirement IDs");
  expect(input.requiredIds).toEqual([]);
  const legacy = taskInput({ ...context, step: { ...context.step, input: { requirement_ids: [] } } });
  expect([...input.manifest].sort((a, b) => a.entity_id.localeCompare(b.entity_id)))
    .toEqual([...legacy.manifest].sort((a, b) => a.entity_id.localeCompare(b.entity_id)));
});

it("retains all seventeen full sections, seven commercial lines and eight tasks in the audit", () => {
  const context = legacyWholeReviewContext();
  const template = context.steps.find((step: any) => step.task === "draft_section");
  const drafts = Array.from({ length: 17 }, (_, index) => ({
    ...structuredClone(template), id: "synthetic-draft-" + index, ordinal: index + 2,
    input: { ...template.input, section: { ...template.input.section, key: "section-" + index } },
    output: { ...template.output, content_blocks: [{ type: "paragraph", text: "Complete saved prose for synthetic section " + index + ".\nRetain every original sentence." }] },
  }));
  context.plan.frozen_context.template.fixed_blocks = [];
  context.steps = context.steps.filter((step: any) => step.task !== "draft_section").concat(drafts);
  const commercial = context.steps.find((step: any) => step.task === "plan_commercial").output;
  commercial.lines = Array.from({ length: 7 }, (_, index) => ({ ...commercial.lines[0], key: "line-" + index, description: "Complete proposed line " + index }));
  commercial.tasks = Array.from({ length: 8 }, (_, index) => ({ ...commercial.tasks[0], key: "task-" + index, title: "Complete proposed task " + index }));
  context.step.input = { ...legacyWholeReviewInput(), section_keys: drafts.map((step) => step.input.section.key) };
  const input = taskInput(context), audit = input.evidence.find((source) => source.id.startsWith("proposal-review:"))!;
  expect(input.context.sections).toHaveLength(17);
  expect(input.context.commercial_draft).toMatchObject({ line_count: 7, task_count: 8 });
  for (const step of drafts) expect(audit.text).toContain(step.output.content_blocks[0].text);
  for (const line of commercial.lines) expect(audit.text).toContain(line.description);
  for (const task of commercial.tasks) expect(audit.text).toContain(task.title);
});

it("rejects marker misuse, blueprint upgrades and shortened or reordered full-section scope", () => {
  const changes = [
    (ctx: any) => { ctx.plan.workflow_version = 2; },
    (ctx: any) => { ctx.requirements.push({ id: "unassigned" }); },
    (ctx: any) => { ctx.step.task = "draft_section"; },
    (ctx: any) => { ctx.step.input.requirement_ids = ["invented"]; },
    (ctx: any) => { ctx.step.input.workflow_version = 2; },
    (ctx: any) => { delete ctx.step.input.review_source_version; },
    (ctx: any) => { delete ctx.step.input.review_scope_version; },
    (ctx: any) => { delete ctx.step.input.coherence_review; },
    (ctx: any) => { ctx.step.input.section_keys.pop(); },
    (ctx: any) => { ctx.step.input.section_keys.reverse(); },
  ];
  for (const change of changes) {
    const context = legacyWholeReviewContext(); context.step.input = legacyWholeReviewInput(); change(context);
    expect(() => taskInput(context)).toThrow("INVALID_INPUT");
  }
});

it("schedules one real marked review on a new legacy zero-inventory transition", async () => {
  const context = legacyWholeReviewContext(); context.step = { task: "advance_plan", input: {} };
  const before = structuredClone(context), next = await nextStage(context);
  expect(context).toEqual(before);
  expect(next.next_stage).toBe("review");
  expect(next.steps).toEqual([{ task: "review_proposal", input: legacyWholeReviewInput() }]);
  expect(next.final_result).toBeNull();
  const marked = taskInput({ ...context, plan: { ...context.plan, stage: "review" }, step: { id: "new-review", ...next.steps[0] } });
  expect(marked.context.sections).toHaveLength(3);
  context.requirements = [{ id: "formal-requirement", text: "Synthetic formal scope" }];
  expect((await nextStage(context)).steps).toEqual([{ task: "review_proposal", input: { requirement_ids: ["formal-requirement"] } }]);
});

async function acceptedZeroInventoryDraft() {
  const context = legacyWholeReviewContext();
  context.plan.status = "completed"; context.plan.stage = "review";
  context.plan.frozen_context.proposal_consistency_version = 1;
  context.steps.push({ ...context.step, stage: "review", status: "completed", ordinal: 5,
    input: legacyWholeReviewInput(), output: { processed_requirement_ids: [], responses: [], findings: [] } });
  context.step = { task: "advance_plan", input: {} };
  const final = (await nextStage(context)).final_result!;
  const accepted_receipts = await Promise.all(context.steps.map(async (step: any) => {
    const candidate = step.output, hash = await qualifierHash(JSON.stringify(candidate)), units = candidateContent(candidate);
    return { step_id: step.id, receipt_id: crypto.randomUUID(), verification_receipt_id: crypto.randomUUID(),
      candidate_hash: hash, candidate, accepted: true as const, verification: {
        checked_candidate_hash: hash, reviewed_all_content: true, processed_content_ids: units.map((unit) => unit.id),
        processed_requirement_ids: [], requirement_checks: [], findings: [],
        claims: units.map((unit, index) => ({ id: "proposed-" + index, claim: unit.text, candidate_quote: unit.text,
          kind: "proposed_solution", status: "supported", source_refs: [], finding: "Proposed draft wording." })),
      } };
  }));
  return { plan: context.plan, steps: context.steps, requirements: [], sections: final.sections,
    section_outline: final.section_outline, accepted_receipts };
}

it("reconstructs valid marked review receipts and still blocks missing or unverified review", async () => {
  const input = await acceptedZeroInventoryDraft();
  expect((await assessGeneratedDelivery(input)).blockers).toEqual([]);
  const missing = structuredClone(input);
  missing.steps = missing.steps.filter((step: any) => step.task !== "review_proposal");
  missing.accepted_receipts = missing.accepted_receipts.filter((receipt) => receipt.step_id !== "synthetic-review");
  expect((await assessGeneratedDelivery(missing)).blockers.map((blocker) => blocker.code)).toContain("WHOLE_PROPOSAL_REVIEW_REQUIRED");
  input.accepted_receipts.find((receipt) => receipt.step_id === "synthetic-review")!.candidate_hash = "f".repeat(64);
  expect((await assessGeneratedDelivery(input)).blockers.map((blocker) => blocker.code)).toContain("WHOLE_PROPOSAL_REVIEW_REQUIRED");
});
