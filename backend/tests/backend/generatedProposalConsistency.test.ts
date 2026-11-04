// @vitest-environment node
import { expect, it } from "vitest";
import {
  assessGeneratedDelivery,
  type GeneratedDeliveryInput,
} from "../../supabase/functions/_shared/generatedProposalConsistency";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency";
async function fixture(
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
    id: "plan",
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
      id: "plan-step",
      task: "plan_proposal",
      stage: "planning",
      ordinal: 0,
      status: "completed",
      input: { requirement_ids: [req] },
      output: { sections: [section], questions: [] },
    },
    {
      id: "draft-step",
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
      id: "commercial-step",
      task: "plan_commercial",
      stage: "commercial",
      ordinal: 2,
      status: "completed",
      input: { requirement_ids: [] },
      output: { lines: [], tasks: [], questions: [] },
    },
    {
      id: "review-step",
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
it("issues a model-checked draft without inventing human meaning review or final approval", async () => {
  const report = await assessGeneratedDelivery(await fixture());
  expect(report.blockers).toEqual([]);
  expect(report.machine_eligible).toBe(true);
  expect(report.substantive_complete).toBe(false);
  expect(report.approval_state).toBe("draft");
  expect(
    report.human_gaps.some(
      (g) => g.code === "SOURCE_MEANING_OR_AUTHORITY_REVIEW_REQUIRED",
    ),
  ).toBe(true);
});
it("does not infer complete proposal from saved bytes when an accepted verifier receipt is absent", async () => {
  const f = await fixture();
  f.accepted_receipts = f.accepted_receipts.filter(
    (r) => r.step_id !== "draft-step",
  );
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "ACCEPTED_VERIFICATION_REQUIRED",
    ),
  ).toBe(true);
});
it.each([
  "Provide a workflow in 30 days.",
  "We comply with all requirements.",
  "Approach",
])(
  "blocks source restatement/generic/headings despite answered model labels: %s",
  async (body) => {
    expect(
      (await assessGeneratedDelivery(await fixture(body))).machine_eligible,
    ).toBe(false);
  },
);
it("rejects changed draft content, missing planned lineage and a stale verified candidate", async () => {
  const f = await fixture();
  f.sections[0].body += " Changed";
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "GENERATED_ASSEMBLY_MISMATCH",
    ),
  ).toBe(true);
  const another = await fixture();
  another.section_outline = null;
  expect((await assessGeneratedDelivery(another)).machine_eligible).toBe(false);
  const stale = await fixture();
  stale.accepted_receipts[1].candidate_hash = "f".repeat(64);
  expect(
    (await assessGeneratedDelivery(stale)).blockers.some(
      (b) => b.code === "ACCEPTED_CANDIDATE_MISMATCH",
    ),
  ).toBe(true);
});
it("blocks the known 30 days versus 30 months mismatch even when the verifier incorrectly marks it supported", async () => {
  const report = await assessGeneratedDelivery(
    await fixture(
      "Configure the workflow in 30 months. Deliver the tested workflow and manual. Buyer acceptance uses the signed workflow test.",
    ),
  );
  expect(
    report.blockers.some((b) => b.code === "SOURCE_QUANTITY_RESPONSE_MISMATCH"),
  ).toBe(true);
});
it("does not bypass a validated blocking cross-section review finding", async () => {
  const f = await fixture();
  f.steps.at(-1)!.output.findings = [
    {
      severity: "blocking",
      code: "CONFLICT",
      detail: "Known contradiction",
      requirement_ids: [],
      section_ids: ["approach"],
    },
  ];
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "WHOLE_PROPOSAL_REVIEW_BLOCKING",
    ),
  ).toBe(true);
});
it("requires a final cross-section reconciliation receipt for semantic workflows", async () => {
  const f = await fixture();
  f.plan.workflow_version = 2;
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "CROSS_SECTION_RECONCILIATION_REQUIRED",
    ),
  ).toBe(true);
});
