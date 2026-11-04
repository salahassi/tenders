// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { workflowFixture, claimModelWorker4 } from "./workflowFixture";
import { retrieveCompanyEvidence } from "../../supabase/functions/_shared/companyEvidenceRetrieval";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function plan(fixture = f) {
  const s = await fixture.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  const o = await fixture.command("opportunity.create", {
    source_id: s.id,
    title: "Synthetic workflow",
    reference: "SYNTHETIC",
    description: "Improve internal approval workflows.",
    language: "en",
    decision: "shortlisted",
  });
  const d = await fixture.command("document.prepare", {
    kind: "rfp",
    opportunity_id: o.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
    eligibility_attested: true,
  });
  await fixture.rpc("accept_uploaded_document", [
    d.id,
    fixture.owner,
    "a".repeat(64),
    100,
    "Implement an approval workflow.",
    "ready",
    crypto.randomUUID(),
  ]);
  return fixture.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
}
async function refreshed(p: any, prior: any, fixture = f) {
  return (
    await fixture.db.query<any>(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,$5::jsonb) value",
      [
        fixture.w,
        p.opportunity_id,
        p.proposal_id,
        p.package_id,
        JSON.stringify(prior),
      ],
    )
  ).rows[0].value;
}
async function knowledge(title: string, category = "company", verified = true) {
  const k = await f.command("knowledge.save", {
    title,
    category,
    content: `Synthetic ${title} workflow record.`,
    enabled: true,
    evidence: "",
  });
  if (verified)
    await f.command("knowledge.verify", {
      id: k.id,
      expected_revision: k.revision,
    });
  return k;
}

it("pins new normal proposal requests and preserves the pin and exact source snapshot on refresh", async () => {
  await knowledge("verified company");
  const p = await plan();
  expect(p.frozen_context.company_retrieval_version).toBe(1);
  expect(await refreshed(p, p.frozen_context)).toEqual(p.frozen_context);
  const job = await claimModelWorker4(f, f.rpc);
  const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
  expect(ctx.plan.frozen_context.company_retrieval_version).toBe(1);
});

it("preserves historical absence and future explicit pins without silently upgrading them", async () => {
  const p = await plan(),
    legacy = { ...p.frozen_context };
  delete legacy.company_retrieval_version;
  expect(await refreshed(p, legacy)).toEqual(legacy);
  const other = { ...p.frozen_context, company_retrieval_version: 2 };
  expect(await refreshed(p, other)).toEqual(other);
});

it("excludes unverified and expired company records while style remains nonfactual", async () => {
  const verified = await knowledge("verified"),
    expired = await knowledge("expired"),
    unverified = await knowledge("unverified", "company", false),
    style = await knowledge("style", "previous_proposal", false);
  await f.db.query(
    "update public.knowledge_items set expiry_date=current_date-1 where id=$1",
    [expired.id],
  );
  const p = await plan();
  const retrieved = retrieveCompanyEvidence(p.frozen_context.knowledge, [
    { id: "R1", text: "Workflow" },
  ]);
  expect(retrieved.evidence.map((s) => s.id)).toEqual([verified.id]);
  expect(p.frozen_context.knowledge.map((s: any) => s.id)).not.toContain(
    unverified.id,
  );
  expect(p.frozen_context.knowledge.map((s: any) => s.id)).not.toContain(
    expired.id,
  );
  expect(
    p.frozen_context.knowledge.find((s: any) => s.id === style.id)?.kind,
  ).toBe("style");
});

it("still rejects a frozen source whose verification is revoked before processing", async () => {
  const k = await knowledge("verified");
  await plan();
  const job = await claimModelWorker4(f, f.rpc);
  await f.db.query(
    "update public.knowledge_items set verified=false,verified_at=null,verified_by=null where id=$1",
    [k.id],
  );
  await expect(
    f.rpc("generation_context", [job.id, job.lease_token]),
  ).rejects.toThrow("STALE_INPUT");
});

it("cannot send newly selected seventh-source evidence after its exact provider permission is revoked", async () => {
  for (let i = 0; i < 7; i++) await knowledge(`source ${i}`);
  const p = await plan(),
    job = await claimModelWorker4(f, f.rpc);
  const selected = retrieveCompanyEvidence(p.frozen_context.knowledge, [
    { id: "R1", text: "Workflow" },
  ]);
  expect(selected.evidence).toHaveLength(7);
  const refs = selected.evidence.map((s) => s.reference);
  const authorizations = [];
  for (const ref of refs)
    authorizations.push(
      await f.command("content.authorize", {
        ...ref,
        provider: "qwen_free",
        attestation: "nonconfidential_nonpersonal",
      }),
    );
  await f.db.query(
    "select app_private.check_requested_model_payload($1,'qwen_free',$2::jsonb)",
    [job.id, JSON.stringify(refs)],
  );
  await f.command("content.revoke", {
    id: authorizations[6].id,
    expected_revision: authorizations[6].revision,
  });
  await expect(
    f.db.query(
      "select app_private.check_requested_model_payload($1,'qwen_free',$2::jsonb)",
      [job.id, JSON.stringify(refs)],
    ),
  ).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
});

it("keeps the snapshot delegate and wrapper inaccessible to browser and service roles", async () => {
  const result = await f.db.query<any>(
    "select r, f, has_function_privilege(r,f,'EXECUTE') allowed from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)','app_private.draft_generation_snapshot_before_company_retrieval(uuid,uuid,uuid,uuid,jsonb)']) f",
  );
  expect(result.rows).toHaveLength(6);
  expect(result.rows.every((r) => r.allowed === false)).toBe(true);
});

it("applies at the historical migration boundary without changing saved input hashes or jobs", async () => {
  const old = await workflowFixture(
    undefined,
    "20261103032000_model_admission_fairness.sql",
  );
  try {
    await old.db.exec("begin");
    const p = await plan(old);
    expect(p.frozen_context).not.toHaveProperty("company_retrieval_version");
    const before = (
      await old.db.query<any>(
        "select to_jsonb(p) value from public.generation_plans p where id=$1",
        [p.id],
      )
    ).rows[0].value;
    const jobs = (
      await old.db.query<any>(
        "select to_jsonb(j) value from public.jobs j order by id",
      )
    ).rows;
    await old.db.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/20261104122015_company_evidence_retrieval.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      (
        await old.db.query<any>(
          "select to_jsonb(p) value from public.generation_plans p where id=$1",
          [p.id],
        )
      ).rows[0].value,
    ).toEqual(before);
    expect(
      (
        await old.db.query<any>(
          "select to_jsonb(j) value from public.jobs j order by id",
        )
      ).rows,
    ).toEqual(jobs);
    expect(await refreshed(p, p.frozen_context, old)).toEqual(p.frozen_context);
    const job = await old.rpc("claim_backend_job");
    expect(
      (await old.rpc("generation_context", [job.id, job.lease_token])).plan
        .input_hash,
    ).toBe(p.input_hash);
  } finally {
    await old.db.close();
  }
}, 30000);

it("pins new followup/consistency only while preserving every historical compatibility field",async()=>{
 const p=await plan();
 expect(p.frozen_context).toMatchObject({company_retrieval_version:1,company_followup_version:1,proposal_consistency_version:1,extraction_coverage_version:1,delivery_projection_version:1});
 const legacy={...p.frozen_context};delete legacy.company_followup_version;delete legacy.proposal_consistency_version;
 expect(await refreshed(p,legacy)).toEqual(legacy);
 expect(await refreshed(p,{...legacy,company_followup_version:7,proposal_consistency_version:8})).toEqual({...legacy,company_followup_version:7,proposal_consistency_version:8});
 const allowed=await f.db.query<any>("select has_function_privilege('authenticated','app_private.draft_generation_snapshot_before_consistency(uuid,uuid,uuid,uuid,jsonb)','EXECUTE') allowed");
 expect(allowed.rows[0].allowed).toBe(false);
});
