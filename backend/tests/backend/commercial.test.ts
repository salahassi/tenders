// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  calculateEstimate,
  calculateDelivery,
} from "../../supabase/functions/_shared/finance";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup() {
  let rate = await f.command("rate.save", {
    expected_revision: 0,
    title: "Synthetic approved labor",
    unit: "day",
    currency: "SAR",
    unit_cost: "1000",
    zero_confirmed: false,
    valid_from: "2020-01-01",
    valid_until: "2099-01-01",
    source_reference: "Synthetic public test rate",
    public_approved: true,
  });
  rate = await f.command("rate.approve", {
    id: rate.id,
    expected_revision: rate.revision,
  });
  const source = await f.command("source.create", {
      name: "Synthetic manual",
      kind: "manual",
    }),
    opp = await f.command("opportunity.create", {
      source_id: source.id,
      title: "Synthetic commercial scope",
      reference: "S1",
      decision: "shortlisted",
    });
  const proposal = crypto.randomUUID(),
    plan = crypto.randomUUID(),
    version = crypto.randomUUID(),
    requirement = crypto.randomUUID();
  await f.db.query(
    "insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values($1,$2,$3,'Synthetic proposal',$4)",
    [proposal, f.w, opp.id, f.owner],
  );
  await f.db.query(
    "insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) select $1,$2,$3,$4,'proposal','completed','completed',evidence_revision,repeat('a',64),'{\"blocks\":[],\"knowledge\":[]}', $5 from public.workspaces where id=$2",
    [plan, f.w, opp.id, proposal, f.owner],
  );
  await f.db.query(
    "insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,package_hash,plan_id,evidence_revision,created_by) select $1,$2,$3,1,repeat('a',64),repeat('b',64),$4,evidence_revision,$5 from public.workspaces where id=$2",
    [version, f.w, proposal, plan, f.owner],
  );
  await f.db.query(
    "update public.proposals set active_version_id=$1 where id=$2",
    [version, proposal],
  );
  await f.db.query(
    "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by) values($1,$2,'approach','Proposed approach','Implement approval workflow.',0,$3)",
    [f.w, version, f.owner],
  );
  await f.db.query(
    "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,created_by) values($1,$2,$3,$4,'Implement approval workflow.','functional',true,'[]','Workflow','Acceptance test',$5)",
    [requirement, f.w, plan, opp.id, f.owner],
  );
  const input = {
    currency: "SAR",
    precision: 2,
    method: "markup",
    percentage: "20",
    contingency: "10",
    taxes: [{ category: "synthetic", rate: "15", confirmed: true }],
    fx: [],
    lines: [
      {
        id: crypto.randomUUID(),
        description: "Synthetic effort",
        quantity: "10",
        rate_id: rate.id,
        period_count: "1",
        unit: "day",
        included_in_base: true,
        charge_group: "one_time",
        tax_category: "synthetic",
        requirement_ids: [requirement],
        section_ids: ["approach"],
        deliverable: "Approval workflow",
        basis: "Synthetic effort estimate",
        duration_basis: "One-time delivery",
      },
    ],
    payment_basis: "base_gross",
    payment_basis_confirmed: true,
    payments: [{ title: "Acceptance", percent: "100" }],
    validity_date: "2099-01-01",
    commercial_terms: "Synthetic terms only.",
    assumptions_confirmed: true,
  };
  const delivery = {
    roles: [
      {
        role: "Engineer",
        available_fte: "1",
        confirmed: true,
        basis: "Synthetic capacity",
      },
    ],
    tasks: [
      {
        key: "a",
        title: "Implementation",
        predecessors: [],
        role: "Engineer",
        effort_days: "10",
        allocation: "1",
        duration_days: "10",
        basis: "Synthetic workload",
        confirmed: true,
      },
    ],
  };
  return { rate, proposal, plan, version, requirement, input, delivery };
}
async function calculate(
  s: Awaited<ReturnType<typeof setup>>,
  kind = "estimate",
) {
  const pending = await f.command(kind + ".prepare", {
    proposal_version_id: s.version,
    expected_revision: 1,
    input: kind === "estimate" ? s.input : s.delivery,
  });
  const context = await f.rpc("calculation_context", [pending.id, kind]);
  const computed =
    kind === "estimate"
      ? calculateEstimate(context.record.input, context.rates)
      : calculateDelivery(context.record.input);
  return f.rpc("complete_calculation", [
    pending.id,
    kind,
    f.owner,
    pending.input_hash,
    context.rates_hash,
    JSON.stringify(computed),
  ]);
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
  const revision=(await f.db.query<any>("select revision from public.proposal_versions where id=$1",[s.version])).rows[0].revision;
  const exported=await f.command("export.prepare",{proposal_version_id:s.version,expected_revision:revision,mode:"final",volume:"combined"});
  const artifact=await f.command("export.reserve",{export_id:exported.id,kind:"generated",original_name:"synthetic.docx",mime_type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",size:100,hash:"c".repeat(64),review_attested:false});
  await f.db.exec("savepoint export_attempt");
  await expect(f.rpc("complete_export_artifact",[artifact.id,f.owner,"d".repeat(64),100,"generated_content"])).rejects.toThrow("ARTIFACT_MISMATCH");
  await f.db.exec("rollback to savepoint export_attempt; release savepoint export_attempt");
  await f.rpc("complete_export_artifact",[artifact.id,f.owner,"c".repeat(64),100,"generated_content"]);
  expect((await f.rpc("authorize_artifact_download",[artifact.id,f.owner,"c".repeat(64)])).status).toBe("ready");
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
  await expect(f.rpc("authorize_artifact_download",[artifact.id,f.owner,"c".repeat(64)])).rejects.toThrow("STALE_EXPORT_APPROVAL");
  await f.db.exec("rollback to savepoint stale_export; release savepoint stale_export");
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
