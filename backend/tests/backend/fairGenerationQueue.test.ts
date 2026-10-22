// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});

async function enqueue(
  type: string,
  entity = crypto.randomUUID(),
  future = false,
) {
  return (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,next_attempt_at,status)
    values($1,$2,$3,'queue-fixture',$4,now()+case when $5 then interval '1 hour' else interval '0' end,'queued') returning *`,
      [f.w, type, entity, f.owner, future],
    )
  ).rows[0];
}
async function finish(id: string) {
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null,updated_at=now(),revision=revision+1 where id=$1",
    [id],
  );
}
async function reserve(job: any) {
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,
    settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    values($1,$2::uuid,gen_random_uuid(),$2::uuid::text,'openai','fixture-model',repeat('a',64),current_date,1,100,100,'reserved','resp_fixture',now()+interval '1 hour',$3)`,
    [f.w, job.id, f.owner],
  );
  await f.db.query(
    "update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',next_attempt_at=now()+interval '1 hour' where id=$1",
    [job.id],
  );
}

it("finishes saved proposal units before fresh siblings without taking other owners' or collection's turns", async () => {
  const owner = crypto.randomUUID();
  const fresh = await enqueue("draft_section", owner);
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 hour' where id=$1",
    [fresh.id],
  );
  const continuing = await enqueue("draft_section", owner);
  await f.db.query(
    "update public.jobs set checkpoint=jsonb_build_object('graph_thread','fixture'),error_code='MODEL_IN_PROGRESS',status='retry_wait' where id=$1",
    [continuing.id],
  );
  const other = await enqueue("draft_section");
  const collection = await enqueue("source_collect");
  const first = await f.rpc("claim_backend_job_v2");
  expect(first.id).toBe(continuing.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  await finish(first.id);
  const background = await f.rpc("claim_backend_job_v2");
  expect(background.id).toBe(collection.id);
  await finish(background.id);
  const nextOwner = await f.rpc("claim_backend_job_v2");
  expect(nextOwner.id).toBe(other.id);
  await finish(nextOwner.id);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(fresh.id);
});

it("does not wake a saved continuation before its due time or bypass accepted-request capacity", async () => {
  const owner = crypto.randomUUID();
  const delayed = await enqueue("draft_section", owner, true);
  await f.db.query(
    "update public.jobs set checkpoint=jsonb_build_object('graph_thread','fixture'),error_code='MODEL_IN_PROGRESS',status='retry_wait' where id=$1",
    [delayed.id],
  );
  const fresh = await enqueue("draft_section", owner);
  const current = await f.rpc("claim_backend_job_v2");
  expect(current.id).toBe(fresh.id);
  await finish(current.id);
  const accepted = await enqueue("draft_section");
  await reserve(accepted);
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    delayed.id,
  ]);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (
      await f.db.query<any>("select attempts from public.jobs where id=$1", [
        delayed.id,
      ])
    ).rows[0].attempts,
  ).toBe(0);
});

it("serves three proposal owners and background work under continuously arriving work", async () => {
  const owners = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const owner of owners)
    for (let i = 0; i < 4; i++) await enqueue("draft_section", owner);
  const background = await enqueue("classify_opportunity");
  const claims = [];
  for (let i = 0; i < 12; i++) {
    const j = await f.rpc("claim_backend_job_v2");
    expect(j).not.toBeNull();
    claims.push(j);
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
    await finish(j.id);
    if (j.type === "classify_opportunity")
      await enqueue("classify_opportunity");
    else await enqueue("draft_section", j.entity_id);
  }
  expect(claims[1].id).toBe(background.id);
  expect(claims.filter((j) => j.type === "classify_opportunity")).toHaveLength(
    6,
  );
  for (const owner of owners)
    expect(claims.filter((j) => j.entity_id === owner)).toHaveLength(2);
});

it("executes local transitions at full model capacity without claiming new inference or early polling", async () => {
  const waiting = await enqueue("draft_section");
  await reserve(waiting);
  const inference = await enqueue("draft_section");
  const delayed = await enqueue("advance_plan", crypto.randomUUID(), true);
  const transition = await enqueue("advance_plan");
  const j = await f.rpc("claim_backend_local_job");
  expect(j.id).toBe(transition.id);
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  await finish(j.id);
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  const attempts = (
    await f.db.query<any>(
      "select id,attempts from public.jobs where id=any($1::uuid[])",
      [[inference.id, delayed.id, waiting.id]],
    )
  ).rows;
  expect(attempts.every((j) => j.attempts === 0)).toBe(true);
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    waiting.id,
  ]);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(waiting.id);
});

it("uses the owning plan to classify assessment transitions and enforces stage dependencies", async () => {
  const source = await f.command("source.create", {
    name: "Queue source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    title: "Queue fixture",
    source_id: source.id,
    description: "Synthetic fixture",
    decision: "shortlisted",
    language: "en",
  });
  const plan = (
    await f.db.query<any>(
      `insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,input_hash,evidence_revision,frozen_context,created_by)
    values($1,$2,'assessment','assessment','running','fixture',1,'{}',$3) returning *`,
      [f.w, opportunity.id, f.owner],
    )
  ).rows[0];
  const assessment = await enqueue("classify_opportunity", plan.id);
  expect(
    (
      await f.db.query<any>(
        "select app_private.queue_work_class(j) value from public.jobs j where id=$1",
        [assessment.id],
      )
    ).rows[0].value,
  ).toBe("background");
  const transition = await enqueue("advance_plan", plan.id);
  await f.db.query(
    `insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
    values($1,$2,$3,'classify_opportunity','assessment',0,'{}',$4)`,
    [f.w, plan.id, assessment.id, f.owner],
  );
  expect(await f.rpc("claim_backend_local_job")).toBeNull();
  await f.db.query(
    "update public.generation_steps set status='completed',output='{}' where job_id=$1",
    [assessment.id],
  );
  expect((await f.rpc("claim_backend_local_job")).id).toBe(transition.id);
});

it("keeps scheduler state private and exposes only the service local claim", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const permissions = (
      await f.db.query<any>(
        `select has_table_privilege($1,'app_private.queue_dispatch_state','SELECT') state,
      has_function_privilege($1,'app_private.next_fair_job(uuid,boolean)','EXECUTE') picker,
      has_function_privilege($1,'public.claim_backend_local_job()','EXECUTE') claim`,
        [role],
      )
    ).rows[0];
    expect(permissions).toEqual({
      state: false,
      picker: false,
      claim: role === "service_role",
    });
  }
});
