// @vitest-environment node
import { expect, it } from "vitest";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency";
import {
  nextStage,
  taskInput,
} from "../../supabase/functions/_shared/generation";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { assessGeneratedDelivery } from "../../supabase/functions/_shared/generatedProposalConsistency";
import { generatedDeliveryFixture as fixture } from "./generatedDeliveryFixture";

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
    (r) => r.step_id !== "20000000-0000-4000-8000-000000000002",
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

async function missingCertificateFixture(
  options: {
    method?: boolean;
    omitted?: boolean;
    contradiction?: boolean;
  } = {},
) {
  const method =
    "Configure the workflow in 30 days. Deliver the tested workflow and manual. Buyer acceptance uses the signed workflow test.";
  const placeholder = "[INPUT REQUIRED: current company certificate evidence]";
  const actual =
    options.method === false ? "Provide a workflow in 30 days." : method;
  const f = await fixture(`${actual} ${placeholder}`);
  const draft = f.steps.find((s) => s.task === "draft_section")!;
  draft.output.assumptions = [placeholder];
  draft.output.questions = [
    {
      question:
        "Supply current company certificate evidence before final approval.",
      requirement_ids: [f.requirements[0].id],
      blocking_level: "finalization",
    },
  ];
  if (options.omitted) draft.output.requirement_ids = [];
  const review = f.steps.find((s) => s.task === "review_proposal")!;
  review.output.responses[0].status = "clarification_required";
  for (const receipt of f.accepted_receipts) {
    receipt.candidate_hash = await qualifierHash(
      JSON.stringify(receipt.candidate),
    );
    receipt.verification.checked_candidate_hash = receipt.candidate_hash;
    receipt.verification.processed_content_ids = candidateContent(
      receipt.candidate,
    ).map((c) => c.id);
    if (receipt.step_id === draft.id) {
      receipt.verification.claims = [
        {
          id: "method",
          claim: actual,
          candidate_quote: actual,
          kind: "proposed_solution",
          status: "supported",
          source_refs: [],
          finding:
            "The concrete proposed method and output remain in this response.",
        },
        {
          id: "missing-certificate",
          claim: placeholder,
          candidate_quote: placeholder,
          kind: "assumption",
          status: options.contradiction ? "contradicted" : "insufficient",
          source_refs: [],
          finding:
            "No current company certificate was supplied; this does not establish absence of company capability.",
        },
      ];
    }
  }
  const final = (
    await nextStage({
      plan: { ...f.plan, stage: "reconciliation" },
      step: { task: "advance_plan", input: {} },
      steps: f.steps,
      requirements: f.requirements,
    } as any)
  ).final_result!;
  f.sections = final.sections;
  f.section_outline = final.section_outline;
  return f;
}
it("issues a concrete reviewed response with an exact requirement-bound missing company certificate and visible gap", async () => {
  const report = await assessGeneratedDelivery(
    await missingCertificateFixture(),
  );
  expect(report.blockers).toEqual([]);
  expect(report.machine_eligible).toBe(true);
  expect(report.coverage[0].status).toBe("model_checked_with_gap");
  expect(report.human_gaps).toContainEqual({
    code: "COMPANY_EVIDENCE_INPUT_REQUIRED",
    requirement_id: "00000000-0000-4000-8000-000000000001",
    detail: "[INPUT REQUIRED: current company certificate evidence]",
  });
  expect(report.substantive_complete).toBe(false);
});
it.each([{ method: false }, { omitted: true }, { contradiction: true }])(
  "does not use an input placeholder to hide a missing method, omitted requirement or known contradiction: %j",
  async (options) => {
    expect(
      (await assessGeneratedDelivery(await missingCertificateFixture(options)))
        .machine_eligible,
    ).toBe(false);
  },
);
it("rejects a partial review with no exact question/assumption lineage to the requirement", async () => {
  const f = await missingCertificateFixture();
  f.steps.find(
    (s) => s.task === "draft_section",
  )!.output.questions[0].requirement_ids = [];
  const receipt = f.accepted_receipts[1];
  receipt.candidate_hash = await qualifierHash(
    JSON.stringify(receipt.candidate),
  );
  receipt.verification.checked_candidate_hash = receipt.candidate_hash;
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "SUBSTANTIVE_RESPONSE_NOT_VERIFIED",
    ),
  ).toBe(true);
});
it("binds actual service version volume semantics to the reconstructed assembly", async () => {
  const f = await fixture();
  f.version = { separate_volumes: true };
  expect(
    (await assessGeneratedDelivery(f)).blockers.some(
      (b) => b.code === "GENERATED_ASSEMBLY_MISMATCH",
    ),
  ).toBe(true);
});

it("does not turn a source echo into a proposed method by attaching an input marker to its verifier quote", async () => {
  const f = await missingCertificateFixture({ method: false });
  const receipt = f.accepted_receipts[1];
  receipt.verification.claims[0].candidate_quote =
    f.steps[1].output.content_blocks[0].text;
  receipt.verification.claims[0].claim =
    receipt.verification.claims[0].candidate_quote;
  expect((await assessGeneratedDelivery(f)).machine_eligible).toBe(false);
});
it("does not promote omitted or partial company discovery into verified claim evidence during issuance", async () => {
  const claim = "The company maintains a current quality certificate.";
  const f = await fixture(
    `Configure the workflow in 30 days. Deliver the tested workflow and manual. Buyer acceptance uses the signed workflow test. ${claim}`,
  );
  f.plan.frozen_context.company_retrieval_version = 1;
  f.plan.frozen_context.company_followup_version = 1;
  f.plan.frozen_context.knowledge = [
    {
      id: "company-certificate",
      kind: "company",
      verified: true,
      text:
        claim +
        "\n\n" +
        "Other retained company context with qualifications. ".repeat(2000),
      reference: {
        entity_kind: "document",
        entity_id: "00000000-0000-4000-8000-000000000009",
        content_hash: "c".repeat(64),
      },
    },
  ];
  f.accepted_receipts[1].verification.claims.push({
    id: "certificate",
    claim,
    candidate_quote: claim,
    kind: "company_fact",
    status: "supported",
    source_refs: [{ id: "company-certificate", quote: claim }],
    finding: "Purported supported claim despite incomplete selected evidence.",
  });
  const scope = taskInput({
    plan: { ...f.plan, stage: "drafting" },
    step: f.steps[1],
    steps: f.steps,
    requirements: f.requirements,
  } as any);
  expect(
    scope.evidence.some((e) => e.id === "company-certificate" && e.verified),
  ).toBe(false);
  const final = (
    await nextStage({
      plan: { ...f.plan, stage: "reconciliation" },
      step: { task: "advance_plan", input: {} },
      steps: f.steps,
      requirements: f.requirements,
    } as any)
  ).final_result!;
  f.sections = final.sections;
  f.section_outline = final.section_outline;
  expect((await assessGeneratedDelivery(f)).blockers).toContainEqual(
    expect.objectContaining({
      code: "ACCEPTED_VERIFICATION_INVALID",
      step_id: f.steps[1].id,
    }),
  );
});
