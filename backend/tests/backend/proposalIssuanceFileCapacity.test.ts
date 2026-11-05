// @vitest-environment node
import { readFile } from "node:fs/promises";
import { databaseWithMigrations } from "./databaseFixture";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture, claimModelWorker5 } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const row = async (sql: string, args: unknown[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic capacity lifecycle",
    kind: "manual",
  });
  const o = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic capacity lifecycle",
    description: "Provide a documented workflow.",
    reference: "SYNTHETIC",
    language: "en",
    decision: "shortlisted",
  });
  const d = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: o.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
  });
  await f.rpc("accept_uploaded_document", [
    d.id,
    f.owner,
    "a".repeat(64),
    100,
    "Provide a workflow and handover documentation.",
    "ready",
    crypto.randomUUID(),
  ]);
  const p = await f.command("proposal.generate", {
    id: o.id,
    expected_revision: o.revision,
  });
  const j = await claimModelWorker5(f, (name) => f.rpc(name));
  expect(j.type).toBe("analyze_chunk");
  const r = await row(
    "select r.* from public.proposal_issuance_requests r join public.generation_plans p on p.issuance_request_id=r.id where p.id=$1",
    [p.id],
  );
  return { p, j, r };
}
const used = async () =>
  Number(
    (await row("select app_private.storage_reserved_bytes($1) bytes", [f.w]))
      .bytes,
  );
async function hold(j: any) {
  await f.db.query("select app_private.ensure_issuance_file_capacity($1,$2)", [
    j.id,
    j.lease_token,
  ]);
}
async function attempt(run: () => Promise<unknown>) {
  await f.db.exec("savepoint capacity_attempt");
  try {
    return await run();
  } catch (error) {
    await f.db.exec("rollback to savepoint capacity_attempt");
    throw error;
  } finally {
    await f.db.exec("release savepoint capacity_attempt");
  }
}
it("acquires exactly the whole maximum two-volume envelope once and retains original request identity", async () => {
  const { j, r } = await setup(),
    baseline = await used();
  await hold(j);
  await hold(j);
  const held = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [r.id],
  );
  expect(held).toEqual({
    ...r,
    file_capacity_acquired: true,
    reserved_file_bytes: 20971520,
  });
  expect(await used()).toBe(baseline + 20971520);
});
it("releases only unspent future-file capacity on early terminal failure and preserves unknown provider accounting", async () => {
  const { j, r } = await setup(),
    baseline = await used();
  await hold(j);
  const id = crypto.randomUUID();
  await f.db.query(
    "insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1::uuid,$2,$3,$4,$1::text,'openai','synthetic-model',$5,current_date,1,100,1000,'unknown',$6)",
    [id, f.w, j.id, j.lease_token, j.input_hash, f.owner],
  );
  const usage = await row("select * from public.provider_usage where id=$1", [
    id,
  ]);
  await f.rpc("fail_generation", [
    j.id,
    j.lease_token,
    "AI_AGENTS_UNAVAILABLE",
    null,
    null,
  ]);
  expect(
    await row(
      "select outcome,error_code,reserved_file_bytes,file_capacity_acquired from public.proposal_issuance_requests where id=$1",
      [r.id],
    ),
  ).toEqual({
    outcome: "failed",
    error_code: "AI_AGENTS_UNAVAILABLE",
    reserved_file_bytes: 0,
    file_capacity_acquired: true,
  });
  expect(await used()).toBe(baseline);
  expect(
    await row("select * from public.provider_usage where id=$1", [id]),
  ).toEqual(usage);
});
it("refuses stale lease capacity acquisition without changing the ledger", async () => {
  const { j, r } = await setup(),
    baseline = await used();
  await expect(
    attempt(() => hold({ ...j, lease_token: crypto.randomUUID() })),
  ).rejects.toThrow("STALE_LEASE");
  expect(
    await row("select * from public.proposal_issuance_requests where id=$1", [
      r.id,
    ]),
  ).toEqual(r);
  expect(await used()).toBe(baseline);
});
it("reports known storage impossibility as an early terminal issuance, never an AI availability or timeout wait", async () => {
  const { j, r } = await setup();
  await f.db.query(
    "insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values($1,'synthetic-unconfirmed-cleanup',$2,'Synthetic retained ambiguous bytes')",
    [f.w, 262144000 - (await used())],
  );
  await expect(attempt(() => hold(j))).rejects.toThrow("STORAGE_CAP_REACHED");
  await f.rpc("fail_generation", [
    j.id,
    j.lease_token,
    "STORAGE_CAP_REACHED",
    null,
    null,
  ]);
  const ended = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [r.id],
  );
  expect(ended).toMatchObject({
    outcome: "failed",
    error_code: "STORAGE_CAP_REACHED",
    reserved_file_bytes: 0,
    file_capacity_acquired: false,
  });
  expect(new Date(ended.completed_at).getTime()).toBeLessThan(
    new Date(ended.deadline_at).getTime(),
  );
  expect(
    (await row("select count(*)::int n from public.provider_usage")).n,
  ).toBe(0);
});
it("restored terminal requests retain historical identity and consumed-budget flag while releasing only future allowance", async () => {
  const { r } = await setup();
  const id = crypto.randomUUID();
  await f.db.query(
    "insert into public.proposal_issuance_requests(id,workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at,outcome,error_code,completed_at,file_capacity_version,file_capacity_acquired,reserved_file_bytes) values($1::uuid,$2,$3,$4,'proposal.generate',$1::text,$5,$6,'failed','RESTORE_REQUIRES_REVIEW',clock_timestamp(),1,true,20971520)",
    [id, f.w, r.plan_id, f.owner, r.accepted_at, r.deadline_at],
  );
  const restored = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [id],
  );
  expect(restored).toMatchObject({
    file_capacity_acquired: true,
    reserved_file_bytes: 0,
    error_code: "RESTORE_REQUIRES_REVIEW",
  });
  expect(restored.accepted_at).toEqual(r.accepted_at);
  expect(restored.deadline_at).toEqual(r.deadline_at);
});

it("installs capacity wrappers under managed-only roles without exposing bypass helpers", async () => {
  const db = await databaseWithMigrations(
    "20261104151946_current_proposal_issuance_contract.sql",
  );
  try {
    await db.exec(
      "alter role anon rename to tdp_app_anon;alter role authenticated rename to tdp_app_authenticated;alter role service_role rename to tdp_app_service",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/20261104160125_proposal_issuance_file_capacity.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const result = (
      await db.query<any>(`select has_function_privilege('tdp_app_service','public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)','execute') worker,
  has_function_privilege('tdp_app_authenticated','public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)','execute') browser,
  has_function_privilege('tdp_app_service','public.reserve_task_model_call_before_file_capacity(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)','execute') bypass,
  has_function_privilege('tdp_app_service','app_private.ensure_issuance_file_capacity(uuid,uuid)','execute') helper,
  has_table_privilege('tdp_app_authenticated','public.proposal_issuance_requests','update') tamper`)
    ).rows[0];
    expect(result).toEqual({
      worker: true,
      browser: false,
      bypass: false,
      helper: false,
      tamper: false,
    });
  } finally {
    await db.close();
  }
}, 30000);
