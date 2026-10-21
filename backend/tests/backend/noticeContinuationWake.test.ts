// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
  // Stub only the external dispatch. Completion, admission and claims use the
  // canonical PostgreSQL functions and real released leases.
  await f.db.exec(`
    create table app_private.test_notice_wakes(id bigint generated always as identity);
    create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$
    begin insert into app_private.test_notice_wakes default values;end $$;
  `);
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled) values(true,'https://synthetic.supabase.co','fixture',true)",
  );
});
afterEach(async () => f.db.exec("rollback"));

async function prepared() {
  const source = await f.command("source.create", {
    name: "Synthetic unchanged notice source",
    kind: "link_directory",
    url: "https://example.test/notices",
    approved_hosts: ["example.test"],
    policy_note: "Synthetic approved public fixture",
  });
  await f.db.query(
    "update public.sources set approval='approved',policy_checked_at=now(),adapter_config='{\"official_listing\":\"fixture\"}',next_due=now()+interval '6 hours',last_success_at=now() where id=$1",
    [source.id],
  );
  const item = {
    identity_key: "external:synthetic-notice",
    title: "Synthetic software services",
    description:
      "A synthetic software procurement description with complete unchanged public requirements for this isolated database test.",
    buyer: "Synthetic buyer",
    reference: "SYN-1",
    language: "en",
    canonical_url: "https://example.test/notices/1",
    notice_evidence: {
      version: 1,
      status: "read",
      detail_url: "https://example.test/notices/1",
      detail_sha256: "a".repeat(64),
      fetched_at: "2020-01-01T00:00:00Z",
      attachments: [],
      deadline: { date: "2030-01-01" },
    },
  };
  const opportunity = (
    await f.db.query<any>(
      "select app_private.ingest_notice($1,s,$3::jsonb,$4) id from public.sources s where id=$2",
      [f.w, source.id, JSON.stringify(item), f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "update public.opportunities set notice_evidence=$2::jsonb||jsonb_build_object('notice_hash',app_private.content_record(workspace_id,'notice',id)->>'content_hash') where id=$1",
    [opportunity, JSON.stringify(item.notice_evidence)],
  );
  const revision = (
    await f.db.query<any>(
      "select revision from public.opportunities where id=$1",
      [opportunity],
    )
  ).rows[0].revision;
  const plan = await f.command("opportunity.assess", {
    id: opportunity,
    expected_revision: revision,
  });
  const job = await f.rpc("claim_backend_job_v2");
  expect(job.entity_id).toBe(plan.id);
  expect(
    (await f.rpc("generation_context", [job.id, job.lease_token]))
      .detail_source,
  ).toBeDefined();
  const details = {
    ...item,
    notice_evidence: {
      ...item.notice_evidence,
      fetched_at: new Date().toISOString(),
      detail_sha256: "b".repeat(64),
    },
  };
  return { job, plan, details };
}
async function released() {
  const result = await prepared();
  await f.rpc("complete_notice_details", [
    result.job.id,
    result.job.lease_token,
    JSON.stringify(result.details),
  ]);
  const current = (
    await f.db.query<any>("select * from public.jobs where id=$1", [
      result.job.id,
    ])
  ).rows[0];
  expect(current).toMatchObject({
    status: "retry_wait",
    error_code: null,
    lease_token: null,
    lease_until: null,
  });
  return { ...result, current };
}
async function wake(job: any, lease = job.lease_token) {
  await f.db.exec("savepoint notice_wake;set local role service_role");
  try {
    return await f.rpc("wake_backend_queue_status", [job.id, lease]);
  } catch (error) {
    await f.db.exec("rollback to savepoint notice_wake");
    throw error;
  } finally {
    await f.db.exec("reset role;release savepoint notice_wake");
  }
}
async function count() {
  return (
    await f.db.query<any>(
      "select count(*)::int n from app_private.test_notice_wakes",
    )
  ).rows[0].n;
}
async function queued() {
  return (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status) values($1,'analyze_chunk',$2,'synthetic',$3,'queued') returning *",
      [f.w, crypto.randomUUID(), f.owner],
    )
  ).rows[0];
}

it("wakes the same healthy notice continuation immediately after canonical completion without another model request or input change", async () => {
  const { job, plan, current } = await released();
  const audit = (
    await f.db.query<any>(
      "select reason::jsonb receipt from public.audit_events where action='notice.details_unchanged' and reason::jsonb->>'job_id'=$1",
      [job.id],
    )
  ).rows[0].receipt;
  expect(audit).toMatchObject({
    released_lease: job.lease_token,
    job_revision: current.revision,
    job_id: job.id,
    plan_id: plan.id,
  });
  expect(await wake(job)).toEqual({ dispatched: true });
  expect(await count()).toBe(1);
  const next = await f.rpc("claim_backend_job_v2");
  expect(next.id).toBe(job.id);
  expect(next.lease_token).not.toBe(job.lease_token);
  expect(next.input_hash).toBe(job.input_hash);
  expect(next.checkpoint).toEqual(job.checkpoint);
  expect(
    (await f.rpc("generation_context", [next.id, next.lease_token]))
      .detail_source,
  ).toBeUndefined();
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (
      await f.db.query<any>(
        "select (select count(*) from public.provider_usage)::int usage,(select count(*) from public.model_attempts)::int attempts",
      )
    ).rows[0],
  ).toEqual({ usage: 0, attempts: 0 });
  expect(
    (
      await f.db.query<any>(
        "select frozen_context,input_hash from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0],
  ).toEqual({
    frozen_context: plan.frozen_context,
    input_hash: plan.input_hash,
  });
});

it("retains normal interactive ordering instead of giving the successful detail job a new priority", async () => {
  const { job } = await released();
  const next = await queued();
  expect(await wake(job)).toEqual({ dispatched: true });
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(next.id);
});

it("deduplicates replay of the exact successful release", async () => {
  const { job } = await released();
  expect(await wake(job)).toEqual({ dispatched: true });
  expect(await wake(job)).toEqual({ dispatched: false });
  expect(await count()).toBe(1);
});

it("rejects the wrong callback lease even with ordinary work due", async () => {
  const { job } = await released();
  await queued();
  expect(await wake(job, crypto.randomUUID())).toEqual({ dispatched: false });
  expect(await count()).toBe(0);
});

it.each([
  "revision",
  "future due",
  "error",
  "active lease",
  "cancel",
  "reservation",
  "restore",
  "disabled",
])(
  "fails closed when %s changes after the successful detail read",
  async (change) => {
    const { job } = await released();
    await queued();
    if (change === "revision")
      await f.db.query(
        "update public.jobs set revision=revision+1 where id=$1",
        [job.id],
      );
    if (change === "future due")
      await f.db.query(
        "update public.jobs set next_attempt_at=now()+interval '1 minute' where id=$1",
        [job.id],
      );
    if (change === "error")
      await f.db.query(
        "update public.jobs set error_code='SOURCE_TEMPORARY_FAILURE' where id=$1",
        [job.id],
      );
    if (change === "active lease")
      await f.db.query(
        "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1",
        [job.id, crypto.randomUUID()],
      );
    if (change === "cancel")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [job.id],
      );
    if (change === "reservation")
      await f.db.query(
        "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by) values($1,$2,$3,'synthetic','openai','synthetic',$4,current_date,1,1,1,$5)",
        [f.w, job.id, job.lease_token, job.input_hash, f.owner],
      );
    if (change === "restore")
      await f.db.query(
        "insert into public.restore_sessions(workspace_id,created_by,state,manifest) values($1,$2,'staging','{}')",
        [f.w, f.owner],
      );
    if (change === "disabled")
      await f.db.exec(
        "update app_private.dispatcher_settings set enabled=false",
      );
    expect(await wake(job)).toEqual({ dispatched: false });
    expect(await count()).toBe(0);
  },
);

it("never wakes a failed detail retry or changes its backoff", async () => {
  const { job } = await prepared();
  await f.rpc("fail_notice_details", [
    job.id,
    job.lease_token,
    "SOURCE_TEMPORARY_FAILURE",
  ]);
  const before = (
    await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
  ).rows[0];
  await queued();
  expect(await wake(job)).toEqual({ dispatched: false });
  expect(
    (await f.db.query<any>("select * from public.jobs where id=$1", [job.id]))
      .rows[0],
  ).toEqual(before);
  expect(await count()).toBe(0);
});

it("retains the existing workspace throttle and rechecks the exact revision after its bounded delay", async () => {
  const { job } = await released();
  const prior = await queued();
  await f.db.query(
    "insert into app_private.worker_queue_wakes(job_id,workspace_id,job_revision,dispatched_at) values($1,$2,1,clock_timestamp())",
    [prior.id, f.w],
  );
  const cooldown = await wake(job);
  expect(cooldown.dispatched).toBe(false);
  expect(cooldown.retry_after_ms).toBeGreaterThan(0);
  expect(cooldown.retry_after_ms).toBeLessThanOrEqual(10000);
  expect(await count()).toBe(0);
  await f.db.query(
    "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds' where job_id=$1",
    [prior.id],
  );
  await f.db.query("update public.jobs set revision=revision+1 where id=$1", [
    job.id,
  ]);
  expect(await wake(job)).toEqual({ dispatched: false });
  expect(await count()).toBe(0);
});

it("keeps wake RPCs service-only", async () => {
  const privileges = (
    await f.db.query<any>(
      "select has_function_privilege('anon','public.wake_backend_queue_status(uuid,uuid)','execute') anon,has_function_privilege('authenticated','public.wake_backend_queue_status(uuid,uuid)','execute') authenticated,has_function_privilege('service_role','public.wake_backend_queue_status(uuid,uuid)','execute') service,has_function_privilege('service_role','app_private.wake_backend_queue_checked(uuid,uuid,bigint)','execute') private",
    )
  ).rows[0];
  expect(privileges).toEqual({
    anon: false,
    authenticated: false,
    service: true,
    private: false,
  });
});
