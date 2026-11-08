/** Actual image whole-proposal review functions; synthetic data only. */
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const product = "/app/backend/supabase/functions/_shared/";
const { taskInput, nextStage, validateGenerationResult } = await import(product + "generation.ts");
const { modelPrompt, sha256 } = await import(product + "model.ts");
const { modelSchemas } = await import(product + "modelSchemas.ts");
const { validateReviewSectionReferences } = await import(product + "proposalBlueprint.ts");
const { candidateContent } = await import(product + "modelGrounding.ts");
const { qualifierHash } = await import(product + "proposalConsistency.ts");
const { assessGeneratedDelivery } = await import(product + "generatedProposalConsistency.ts");
const baseline = runtime.env.get("NATIVE_BASELINE_MODE") === "true";
const check = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const equal = (a: unknown, b: unknown, code: string) => check(JSON.stringify(a) === JSON.stringify(b), code);
/** Synthetic complete legacy draft: no extracted requirement inventory. */
function legacyWholeReviewContext(): any {
  const source = {
    id: "synthetic-reference",
    text: "Describe the proposed workflow, handover and unresolved tax inputs.",
    kind: "rfp", verified: false,
    reference: { entity_kind: "document", entity_id: "synthetic-document", content_hash: "a".repeat(64) },
  };
  const sections = [
    { key: "approach", title: "Proposed approach", volume: "technical", requirement_ids: [] },
    { key: "handover", title: "Handover", volume: "technical", requirement_ids: [] },
  ];
  return {
    plan: {
      id: "synthetic-plan", kind: "proposal", workflow_version: 1, stage: "commercial", status: "running",
      frozen_context: {
        title: "Synthetic workflow draft", language: "en", draft_input_version: 1,
        notice: { id: "synthetic-notice", text: "Synthetic opportunity.", kind: "notice", verified: false,
          reference: { entity_kind: "opportunity", entity_id: "synthetic-opportunity", content_hash: "b".repeat(64) } },
        blocks: [source], knowledge: [], reviews: [], rates: [],
        input_materials: { version: 1, documents: [] },
        template: { id: "synthetic-template", required_sections: [], fixed_blocks: [
          { key: "scope-note", title: "Scope note", volume: "shared", body: "Unresolved commitments need authorized confirmation." },
        ] },
      },
    },
    step: { id: "synthetic-review", task: "review_proposal", input: { requirement_ids: [] } },
    requirements: [],
    steps: [
      { id: "synthetic-planning", task: "plan_proposal", status: "completed", ordinal: 1,
        input: { requirement_ids: [] }, output: { sections } },
      ...sections.map((section, index) => ({
        id: "synthetic-draft-" + section.key, task: "draft_section", stage: "drafting", status: "completed", ordinal: index + 2,
        input: { section, requirement_ids: [], rfp_context_version: 1 },
        output: { section_key: section.key, title: section.title, volume: section.volume, requirement_ids: [],
          content_blocks: [{ type: "paragraph", text: index === 0 ? "We propose a staged workflow with explicit approval gates." : "We propose a tested handover and a buyer witness session." }],
          assumptions: [], company_claims: [], questions: [], evidence_refs: [{ id: source.id, quote: source.text }] },
      })),
      { id: "synthetic-commercial", task: "plan_commercial", stage: "commercial", status: "completed", ordinal: 4,
        input: { requirement_ids: [] }, output: {
          lines: [{ key: "delivery", description: "Proposed workflow delivery", section_ids: ["approach"], requirement_ids: [], quantity: null, unit: "service", rate_id: null, period_count: null, tax_category: "", charge_group: "one_time", basis: "Proposed work pending confirmation." }],
          tasks: [{ key: "handover-task", title: "Proposed handover", requirement_ids: [], predecessors: [], effort_days: null, allocation: null, duration_days: null, basis: "Subject to resource confirmation." }],
          questions: [{ question: "Confirm the approved tax category and applicable rate.", requirement_ids: [], blocking_level: "finalization" }],
        } },
    ],
  };
}

function legacyWholeReviewInput(): any {
  return { requirement_ids: [], legacy_zero_inventory_review_version: 1,
    review_scope_version: 1, review_source_version: 1, coherence_review: true,
    section_keys: ["approach", "handover", "fixed-scope-note"] };
}

const phases = ["review_proposal", "repair_result", "verify_grounding"] as const;
const languages = ["en", "ar"] as const;
const policies = ["legacy", "pinned"] as const;
function wire(input: any, language: typeof languages[number], phase: typeof phases[number], policy: typeof policies[number]) {
  const context = phase === "review_proposal" ? input.context : {
    [phase === "repair_result" ? "target_task" : "original_task"]: "review_proposal", original_context: input.context };
  return modelPrompt(phase, context, input.evidence, input.requiredIds, language,
    false, policy === "pinned" ? 5 : 1, policy === "pinned" ? 5 : 0);
}
const original = legacyWholeReviewContext(), fixtureBefore = JSON.stringify(original);
const fixture_input_sha256 = await sha256(fixtureBefore);
const legacy_context_sha256: Record<string, string> = {};
const legacy_wire_sha256: Record<string, string> = {};
const modern_wire_sha256: Record<string, string> = {};
const rejected_scope_cases: Record<string, string> = {};
const checks: Record<string, boolean> = {};
const legacy = taskInput(original);
for (const [version, marker] of [["absent", undefined], ["0", 0], ["string1", "1"], ["null", null]] as const) {
  const context = legacyWholeReviewContext();
  if (version !== "absent") context.step.input.legacy_zero_inventory_review_version = marker;
  const before = JSON.stringify(context), input = taskInput(context);
  equal(JSON.stringify(context), before, "LEGACY_INPUT_MUTATED");
  equal(input, legacy, "INACTIVE_MARKER_CHANGED_CONTEXT");
  legacy_context_sha256[`${version}:context`] = await sha256(JSON.stringify(input.context));
  legacy_context_sha256[`${version}:task_input`] = await sha256(JSON.stringify(input));
  for (const language of languages) for (const phase of phases) for (const policy of policies)
    legacy_wire_sha256[`${language}:${phase}:${version}:${policy}`] = await sha256(wire(input, language, phase, policy));
}
equal(legacy.context.sections, [], "LEGACY_SECTION_PROJECTION_CHANGED");
checks.legacy_context_bytes_retained = true;
checks.legacy_prompt_bytes_retained = true;
const transition = await nextStage(original);
const transition_review_count = transition.steps.filter((step: any) => step.task === "review_proposal").length;
let review_source_sha256: string | null = null;
if (baseline) check(transition_review_count === 0, "HISTORICAL_ZERO_REVIEW_NOT_REPRODUCED");
else {
  check(transition_review_count === 1 && transition.steps.length === 1 && transition.next_stage === "review", "WHOLE_REVIEW_NOT_QUEUED");
  equal(transition.steps[0].input, legacyWholeReviewInput(), "REVIEW_INPUT_NOT_PINNED");
  const context = legacyWholeReviewContext(); context.step.input = legacyWholeReviewInput();
  const before = JSON.stringify(context), input = taskInput(context);
  equal(JSON.stringify(context), before, "MODERN_INPUT_MUTATED");
  check(input.context.legacy_zero_inventory_review_version === 1 && input.requiredIds.length === 0 &&
    context.plan.workflow_version === 1 && !input.context.blueprint && !input.context.response_locations,
    "LEGACY_SCOPE_CHANGED");
  equal(input.context.sections.map((section: any) => section.key), context.step.input.section_keys, "FULL_SCOPE_MISSING");
  const source = input.evidence.find((item: any) => item.id === "proposal-review:synthetic-review");
  check(source?.kind === "review" && source.verified === false, "DRAFT_TRUST_ESCALATED");
  for (const section of context.steps.filter((step: any) => step.task === "draft_section"))
    for (const block of section.output.content_blocks) check(source.text.includes(block.text), "DRAFT_PROSE_MISSING");
  check(source.text.includes(context.plan.frozen_context.template.fixed_blocks[0].body), "FIXED_PROSE_MISSING");
  const commercial = context.steps.find((step: any) => step.task === "plan_commercial").output;
  for (const text of [commercial.lines[0].description, commercial.tasks[0].title, commercial.questions[0].question])
    check(source.text.includes(text), "COMMERCIAL_CONTENT_MISSING");
  check(input.context.commercial_review_scope.complete === true && input.context.commercial_draft.line_count === 1 &&
    input.context.commercial_draft.task_count === 1 && input.context.commercial_draft.status === "proposed_unconfirmed",
    "COMMERCIAL_SCOPE_CHANGED");
  check(input.context.instruction.includes("whole-proposal review") && input.context.instruction.includes("not human approval") &&
    input.context.instruction.includes("NOT verified company evidence"), "WHOLE_REVIEW_GUIDANCE_MISSING");
  review_source_sha256 = await sha256(source.text);
  for (const language of languages) for (const phase of phases) for (const policy of policies) {
    const text = wire(input, language, phase, policy);
    check(text.includes("proposal-review:synthetic-review") && text.includes(commercial.lines[0].description), "PHASE_LOST_REVIEW_CONTENT");
    modern_wire_sha256[`${language}:${phase}:${policy}`] = await sha256(text);
  }
  const scopeCases: Record<string, (ctx: any) => void> = {
    non_review_task: ctx => { ctx.step.task = "plan_commercial"; },
    non_proposal: ctx => { ctx.plan.kind = "assessment"; },
    semantic_plan: ctx => { ctx.plan.workflow_version = 2; },
    nonempty_inventory: ctx => { ctx.requirements = [{ id: "synthetic-requirement" }]; },
    nonempty_ids: ctx => { ctx.step.input.requirement_ids = ["synthetic-requirement"]; },
    semantic_input: ctx => { ctx.step.input.workflow_version = 2; },
    missing_scope: ctx => { delete ctx.step.input.review_scope_version; },
    missing_source: ctx => { delete ctx.step.input.review_source_version; },
    not_coherence: ctx => { ctx.step.input.coherence_review = false; },
    missing_section: ctx => { ctx.step.input.section_keys.pop(); },
    extra_section: ctx => { ctx.step.input.section_keys.push("unknown"); },
    reordered_sections: ctx => { ctx.step.input.section_keys.reverse(); },
  };
  for (const [name, mutate] of Object.entries(scopeCases)) {
    const bad = legacyWholeReviewContext(); bad.step.input = legacyWholeReviewInput(); mutate(bad);
    let code: string | undefined;
    try { taskInput(bad); } catch (error: any) { code = error.code; }
    check(code === "INVALID_INPUT", "INVALID_MARKER_SCOPE_ACCEPTED:" + name);
    rejected_scope_cases[name] = code!;
  }
  const result = { processed_requirement_ids: [], responses: [], findings: [] };
  equal(modelSchemas.review_proposal.parse(result), result, "REVIEW_SCHEMA_CHANGED");
  validateGenerationResult(context, input, result, { independentGrounding: true });
  const finding = { severity: "advisory", category: "confirmation", detail: "Confirm unresolved commitments.",
    requirement_ids: [], section_ids: ["fixed-scope-note"] };
  validateReviewSectionReferences({ ...result, findings: [finding] }, input.context);
  let badReference = false;
  try { validateReviewSectionReferences({ ...result, findings: [{ ...finding, section_ids: ["unknown"] }] }, input.context); }
  catch (error: any) { badReference = error.code === "EVIDENCE_REFERENCE_INVALID"; }
  check(badReference, "UNKNOWN_REVIEW_SECTION_ACCEPTED");
  for (const key of ["whole_review_context_bound", "all_saved_prose_in_review_source", "full_commercial_in_review_source",
    "review_source_untrusted", "review_marker_scope_exact", "zero_inventory_transition_enqueues_review", "review_result_references_validated"])
    checks[key] = true;
}
// A synthetic, independently checked receipt set proves reconstruction. It is
// explicitly local test data and is never persisted or reported as a real review.
if (!baseline) {
  const context = legacyWholeReviewContext();
  context.plan.status = "completed"; context.plan.stage = "review";
  context.plan.frozen_context.proposal_consistency_version = 1;
  context.steps.push({ ...context.step, stage: "review", status: "completed", ordinal: 5,
    input: legacyWholeReviewInput(), output: { processed_requirement_ids: [], responses: [], findings: [] } });
  context.step = { task: "advance_plan", input: {} };
  const final = (await nextStage(context)).final_result;
  const accepted_receipts = await Promise.all(context.steps.map(async (step: any, stepIndex: number) => {
    const candidate = step.output, hash = await qualifierHash(JSON.stringify(candidate)), units = candidateContent(candidate);
    return { step_id: step.id, receipt_id: "synthetic-receipt-" + stepIndex,
      verification_receipt_id: "synthetic-verification-" + stepIndex, candidate_hash: hash, candidate, accepted: true,
      verification: { checked_candidate_hash: hash, reviewed_all_content: true,
        processed_content_ids: units.map((unit: any) => unit.id), processed_requirement_ids: [], requirement_checks: [], findings: [],
        claims: units.map((unit: any, index: number) => ({ id: "proposed-" + index, claim: unit.text, candidate_quote: unit.text,
          kind: "proposed_solution", status: "supported", source_refs: [], finding: "Proposed draft wording." })) } };
  }));
  const delivery = { plan: context.plan, steps: context.steps, requirements: [], sections: final.sections,
    section_outline: final.section_outline, accepted_receipts };
  const report = await assessGeneratedDelivery(delivery);
  check(report.machine_eligible && report.blockers.length === 0 && report.approval_state === "draft" &&
    report.substantive_complete === false, "VALID_MARKED_REVIEW_NOT_RECONSTRUCTED");
  const stale = structuredClone(delivery);
  stale.accepted_receipts.find((receipt: any) => receipt.step_id === "synthetic-review")!.candidate_hash = "f".repeat(64);
  const staleReport = await assessGeneratedDelivery(stale);
  check(!staleReport.machine_eligible && staleReport.blockers.some((item: any) => item.code === "WHOLE_PROPOSAL_REVIEW_REQUIRED"),
    "STALE_REVIEW_RECEIPT_ACCEPTED");
  checks.accepted_review_reconstructed = true;
}
// Both actual images must refuse issuance without an accepted whole-proposal review.
// This deliberately supplies no receipts; no synthetic fixture is presented as model acceptance.
const assembled = (await nextStage({ ...original, plan: { ...original.plan, stage: "review" } })).final_result;
const delivery = { plan: { ...original.plan, status: "completed", frozen_context: {
  ...original.plan.frozen_context, proposal_consistency_version: 1 } }, steps: original.steps,
  requirements: [], sections: assembled.sections, section_outline: assembled.section_outline, accepted_receipts: [] };
const noReview = await assessGeneratedDelivery(delivery);
check(!noReview.machine_eligible && noReview.blockers.some((item: any) => item.code === "WHOLE_PROPOSAL_REVIEW_REQUIRED"),
  "MISSING_WHOLE_REVIEW_ACCEPTED");
const unverifiedReview = await assessGeneratedDelivery({ ...delivery, steps: [...delivery.steps, {
  id: "synthetic-unverified-review", task: "review_proposal", status: "completed", input: legacyWholeReviewInput(),
  output: { processed_requirement_ids: [], responses: [], findings: [] } }] });
check(!unverifiedReview.machine_eligible && unverifiedReview.blockers.some((item: any) => item.code === "WHOLE_PROPOSAL_REVIEW_REQUIRED"),
  "UNVERIFIED_REVIEW_ACCEPTED");
checks.whole_review_receipt_required = true;
equal(JSON.stringify(original), fixtureBefore, "ORIGINAL_INPUT_MUTATED");
checks.inputs_unchanged = true;
const source_sha256: Record<string, string> = {};
async function bytesHash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function collectBytes(relative: string) {
  for await (const entry of runtime.readDir("/app/" + relative)) {
    const path = relative + "/" + entry.name;
    if (entry.isDirectory) await collectBytes(path);
    else if (entry.isFile) source_sha256[path] = await bytesHash(await runtime.readFile("/app/" + path));
    else throw new Error("UNSUPPORTED_IMAGE_SOURCE_TYPE");
  }
}
for (const root of ["backend/supabase/functions", "backend/scripts/runtime", "frontend/public/fonts"]) await collectBytes(root);
for (const file of ["frontend/src/lib/renderDocx.ts", "frontend/src/lib/docxTableStream.ts"])
  source_sha256[file] = await bytesHash(await runtime.readFile("/app/" + file));
console.log(JSON.stringify({ version: 1, baseline, passed: true, checks, source_sha256, fixture_input_sha256,
  legacy_context_sha256, legacy_wire_sha256, modern_wire_sha256, rejected_scope_cases, review_source_sha256,
  transition_review_count, provider_calls: 0,
  scope: "Actual immutable-image review context/prompt/validation; synthetic inputs only, no provider or accepted customer review." }));
