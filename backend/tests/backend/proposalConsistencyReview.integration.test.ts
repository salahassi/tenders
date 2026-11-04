// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
import {
  reviewProposalConsistency,
  proposalConsistencyReviewSchema,
} from "../../supabase/functions/_shared/proposalConsistencyReview";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup() {
  const s = await commercialHelpers(f).setup();
  const { opportunity_id: opp } = (
    await f.db.query<any>(
      "select opportunity_id from public.proposals where id=$1",
      [s.proposal],
    )
  ).rows[0];
  const notice = (
    await f.db.query<any>(
      "select app_private.content_record($1,'notice',$2) value",
      [f.w, opp],
    )
  ).rows[0].value;
  await f.command("source.authority.review", {
    opportunity_id: opp,
    entity_kind: "notice",
    entity_id: opp,
    content_hash: notice.content_hash,
    expected_revision: 0,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Synthetic explicit buyer source authority.",
  });
  const source = (
    await f.db.query<any>(
      "select app_private.source_review_sources($1,$2)->0 value",
      [f.w, opp],
    )
  ).rows[0].value;
  const span = (
    await f.db.query<any>(
      "select app_private.source_span_from_block($1::jsonb,0,$2) value",
      [JSON.stringify(source), Array.from(source.text).length],
    )
  ).rows[0].value;
  const review = await f.command("source.obligation.review", {
    opportunity_id: opp,
    expected_revision: 0,
    spans: [span],
    semantics: {
      modality: "required",
      actor: "supplier",
      negated: false,
      conditions: [],
      exceptions: [],
      consequences: [],
      quantities: [],
      dates: [],
    },
    status: "confirmed",
    reason: "Synthetic reviewed buyer obligation meaning.",
  });
  const inventory = (
    await f.db.query<any>(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[])->0 value",
      [f.w, opp, [review.review_id]],
    )
  ).rows[0].value;

  const body =
    "We configure the approval workflow with the buyer team. Deliver the configured workflow and manual. Acceptance requires the signed workflow test.";
  await f.db.query(
    "update public.proposal_sections set body=$2,content_blocks=$3::jsonb,requirement_ids=$4::jsonb where proposal_version_id=$1",
    [
      s.version,
      body,
      JSON.stringify([{ type: "paragraph", text: body }]),
      JSON.stringify([s.requirement]),
    ],
  );
  const frozen = {
    proposal_consistency_version: 1,
    source_contract_version: 1,
    source_evidence: { version: 1, spans: [span], reviews: [] },
    notice: source,
    blocks: [],
    knowledge: [],
    reviews: [],
    rates: [],
    input_materials: { documents: [] },
  };
  await f.db.query(
    "update public.generation_plans set frozen_context=$2::jsonb,evidence_revision=(select evidence_revision from public.workspaces where id=$3) where id=$1",
    [s.plan, JSON.stringify(frozen), f.w],
  );
  await f.db.query(
    "update public.requirements set text=$2,source_refs=$3::jsonb,source_semantics=$4::jsonb where id=$1",
    [
      s.requirement,
      inventory.text,
      JSON.stringify(inventory.source_refs),
      JSON.stringify(inventory.source_semantics),
    ],
  );
  await f.db.query(
    "update public.proposal_versions set evidence_revision=(select evidence_revision from public.workspaces where id=$2) where id=$1",
    [s.version, f.w],
  );
  const ctx = await f.rpc("proposal_consistency_context", [s.version]);
  const input = proposalConsistencyReviewSchema.parse({
    expected_revision: ctx.version_revision,
    binding_hash: ctx.binding_hash,
    reason:
      "I reviewed the method, deliverable, acceptance and source conditions for this exact response.",
    reviewed_requirement_ids: [s.requirement],
    confirmed_decision_ids: [],
    fulfillment: [
      {
        requirement_id: s.requirement,
        response_section_key: "approach",
        response_excerpt: body,
        method: "We configure the approval workflow with the buyer team",
        deliverable: "Deliver the configured workflow and manual",
        acceptance_evidence: "Acceptance requires the signed workflow test",
        conditions_preserved: [],
        exceptions_preserved: [],
        consequences_preserved: [],
        facts: [],
      },
    ],
  });
  const computed = await reviewProposalConsistency(ctx, input, f.owner);
  return {
    ...s,
    calculation_input: s.input,
    opp,
    ctx,
    input,
    computed,
    review,
  };
}
async function commit(
  s: Awaited<ReturnType<typeof setup>>,
  key = "synthetic-consistency",
  actor = f.owner,
) {
  return f.rpc("complete_proposal_consistency", [
    s.version,
    actor,
    s.input.expected_revision,
    s.input.binding_hash,
    JSON.stringify(s.input),
    key,
    JSON.stringify(s.computed.report),
    JSON.stringify(s.computed.review),
  ]);
}
async function attempt(action: () => Promise<any>) {
  await f.db.exec("savepoint attempt");
  try {
    return await action();
  } catch (e) {
    await f.db.exec("rollback to savepoint attempt");
    throw e;
  } finally {
    await f.db.exec("release savepoint attempt");
  }
}
it("actual source-review inventory and response close the new gate while preserving commercial blockers", async () => {
  const s = await setup();
  expect(s.computed.report.coverage[0].missing_fields).toEqual([]);
  expect(s.computed.report.diagnostics).toEqual([]);
  expect(
    (await f.rpc("proposal_readiness", [s.version])).consistency_complete,
  ).toBe(false);
  const result = await commit(s);
  expect(result.report.substantive_complete).toBe(true);
  const gate = await f.rpc("proposal_readiness", [s.version]);
  expect(gate.consistency_complete).toBe(true);
  expect(gate.blockers).toContain(
    "Approve the latest complete, current financial estimate.",
  );
});
it("idempotent same-body replay returns one review/audit and changed body conflicts", async () => {
  const s = await setup(),
    first = await commit(s);
  expect(await commit(s)).toEqual(first);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='proposal.consistency.reviewed'",
      )
    ).rows[0].n,
  ).toBe(1);
  s.input.reason += " Changed";
  await expect(attempt(() => commit(s))).rejects.toThrow(
    "IDEMPOTENCY_CONFLICT",
  );
});
it.each(["body", "source", "membership", "revision"])(
  "rejects %s change between service assessment and commit",
  async (kind) => {
    const s = await setup();
    if (kind === "body")
      await f.db.query(
        'update public.proposal_sections set content_blocks=\'[{"type":"paragraph","text":"Changed response"}]\' where proposal_version_id=$1',
        [s.version],
      );
    if (kind === "source")
      await f.db.query(
        "update public.opportunities set description='Changed buyer scope' where id=$1",
        [s.opp],
      );
    if (kind === "membership")
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    if (kind === "revision")
      await f.db.query(
        "update public.proposal_versions set revision=revision+1 where id=$1",
        [s.version],
      );
    await expect(attempt(() => commit(s))).rejects.toThrow(
      kind === "membership"
        ? "ROLE_FORBIDDEN"
        : kind === "revision"
          ? "REVISION_CONFLICT"
          : "STALE_INPUT",
    );
    expect(
      (
        await f.db.query<any>(
          "select consistency_report from public.proposal_versions where id=$1",
          [s.version],
        )
      ).rows[0].consistency_report,
    ).toBeNull();
  },
);
it("source revocation and reviewer deactivation invalidate an already accepted report at readiness", async () => {
  const s = await setup();
  await commit(s);
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  const gate = (
    await f.db.query<any>("select app_private.approval_gate($1,$2) value", [
      f.w,
      s.version,
    ])
  ).rows[0].value;
  expect(gate.consistency_complete).toBe(false);
});
it("a partial or source-restatement report remains a draft even after human attestation", async () => {
  const s = await setup();
  s.input.fulfillment[0].deliverable = "Absent from the actual proposal";
  s.computed = await reviewProposalConsistency(s.ctx, s.input, f.owner);
  expect(s.computed.report.substantive_complete).toBe(false);
  expect((await commit(s)).report.substantive_complete).toBe(false);
  expect(
    (await f.rpc("proposal_readiness", [s.version])).consistency_complete,
  ).toBe(false);
});
it("browser roles cannot submit trusted reports or invoke private delegates", async () => {
  const privileges = await f.db.query<any>(
    "select has_function_privilege('authenticated','public.complete_proposal_consistency(uuid,uuid,integer,text,jsonb,text,jsonb,jsonb)','EXECUTE') allowed,has_function_privilege('authenticated','app_private.proposal_consistency_data(uuid,uuid)','EXECUTE') internal",
  );
  expect(privileges.rows[0]).toEqual({ allowed: false, internal: false });
  const s = await setup();
  await f.db.exec("set role authenticated");
  await expect(attempt(() => commit(s))).rejects.toThrow("permission denied");
  await f.db.exec("reset role");
});
it("fails closed on null revision/hash/report and cannot forge an empty complete coverage", async () => {
  const s = await setup();
  s.computed.report.coverage = [];
  s.computed.report.substantive_complete = true;
  await expect(attempt(() => commit(s))).rejects.toThrow(
    "CONSISTENCY_REPORT_INVALID",
  );
  s.input.expected_revision = null as any;
  await expect(attempt(() => commit(s))).rejects.toThrow("REVISION_CONFLICT");
});
it("permits actual final approval only after scoped substantive review and all existing commercial/coverage gates", async () => {
  const s = await setup(),
    helper = commercialHelpers(f);
  const estimate = await helper.calculate({ ...s, input: s.calculation_input }),
    delivery = await helper.calculate(
      { ...s, input: s.calculation_input },
      "delivery",
    );
  await f.command("estimate.approve", {
    id: estimate.id,
    expected_revision: estimate.revision,
  });
  await f.command("delivery.approve", {
    id: delivery.id,
    expected_revision: delivery.revision,
  });
  await f.command("inventory.confirm", {
    proposal_version_id: s.version,
    expected_revision: 1,
  });
  await f.command("compliance.save", {
    proposal_version_id: s.version,
    requirement_id: s.requirement,
    expected_revision: 0,
    status: "answered",
    section_keys: ["approach"],
    evidence_refs: [],
    rationale: "Synthetic complete response and evidence reviewed.",
  });
  s.ctx = await f.rpc("proposal_consistency_context", [s.version]);
  s.input.binding_hash = s.ctx.binding_hash;
  s.computed = await reviewProposalConsistency(s.ctx, s.input, f.owner);
  const saved = await commit(s);
  expect((await f.rpc("proposal_readiness", [s.version])).blockers).toEqual([]);
  const approved = await f.command("proposal.approve", {
    proposal_version_id: s.version,
    expected_revision: saved.version_revision,
    reason:
      "Owner verified the precise current content, sources, response and Decimal calculations.",
  });
  expect(approved.proposal_version_id).toBe(s.version);
  await f.db.query(
    'update public.proposal_sections set content_blocks=\'[{"type":"paragraph","text":"Changed commitment"}]\' where proposal_version_id=$1',
    [s.version],
  );
  expect(
    (await f.rpc("proposal_readiness", [s.version])).consistency_complete,
  ).toBe(false);
});
it("a later calculation invalidates the assessment before its service commit", async () => {
  const s = await setup();
  await commercialHelpers(f).calculate({ ...s, input: s.calculation_input });
  await expect(attempt(() => commit(s))).rejects.toThrow("STALE_INPUT");
});
it("does not replay a superseded response review as if it were the currently saved review", async () => {
  const s = await setup();
  const first = await commit(s);
  const previous = { ...s, input: { ...s.input } };
  s.input.expected_revision = first.version_revision;
  s.input.reason += " A second scoped review.";
  s.ctx = await f.rpc("proposal_consistency_context", [s.version]);
  s.computed = await reviewProposalConsistency(s.ctx, s.input, f.owner);
  await commit(s, "second");
  await expect(attempt(() => commit(previous))).rejects.toThrow(
    "REVISION_CONFLICT",
  );
});
