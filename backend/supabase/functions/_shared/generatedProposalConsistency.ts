import { nextStage, taskInput } from "./generation.ts";
import {
  groundingDefects,
  groundingOptions,
  validateGroundingReport,
} from "./modelGrounding.ts";
import {
  consistencyHash,
  consistencyText,
  qualifierHash,
  sectionContent,
  sourceQuantityInQuote,
  type ConsistencyRequirement,
} from "./proposalConsistency.ts";
import type { Evidence } from "./model.ts";
type Row = Record<string, any>;
export type GeneratedDeliveryReceipt = {
  step_id: string;
  receipt_id: string;
  verification_receipt_id: string;
  candidate_hash: string;
  candidate: Row;
  verification: Row;
  accepted: true;
  evidence?: Evidence[];
  task?: string;
  thread_id?: string;
  graph_input_hash?: string;
};
export type GeneratedDeliveryInput = {
  plan: Row;
  steps: Row[];
  requirements: ConsistencyRequirement[];
  sections: Row[];
  section_outline: unknown;
  accepted_receipts: GeneratedDeliveryReceipt[];
};
export type GeneratedDeliveryReport = {
  version: 1;
  policy: "generated-delivery-v1";
  input_hash: string;
  machine_eligible: boolean;
  substantive_complete: false;
  approval_state: "draft";
  assurance: "model_checked_source_review_required";
  receipt_ids: string[];
  verification_receipt_ids: string[];
  coverage: {
    requirement_id: string;
    status: "model_checked" | "gap" | "non_obligation";
    section_keys: string[];
  }[];
  blockers: {
    code: string;
    detail?: string;
    paths?: string[];
    step_id?: string;
    section_key?: string;
    requirement_id?: string;
  }[];
  human_gaps: { code: string; detail?: string; requirement_id?: string }[];
};
const has = (text: string, quote: unknown) =>
  typeof quote === "string" &&
  !!quote.trim() &&
  consistencyText(text).includes(consistencyText(quote));
const projection = (s: Row) => ({
  key: s.key || s.section_key,
  title: s.title,
  volume: s.volume,
  body: s.body,
  content_blocks: s.content_blocks,
  requirement_ids: s.requirement_ids,
  evidence_refs: s.evidence_refs,
  company_claims: s.company_claims || [],
  fixed: s.fixed === true,
});
const genericResponse = (text: string) =>
  /^(?:we\s+(?:will\s+)?(?:fully\s+)?comply(?:\s+with\s+(?:all\s+)?(?:the\s+)?requirements)?|compliant|نلتزم(?:\s+بجميع\s+المتطلبات)?)[.!\s]*$/iu.test(
    consistencyText(text),
  );
/** Machine issuance is distinct from human final approval. All receipts and
 * frozen/current inputs must be selected by the service from accepted graph
 * history under the publication lease. This helper cannot authenticate a caller.
 * It performs no model call, invents no human review, and returns known defects
 * separately from honest source/authority/final-review gaps. */
export async function assessGeneratedDelivery(
  input: GeneratedDeliveryInput,
): Promise<GeneratedDeliveryReport> {
  const blockers: GeneratedDeliveryReport["blockers"] = [],
    gaps: GeneratedDeliveryReport["human_gaps"] = [];
  const frozen = input.plan.frozen_context || {};
  const add = (
    code: string,
    detail: Omit<GeneratedDeliveryReport["blockers"][number], "code"> = {},
  ) => blockers.push({ code, ...detail });
  if (
    input.plan.kind !== "proposal" ||
    input.plan.status !== "completed" ||
    frozen.proposal_consistency_version !== 1
  )
    add("GENERATED_PLAN_NOT_COMPLETE");
  if (
    !input.sections.length ||
    input.steps.length > 1000 ||
    input.sections.length > 2000
  )
    add("GENERATED_CONTENT_EMPTY_OR_UNBOUNDED");
  if (
    new Set(input.accepted_receipts.map((r) => r.step_id)).size !==
    input.accepted_receipts.length
  )
    add("DUPLICATE_ACCEPTED_RECEIPT");
  const rawSources = [
    frozen.notice,
    ...(frozen.blocks || []),
    ...(frozen.knowledge || []),
    ...(frozen.reviews || []),
    ...(frozen.rates || []),
  ].filter(Boolean);
  const spanSources = (frozen.source_evidence?.spans || []).map((s: Row) => ({
    id: s.id,
    text: s.quote,
    kind: "rfp",
    verified: false,
    reference: {
      entity_kind: s.entity_kind,
      entity_id: s.entity_id,
      content_hash: s.content_hash,
    },
  }));
  const sources = [...rawSources, ...spanSources] as Evidence[];
  let assembled: Row | null = null;
  try {
    const next = await nextStage({
      plan: { ...input.plan, stage: "reconciliation" },
      step: { task: "advance_plan", input: {} },
      steps: input.steps,
      requirements: input.requirements,
    });
    assembled = next.final_result;
    if (
      !assembled ||
      (await consistencyHash(assembled.sections.map(projection))) !==
        (await consistencyHash(input.sections.map(projection))) ||
      (await consistencyHash(assembled.section_outline)) !==
        (await consistencyHash(input.section_outline))
    )
      add("GENERATED_ASSEMBLY_MISMATCH");
  } catch {
    add("GENERATED_ASSEMBLY_INCOMPLETE");
  }
  if (!assembled?.section_outline) add("PLANNED_SECTION_LINEAGE_INCOMPLETE");
  const completed = input.steps.filter(
    (s) => s.status === "completed" && s.task !== "advance_plan",
  );
  for (const receipt of input.accepted_receipts)
    if (!completed.some((s) => s.id === receipt.step_id))
      add("UNEXPECTED_ACCEPTED_RECEIPT", { step_id: receipt.step_id });
  const accepted = new Map<string, GeneratedDeliveryReceipt>();
  for (const step of completed) {
    const receipt = input.accepted_receipts.find((r) => r.step_id === step.id);
    if (
      !receipt ||
      receipt.accepted !== true ||
      !receipt.receipt_id ||
      !receipt.verification_receipt_id
    ) {
      add("ACCEPTED_VERIFICATION_REQUIRED", { step_id: step.id });
      continue;
    }
    if (
      (await consistencyHash(receipt.candidate)) !==
        (await consistencyHash(step.output)) ||
      receipt.candidate_hash !==
        (await qualifierHash(JSON.stringify(receipt.candidate))) ||
      receipt.verification.checked_candidate_hash !== receipt.candidate_hash
    ) {
      add("ACCEPTED_CANDIDATE_MISMATCH", { step_id: step.id });
      continue;
    }
    try {
      const scope = taskInput({
        plan: { ...input.plan, stage: step.stage },
        step,
        steps: input.steps,
        requirements: input.requirements,
      });
      const evidence = receipt.evidence || [
        ...sources,
        ...scope.evidence.filter((e) => e.id === `proposal-review:${step.id}`),
      ];
      validateGroundingReport(
        receipt.verification,
        receipt.candidate,
        receipt.candidate_hash,
        evidence,
        scope.requiredIds,
        undefined,
        groundingOptions(scope.context, true),
      );
      if (groundingDefects(receipt.verification).length)
        throw new Error("KNOWN_GROUNDING_DEFECT");
      accepted.set(step.id, receipt);
    } catch {
      add("ACCEPTED_VERIFICATION_INVALID", { step_id: step.id });
    }
  }
  const draftSteps = completed.filter((s) => s.task === "draft_section");
  if (!draftSteps.length) add("GENERATED_RESPONSES_EMPTY");
  for (const step of draftSteps) {
    const section = input.sections.find(
      (s) => (s.key || s.section_key) === step.input?.section?.key,
    );
    if (!section) {
      add("GENERATED_SECTION_MISSING", { step_id: step.id });
      continue;
    }
    const text = sectionContent(section as any);
    if (
      !text.trim() ||
      consistencyText(text) === consistencyText(section.title || "") ||
      genericResponse(text) ||
      section.content_blocks.every(
        (b: Row) =>
          b.type === "heading" ||
          (b.type === "table" && !(b.rows || []).length),
      )
    )
      add("GENERATED_SECTION_EMPTY_OR_GENERIC", {
        section_key: section.key || section.section_key,
      });
  }
  const reviews = completed.filter((s) => s.task === "review_proposal");
  if (!reviews.length || reviews.some((s) => !accepted.has(s.id)))
    add("WHOLE_PROPOSAL_REVIEW_REQUIRED");
  if (
    input.plan.workflow_version >= 2 &&
    !reviews.some(
      (s) => s.input.coherence_review === true && accepted.has(s.id),
    )
  )
    add("CROSS_SECTION_RECONCILIATION_REQUIRED");
  if (
    reviews.some((s) =>
      (s.output.findings || []).some((f: Row) => f.severity === "blocking"),
    )
  )
    add("WHOLE_PROPOSAL_REVIEW_BLOCKING");
  const responses = reviews.flatMap((s) => s.output.responses || []);
  const coverage = input.requirements.map((r) => {
    const semantics = r.source_semantics;
    if (
      semantics?.review_status === "confirmed" &&
      semantics.authority_status === "confirmed" &&
      r.source_review_reason &&
      (semantics.modality === "informational" ||
        ["supplier_proposal", "company_evidence", "reference"].includes(
          semantics.authority_role,
        ))
    )
      return {
        requirement_id: r.id,
        status: "non_obligation" as const,
        section_keys: [],
      };
    const answering = draftSteps
      .filter(
        (s) => s.output.requirement_ids?.includes(r.id) && accepted.has(s.id),
      )
      .filter((step) => {
        const report = accepted.get(step.id)!.verification;
        const check = report.requirement_checks.find(
          (c: Row) => c.requirement_id === r.id && c.status === "supported",
        );
        const text = sectionContent(step.output as any);
        if (
          !check ||
          !has(text, check.candidate_quote) ||
          genericResponse(check.candidate_quote) ||
          sources.some((source) => has(source.text, check.candidate_quote))
        )
          return false;
        return report.claims.some(
          (claim: Row) =>
            claim.kind === "proposed_solution" &&
            claim.status === "supported" &&
            has(text, claim.candidate_quote) &&
            !genericResponse(claim.candidate_quote) &&
            !sources.some((source) => has(source.text, claim.candidate_quote)),
        );
      });
    const keys = answering.map((s) => s.input.section.key);
    const reviewed = responses.some(
      (rsp) =>
        rsp.requirement_id === r.id &&
        rsp.status === "answered" &&
        rsp.section_ids.some((key: string) => keys.includes(key)),
    );
    if (!keys.length || !reviewed)
      add("SUBSTANTIVE_RESPONSE_NOT_VERIFIED", { requirement_id: r.id });
    for (const quantity of semantics?.quantities || []) {
      const original = (r.source_refs || []).map((ref) => ref.quote).join("\n");
      if (
        !sourceQuantityInQuote(original, quantity) ||
        !answering.some((s) =>
          sourceQuantityInQuote(sectionContent(s.output as any), quantity),
        )
      )
        add("SOURCE_QUANTITY_RESPONSE_MISMATCH", { requirement_id: r.id });
    }
    if (
      !r.source_refs?.length ||
      r.source_refs.some(
        (ref) =>
          !sources.some((s) => s.id === ref.id && has(s.text, ref.quote)),
      )
    )
      add("REQUIREMENT_SOURCE_BINDING_INVALID", { requirement_id: r.id });
    if (
      semantics?.review_status !== "confirmed" ||
      semantics.authority_status !== "confirmed"
    )
      gaps.push({
        code: "SOURCE_MEANING_OR_AUTHORITY_REVIEW_REQUIRED",
        requirement_id: r.id,
      });
    return {
      requirement_id: r.id,
      status:
        keys.length && reviewed ? ("model_checked" as const) : ("gap" as const),
      section_keys: keys,
    };
  });
  if (!input.requirements.length)
    gaps.push({ code: "REQUIREMENT_INVENTORY_REVIEW_REQUIRED" });
  if (
    !Array.isArray(frozen.input_materials?.documents) ||
    frozen.input_materials.documents.some(
      (d: Row) =>
        d.used_for_draft === false || d.extraction_coverage?.complete === false,
    )
  )
    gaps.push({ code: "INPUT_COVERAGE_REVIEW_REQUIRED" });
  for (const question of assembled?.questions || [])
    if (question.blocking_level !== "advisory")
      gaps.push({ code: "FINALIZATION_INPUT_REQUIRED" });
  gaps.push({ code: "AUTHORIZED_FINAL_PROPOSAL_REVIEW_REQUIRED" });
  const descriptions: Record<string, string> = {
    SOURCE_MEANING_OR_AUTHORITY_REVIEW_REQUIRED:
      "Review the authority and meaning of the buyer source before final approval.",
    INPUT_COVERAGE_REVIEW_REQUIRED:
      "Some source material remains unread or incomplete; review its effect before approval.",
    REQUIREMENT_INVENTORY_REVIEW_REQUIRED:
      "Confirm the requirement inventory against the original input.",
    FINALIZATION_INPUT_REQUIRED:
      "Resolve the identified proposal inputs and commitments before final approval.",
    AUTHORIZED_FINAL_PROPOSAL_REVIEW_REQUIRED:
      "An authorized person must review this exact proposal and its supporting evidence before final approval.",
  };
  for (const gap of gaps)
    gap.detail =
      descriptions[gap.code] || gap.code.toLowerCase().replaceAll("_", " ");
  for (const blocker of blockers) {
    blocker.detail = blocker.code.toLowerCase().replaceAll("_", " ");
    blocker.paths = blocker.step_id
      ? [`$.steps[${JSON.stringify(blocker.step_id)}]`]
      : blocker.requirement_id
        ? [`$.requirements[${JSON.stringify(blocker.requirement_id)}]`]
        : ["$.sections"];
  }
  return {
    version: 1,
    policy: "generated-delivery-v1",
    input_hash: await consistencyHash({
      plan_id: input.plan.id,
      input_hash: input.plan.input_hash,
      sections: input.sections,
      section_outline: input.section_outline,
      requirements: input.requirements,
      receipts: input.accepted_receipts.map((r) => ({
        receipt_id: r.receipt_id,
        verification_receipt_id: r.verification_receipt_id,
        candidate_hash: r.candidate_hash,
      })),
    }),
    machine_eligible: blockers.length === 0,
    substantive_complete: false,
    approval_state: "draft",
    assurance: "model_checked_source_review_required",
    receipt_ids: input.accepted_receipts.map((r) => r.receipt_id),
    verification_receipt_ids: input.accepted_receipts.map(
      (r) => r.verification_receipt_id,
    ),
    coverage,
    blockers,
    human_gaps: gaps,
  };
}
