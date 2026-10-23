// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
  await f.db
    .exec(`create table app_private.test_handoff_dispatches(id bigint generated always as identity);
    create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$
    begin insert into app_private.test_handoff_dispatches default values;end $$;`);
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled,collection_hosts) values(true,'https://synthetic.supabase.co','synthetic',true,$1)",
    [["public.example.test"]],
  );
});
afterEach(async () => f.db.exec("rollback"));
const url = "https://public.example.test/notice";
const wake = (job: any, lease = job.lease_token) =>
  f.rpc("wake_backend_queue_status", [job.id, lease]);
async function rawJob() {
  return (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,checkpoint,created_by) values($1,'analyze_chunk',gen_random_uuid(),'synthetic','queued','{\"model_executor\":2}',$2) returning *",
      [f.w, f.owner],
    )
  ).rows[0];
}
async function reader(kind: string) {
  const source = await f.command("source.create", {
    name: "Synthetic public reader",
    kind: "link_directory",
    url: "https://public.example.test/listing",
    approved_hosts: ["public.example.test"],
    policy_note: "Synthetic public access",
  });
  await f.db.query(
    "update public.sources set adapter_config='{\"automatic\":true}',approval='approved',policy_checked_at=now(),next_due=now()+interval '6 hours' where id=$1",
    [source.id],
  );
  await f.command("model.configure", {
    provider: "gemini_free",
    expected_revision: 0,
    enabled: true,
    model: "synthetic",
    project_ref: "synthetic",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_mode: "provider_managed",
    quota_ends_at: null,
    quota_remaining_tokens: null,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  });
  await f.db.query(
    "select app_private.ingest_notice($1,s,$3::jsonb,$4) from public.sources s where id=$2",
    [
      f.w,
      source.id,
      JSON.stringify({
        identity_key: "synthetic",
        title: "Synthetic public notice",
        description: "Public notice awaiting original documents.",
        buyer: "Synthetic buyer",
        reference: "synthetic",
        language: "en",
        canonical_url: url,
      }),
      f.owner,
    ],
  );
  await f.rpc("schedule_assessment_refresh");
  const job = await f.rpc("claim_backend_job_v2");
  expect(job.type).toBe("classify_opportunity");
  if (kind === "ocr")
    await f.rpc("request_notice_ocr", [
      job.id,
      job.lease_token,
      "https://public.example.test/notice.pdf",
      "a".repeat(64),
      "[1]",
      1,
      "application/pdf",
    ]);
  else await f.rpc("request_notice_browser", [job.id, job.lease_token, url]);
  return job;
}

it.each(["ocr", "browser"])(
  "wakes other due work after a durable %s handoff without reclaiming or changing its parent",
  async (kind) => {
    const job = await reader(kind);
    expect(await wake(job)).toEqual({ dispatched: false });
    const other = await rawJob();
    const before = (
      await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
    ).rows[0];
    expect(await wake(job, crypto.randomUUID())).toEqual({ dispatched: false });
    expect(await wake(job)).toEqual({ dispatched: true });
    expect(await wake(job)).toEqual({ dispatched: false });
    expect(
      (await f.db.query<any>("select * from public.jobs where id=$1", [job.id]))
        .rows[0],
    ).toEqual(before);
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(other.id);
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  },
);

it.each([
  "future",
  "canceled",
  "executor",
  "revision",
  "running",
  "disabled",
  "reserved",
  "restore",
])("does not wake an unready or invalid reader handoff: %s", async (mode) => {
  const job = await reader("browser");
  const other = await rawJob();
  if (mode === "future")
    await f.db.query(
      "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
      [other.id],
    );
  if (mode === "canceled")
    await f.db.query(
      "update public.jobs set cancel_requested=true where id=$1",
      [other.id],
    );
  if (mode === "executor")
    await f.db.query(
      "update public.jobs set checkpoint='{\"model_executor\":3}' where id=$1",
      [other.id],
    );
  if (mode === "revision")
    await f.db.query("update public.jobs set revision=revision+1 where id=$1", [
      job.id,
    ]);
  if (mode === "running")
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(other.id);
  if (mode === "disabled")
    await f.db.exec("update app_private.dispatcher_settings set enabled=false");
  if (mode === "reserved")
    await f.db.query(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by)
        select $1,$2,$3,'synthetic-'||n,'openai','synthetic','synthetic',current_date,1,1,1,$4
        from generate_series(1,app_private.model_request_limit($1)) n`,
      [f.w, other.id, crypto.randomUUID(), f.owner],
    );
  if (mode === "restore")
    await f.db.query(
      "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
      [f.w, f.owner],
    );
  expect(await wake(job)).toEqual({ dispatched: false });
});

async function graphFixture() {
  const queued = await rawJob();
  const job = await f.rpc("claim_backend_job_v2");
  expect(job.id).toBe(queued.id);
  const thread = "b".repeat(64);
  const action = (leased: any, name: string, payload = {}) =>
    f.rpc("model_graph_store", [
      leased.id,
      leased.lease_token,
      thread,
      name,
      JSON.stringify(payload),
    ]);
  await action(job, "init", {
    input_hash: "c".repeat(64),
    task: "analyze_chunk",
    graph_version: 1,
  });
  const put = {
    namespace: "",
    checkpoint_id: "synthetic-1",
    parent_id: null,
    checkpoint: { type: "json", data: "e30=" },
    metadata: { type: "json", data: "e30=" },
  };
  return { job, action, put };
}

it("wakes a graph-only turn after a new checkpoint and refuses an idempotent replay under its next lease", async () => {
  const { job, action, put } = await graphFixture();
  await action(job, "put", put);
  await action(job, "put", put);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='queue.graph_checkpoint_progress'",
      )
    ).rows[0].n,
  ).toBe(1);
  const receipt = (
    await f.db.query<any>(
      "select reason::jsonb as proof from public.audit_events where action='queue.graph_checkpoint_progress'",
    )
  ).rows[0].proof;
  expect(receipt.lease_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(receipt)).not.toContain(job.lease_token);
  expect(receipt.checkpoint_id).toBe(put.checkpoint_id);
  await action(job, "yield");
  expect(await wake(job, crypto.randomUUID())).toEqual({ dispatched: false });
  const before = (
    await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
  ).rows[0];
  expect(await wake(job)).toEqual({ dispatched: true });
  expect(await wake(job)).toEqual({ dispatched: false });
  expect(
    (await f.db.query<any>("select * from public.jobs where id=$1", [job.id]))
      .rows[0],
  ).toEqual(before);
  const resumed = await f.rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(job.id);
  await action(resumed, "put", put);
  await action(resumed, "yield");
  expect(await wake(resumed)).toEqual({ dispatched: false });
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='queue.graph_checkpoint_progress'",
      )
    ).rows[0].n,
  ).toBe(1);
});

it("never treats a result without a newly persisted graph checkpoint as progress", async () => {
  const { job, action } = await graphFixture();
  await action(job, "result_put", {
    key: "candidate-0",
    value: { result: { synthetic: true } },
  });
  await action(job, "yield");
  await rawJob();
  expect(await wake(job)).toEqual({ dispatched: false });
});

it("keeps the ten-second workspace throttle for independent handoff receipts", async () => {
  const { job, action, put } = await graphFixture();
  await action(job, "put", put);
  await action(job, "yield");
  expect(await wake(job)).toEqual({ dispatched: true });
  const resumed = await f.rpc("claim_backend_job_v2");
  await action(resumed, "put", {
    ...put,
    checkpoint_id: "synthetic-2",
    parent_id: "synthetic-1",
  });
  await action(resumed, "yield");
  expect(await wake(resumed)).toMatchObject({
    dispatched: false,
    retry_after_ms: expect.any(Number),
  });
  await f.db.exec(
    "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds'",
  );
  expect(await wake(resumed)).toEqual({ dispatched: true });
});
