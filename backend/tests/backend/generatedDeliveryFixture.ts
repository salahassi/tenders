import type { GeneratedDeliveryInput } from "../../supabase/functions/_shared/generatedProposalConsistency";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency";
export async function generatedDeliveryFixture(
  body = "Configure the workflow in 30 days. Deliver the tested workflow and manual. Buyer acceptance uses the signed workflow test.",
) {
  const req = "00000000-0000-4000-8000-000000000001",
    buyer = {
      id: "buyer",
      text: "Provide a workflow in 30 days.",
      kind: "rfp",
      verified: false,
      reference: {
        entity_kind: "document",
        entity_id: "00000000-0000-4000-8000-000000000002",
        content_hash: "a".repeat(64),
      },
    };
  const section = {
    key: "approach",
    title: "Approach",
    volume: "technical",
    requirement_ids: [req],
  };
  const plan = {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "proposal",
    stage: "completed",
    status: "completed",
    workflow_version: 1,
    input_hash: "b".repeat(64),
    frozen_context: {
      proposal_consistency_version: 1,
      language: "en",
      title: "Workflow",
      notice: {
        ...buyer,
        id: "notice",
        kind: "notice",
        text: "Workflow opportunity.",
      },
      blocks: [buyer],
      knowledge: [],
      reviews: [],
      rates: [],
      template: {
        required_sections: [],
        fixed_blocks: [],
        volume_mode: "combined",
      },
      input_materials: {
        documents: [
          { used_for_draft: true, extraction_coverage: { complete: true } },
        ],
      },
    },
  };
  const requirements = [
    {
      id: req,
      text: buyer.text,
      mandatory: true,
      category: "functional",
      source_refs: [{ id: buyer.id, quote: buyer.text }],
      source_semantics: {
        version: 1 as const,
        source_span_ids: ["span"],
        authority_role: "unknown",
        authority_status: "unconfirmed",
        modality: "required",
        actor: "supplier",
        negated: false,
        conditions: [],
        exceptions: [],
        consequences: [],
        quantities: [{ value: "30", unit: "days" }],
        review_status: "pending",
        review_id: null,
      },
    },
  ];
  const steps = [
    {
      id: "20000000-0000-4000-8000-000000000001",
      task: "plan_proposal",
      stage: "planning",
      ordinal: 0,
      status: "completed",
      input: { requirement_ids: [req] },
      output: { sections: [section], questions: [] },
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      task: "draft_section",
      stage: "drafting",
      ordinal: 1,
      depth: 0,
      status: "completed",
      input: { section, requirement_ids: [req] },
      output: {
        key: section.key,
        title: section.title,
        content_blocks: [{ type: "paragraph", text: body }],
        requirement_ids: [req],
        evidence_refs: [],
        company_claims: [],
        assumptions: [],
        questions: [],
      },
    },
    {
      id: "20000000-0000-4000-8000-000000000003",
      task: "plan_commercial",
      stage: "commercial",
      ordinal: 2,
      status: "completed",
      input: { requirement_ids: [] },
      output: { lines: [], tasks: [], questions: [] },
    },
    {
      id: "20000000-0000-4000-8000-000000000004",
      task: "review_proposal",
      stage: "review",
      ordinal: 3,
      status: "completed",
      input: { requirement_ids: [req] },
      output: {
        processed_requirement_ids: [req],
        responses: [
          {
            requirement_id: req,
            status: "answered",
            section_ids: ["approach"],
            evidence_refs: [],
            rationale:
              "The proposed method, delivery and acceptance respond to this workflow obligation.",
          },
        ],
        findings: [],
      },
    },
  ];
  const ctx: any = {
    plan: { ...plan, stage: "review" },
    step: { task: "advance_plan", input: {} },
    steps,
    requirements,
  };
  const final = (await nextStage(ctx)).final_result!;
  const accepted_receipts = [];
  for (const step of steps) {
    const candidate = step.output,
      units = candidateContent(candidate),
      scope = taskInput({ ...ctx, plan: { ...plan, stage: step.stage }, step });
    const hash = await qualifierHash(JSON.stringify(candidate));
    const quote = step.task === "draft_section" ? body : units[0]?.text || "";
    accepted_receipts.push({
      step_id: step.id,
      receipt_id: crypto.randomUUID(),
      verification_receipt_id: crypto.randomUUID(),
      candidate_hash: hash,
      candidate,
      accepted: true as const,
      verification: {
        checked_candidate_hash: hash,
        reviewed_all_content: true,
        processed_content_ids: units.map((u) => u.id),
        claims: units.length
          ? [
              {
                id: "claim",
                claim: quote,
                candidate_quote: quote,
                kind: "proposed_solution",
                status: "supported",
                source_refs: [],
                finding: "Proposed work is represented in the candidate.",
              },
            ]
          : [],
        processed_requirement_ids: scope.requiredIds,
        requirement_checks: scope.requiredIds.map((id) => ({
          requirement_id: id,
          status: "supported",
          candidate_quote: quote,
          source_refs: [],
          finding: "The proposed response covers this requirement.",
        })),
        findings: [],
      },
    });
  }
  return {
    plan,
    steps,
    requirements,
    sections: final.sections,
    section_outline: final.section_outline,
    accepted_receipts,
  } as GeneratedDeliveryInput;
}
