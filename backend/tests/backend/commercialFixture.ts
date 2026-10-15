import { workflowFixture } from "./workflowFixture";
import {
  calculateEstimate,
  calculateDelivery,
} from "../../supabase/functions/_shared/finance";
export function commercialHelpers(
  f: Awaited<ReturnType<typeof workflowFixture>>,
) {
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
  return { setup, calculate };
}
