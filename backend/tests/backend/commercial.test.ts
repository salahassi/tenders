import { calculateEstimate } from "../../supabase/functions/_shared/finance";
// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { commercialHelpers } from "./commercialFixture";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup() {
  return commercialHelpers(f).setup();
}
async function calculate(
  s: Awaited<ReturnType<typeof setup>>,
  kind = "estimate",
) {
  return commercialHelpers(f).calculate(s, kind);
}

it("records decimal calculations and their rate versions through a service-only completion", async () => {
  const s = await setup(),
    estimate = await calculate(s);
  expect(estimate.calculated.gross_total).toBe("15180.00000000");
  expect(estimate.status).toBe("ready");
  expect(
    (await f.db.query("select * from public.estimate_lines")).rows,
  ).toHaveLength(1);
  await f.db.exec("set role authenticated");
  await expect(
    f.rpc("complete_calculation", [
      estimate.id,
      "estimate",
      f.owner,
      estimate.input_hash,
      "a".repeat(64),
      "{}",
    ]),
  ).rejects.toThrow("permission denied");
});
it("rejects a changed approved rate between calculation and commit", async () => {
  const s = await setup(),
    pending = await f.command("estimate.prepare", {
      proposal_version_id: s.version,
      expected_revision: 1,
      input: s.input,
    }),
    context = await f.rpc("calculation_context", [pending.id, "estimate"]);
  const computed = calculateEstimate(context.record.input, context.rates);
  await f.command("rate.save", {
    id: s.rate.id,
    expected_revision: s.rate.revision,
    title: "Changed rate",
    unit: "day",
    currency: "SAR",
    unit_cost: "2000",
    zero_confirmed: false,
    valid_from: "2020-01-01",
    valid_until: "2099-01-01",
    source_reference: "Changed synthetic source",
    public_approved: true,
  });
  await expect(
    f.rpc("complete_calculation", [
      pending.id,
      "estimate",
      f.owner,
      pending.input_hash,
      context.rates_hash,
      JSON.stringify(computed),
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("binds Owner approval to inventory, compliance, prices, delivery and review state", async () => {
  const s = await setup();
  expect(
    (await f.rpc("proposal_readiness", [s.version])).blockers.length,
  ).toBeGreaterThan(0);
  const estimate = await calculate(s),
    delivery = await calculate(s, "delivery");
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
    rationale: "The implementation response addresses this requirement.",
  });
  expect((await f.rpc("proposal_readiness", [s.version])).blockers).toEqual([]);
  const approval = await f.command("proposal.approve", {
    proposal_version_id: s.version,
    expected_revision: 1,
    reason: "Owner reviewed the exact content, evidence and calculations.",
  });
  expect(approval.content_hash).toBe("a".repeat(64));
  expect(approval.pricing_hash).toBe(estimate.content_hash);
  const revision = (
    await f.db.query<any>(
      "select revision from public.proposal_versions where id=$1",
      [s.version],
    )
  ).rows[0].revision;
  const exported = await f.command("export.prepare", {
    proposal_version_id: s.version,
    expected_revision: revision,
    mode: "final",
    volume: "combined",
  });
  const artifact = await f.command("export.reserve", {
    export_id: exported.id,
    kind: "generated",
    original_name: "synthetic.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 100,
    hash: "c".repeat(64),
    review_attested: false,
  });
  await f.db.exec("savepoint export_attempt");
  await expect(
    f.rpc("complete_export_artifact", [
      artifact.id,
      f.owner,
      "d".repeat(64),
      100,
      "generated_content",
    ]),
  ).rejects.toThrow("ARTIFACT_MISMATCH");
  await f.db.exec(
    "rollback to savepoint export_attempt; release savepoint export_attempt",
  );
  await f.rpc("complete_export_artifact", [
    artifact.id,
    f.owner,
    "c".repeat(64),
    100,
    "generated_content",
  ]);
  expect(
    (
      await f.rpc("authorize_artifact_download", [
        artifact.id,
        f.owner,
        "c".repeat(64),
      ])
    ).status,
  ).toBe("ready");
  expect(
    (await f.db.query("select * from public.submissions")).rows,
  ).toHaveLength(0);
  const submitted = await f.command("submission.record", {
    proposal_version_id: s.version,
    expected_revision: revision,
    artifact_ids: [artifact.id],
    submitted_at: new Date().toISOString(),
    channel: "Manual portal",
    external_reference: "SYNTHETIC-1",
  });
  expect(submitted.artifact_verification).toBe("final_artifact_unverified");
  await f.command("submission.event", {
    id: submitted.id,
    expected_revision: 1,
    event_type: "correction",
    occurred_at: new Date().toISOString(),
    reason: "Correct the synthetic external reference.",
    correction: { external_reference: "SYNTHETIC-2" },
  });
  expect(
    (await f.db.query<any>("select external_reference from public.submissions"))
      .rows[0].external_reference,
  ).toBe("SYNTHETIC-1");
  await f.command("submission.event", {
    id: submitted.id,
    expected_revision: 2,
    event_type: "won",
    occurred_at: new Date().toISOString(),
    reason: "Synthetic outcome received manually.",
  });
  await expect(
    f.command("submission.event", {
      id: submitted.id,
      expected_revision: 3,
      event_type: "lost",
      occurred_at: new Date().toISOString(),
      reason: "Invalid second terminal result.",
    }),
  ).rejects.toThrow("INVALID_TRANSITION");
  await f.command("review.verdict", {
    proposal_version_id: s.version,
    expected_revision: 0,
    verdict: "changes_requested",
    comment: "Recheck an assumption.",
  });
  expect(
    (await f.db.query<any>("select invalidated_at from public.approvals"))
      .rows[0].invalidated_at,
  ).not.toBeNull();
  expect(
    (await f.db.query<any>("select state from public.proposals")).rows[0].state,
  ).toBe("draft");
  await f.db.exec("savepoint stale_export");
  await expect(
    f.rpc("authorize_artifact_download", [
      artifact.id,
      f.owner,
      "c".repeat(64),
    ]),
  ).rejects.toThrow("STALE_EXPORT_APPROVAL");
  await f.db.exec(
    "rollback to savepoint stale_export; release savepoint stale_export",
  );
  expect(
    (await f.db.query<any>("select state from public.submissions")).rows[0]
      .state,
  ).toBe("won");
  await expect(
    f.command("submission.record", {
      proposal_version_id: s.version,
      expected_revision: (
        await f.db.query<any>(
          "select revision from public.proposal_versions where id=$1",
          [s.version],
        )
      ).rows[0].revision,
      artifact_ids: [artifact.id],
      submitted_at: new Date().toISOString(),
      channel: "Manual portal",
      external_reference: "STALE-ATTEMPT",
    }),
  ).rejects.toThrow("STALE_EXPORT_APPROVAL");
  expect(
    (await f.rpc("proposal_readiness", [s.version])).blockers.join(" "),
  ).toContain("reviewer");
});
it("does not allow mandatory credentials to be waived or asserted without evidence", async () => {
  const s = await setup();
  await f.db.query(
    "update public.requirements set category='eligibility' where id=$1",
    [s.requirement],
  );
  const input = {
    proposal_version_id: s.version,
    requirement_id: s.requirement,
    expected_revision: 0,
    status: "not_applicable_approved",
    section_keys: [],
    evidence_refs: [],
    rationale: "Synthetic attempt to bypass mandatory credential.",
  };
  await expect(f.command("compliance.save", input)).rejects.toThrow(
    "MANDATORY_CREDENTIAL_CANNOT_BE_WAIVED",
  );
  await expect(
    f.command("compliance.save", {
      ...input,
      status: "answered",
      section_keys: ["approach"],
    }),
  ).rejects.toThrow("VERIFIED_CREDENTIAL_EVIDENCE_REQUIRED");
});

it("tracks acquisition and related notices without payment or generation", async () => {
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  const opp = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic acquisition",
    reference: "A1",
    decision: "shortlisted",
  });
  let a = await f.command("acquisition.transition", {
    opportunity_id: opp.id,
    expected_revision: 0,
    state: "requested",
    method: "paid_manual",
    fee: "10",
    currency: "SAR",
    note: "Request the eligible public RFP manually.",
  });
  await expect(
    f.command("acquisition.transition", {
      opportunity_id: opp.id,
      expected_revision: a.revision,
      state: "awaiting_document",
      note: "Cannot skip Owner approval.",
    }),
  ).rejects.toThrow("INVALID_TRANSITION");
  a = await f.command("acquisition.transition", {
    opportunity_id: opp.id,
    expected_revision: a.revision,
    state: "approved",
    note: "Owner approves manual acquisition only.",
  });
  expect(a.approved_by).toBe(f.owner);
  a = await f.command("acquisition.transition", {
    opportunity_id: opp.id,
    expected_revision: a.revision,
    state: "awaiting_document",
    note: "Document requested at the source.",
  });
  expect(a.state).toBe("awaiting_document");
  expect((await f.db.query("select * from public.jobs")).rows).toHaveLength(0);
  const other = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Another synthetic notice",
    reference: "A2",
    decision: "declined",
  });
  await f.command("opportunity.relate", {
    opportunity_id: opp.id,
    related_opportunity_id: other.id,
    reason: "Both synthetic notices share a procurement reference.",
  });
  expect(
    (await f.db.query("select * from public.opportunities")).rows,
  ).toHaveLength(2);
});
