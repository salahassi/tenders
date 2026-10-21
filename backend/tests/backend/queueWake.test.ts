// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import { wakeReadyQueue } from "../../supabase/functions/worker/queueWake";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";

const processGeneration = vi.hoisted(() => vi.fn());
vi.mock("../../supabase/functions/_shared/generation", () => ({
  processGeneration,
}));

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
  // Only replace the external HTTP dispatcher; every admission guard runs in
  // PostgreSQL with the canonical migration and existing claim function.
  await f.db.exec(`
    create table app_private.test_queue_dispatches(id bigint generated always as identity);
    create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$
    begin insert into app_private.test_queue_dispatches default values;end $$;
  `);
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled) values(true,$1,'fixture',true)",
    ["https://synthetic.supabase.co"],
  );
  processGeneration.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.db.exec("rollback");
});
async function job(
  status = "queued",
  error: string | null = null,
  checkpoint = {},
) {
  return (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,error_code,checkpoint,created_by,attempts,revision)
    values($1,'analyze_chunk',$2,'fixture',$3,$4,$5::jsonb,$6,1,2) returning *`,
      [
        f.w,
        crypto.randomUUID(),
        status,
        error,
        JSON.stringify(checkpoint),
        f.owner,
      ],
    )
  ).rows[0];
}
async function wake(id: string, lease = crypto.randomUUID(), details = false) {
  await f.db.exec("savepoint wake_rpc;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${details ? "wake_backend_queue_status" : "wake_backend_queue"}($1,$2) value`,
        [id, lease],
      )
    ).rows[0].value;
  } catch (error) {
    await f.db.exec("rollback to savepoint wake_rpc");
    throw error;
  } finally {
    await f.db.exec("reset role;release savepoint wake_rpc");
  }
}
async function dispatches() {
  return (
    await f.db.query<any>(
      "select count(*)::int count from app_private.test_queue_dispatches",
    )
  ).rows[0].count;
}
async function successfulAttempt(id: string, lease: string) {
  await f.db.query(
    `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,sent,finished_at)
    values($1,$2,$3,'openai','fixture-model','verify_grounding',1,1,'succeeded','SUCCEEDED',false,now())`,
    [f.w, id, lease],
  );
}

async function acceptedPoll() {
  const input = "e".repeat(64);
  const queued = await job("queued", null, {
    model_executor: 2,
    graph_thread: "f".repeat(64),
    model_round: { input_hash: input },
  });
  const claimed = await f.rpc("claim_backend_job_v2");
  expect(claimed.id).toBe(queued.id);
  const usage = crypto.randomUUID();
  await f.db.query(
    `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    values($1,$2,$3,$4,'fixture-accepted-call','openai','fixture-model',$5,current_date,1,100,100,'reserved','resp_fixture',now()+interval '1 hour',$6)`,
    [usage, f.w, claimed.id, claimed.lease_token, input, f.owner],
  );
  const attempt = await f.rpc("start_model_attempt", [
    claimed.id,
    claimed.lease_token,
    "openai",
    "fixture-model",
    "fixture",
    "draft_section",
  ]);
  await f.rpc("finish_model_attempt", [
    attempt,
    claimed.lease_token,
    "MODEL_IN_PROGRESS",
    true,
    usage,
    JSON.stringify({ http_status: 200, request_phase: "generation" }),
  ]);
  await f.rpc("defer_pending_model_request", [
    claimed.id,
    claimed.lease_token,
    usage,
  ]);
  const row = (
    await f.db.query<any>("select * from public.jobs where id=$1", [claimed.id])
  ).rows[0];
  return { claimed, usage, attempt, row };
}

it("wakes independent ready work only when a configured request slot is available", async () => {
  await acceptedPoll();
  const done = await job("succeeded");
  const ready = await job();
  expect(await wake(done.id)).toBe(false);
  await f.db.query(
    "insert into public.model_execution_settings(workspace_id,enabled,max_parallel_requests,created_by) values($1,true,2,$2)",
    [f.w, f.owner],
  );
  expect(await wake(done.id)).toBe(true);
  expect(await dispatches()).toBe(1);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(ready.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
});

it("keeps an accepted poll wake eligible beside another job's accepted request, even after lowering capacity", async () => {
  const { claimed, usage } = await acceptedPoll();
  const other = await job("retry_wait", "MODEL_IN_PROGRESS");
  await f.db.query(
    "update public.jobs set next_attempt_at=now()+interval '2 minutes' where id=$1",
    [other.id],
  );
  await f.db.query(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    select workspace_id,$2,$3,'other-job','openai',model,'b'||substring(input_hash from 2),application_day,settings_revision,100,100,'reserved','resp_other',now()+interval '1 hour',created_by from public.provider_usage where id=$1`,
    [usage, other.id, crypto.randomUUID()],
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [claimed.id],
  );
  expect(await wake(claimed.id, claimed.lease_token, true)).toEqual({
    dispatched: true,
  });
  expect(await dispatches()).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.provider_usage where state='reserved'",
      )
    ).rows[0].n,
  ).toBe(2);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(claimed.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
});

it("waits for the existing accepted request's persisted due time, then wakes and claims only one normal poll lease", async () => {
  const { claimed, usage, row } = await acceptedPoll();
  const ready = await job();
  const beforeUsage = (
    await f.db.query<any>("select * from public.provider_usage where id=$1", [
      usage,
    ])
  ).rows[0];
  const waiting = await wake(claimed.id, claimed.lease_token, true);
  expect(waiting).toMatchObject({
    dispatched: false,
    wait_kind: "accepted_remote_poll",
    job_revision: row.revision,
  });
  expect(waiting.retry_after_ms).toBeGreaterThan(0);
  expect(waiting.retry_after_ms).toBeLessThanOrEqual(30000);
  expect(await dispatches()).toBe(0);
  expect(
    (
      await f.db.query<any>("select * from public.jobs where id=$1", [
        claimed.id,
      ])
    ).rows[0],
  ).toEqual(row);
  // Advance the fixture's due clock; the production RPC never changes it.
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [claimed.id],
  );
  expect(
    await f.rpc("wake_backend_queue_revision", [
      claimed.id,
      claimed.lease_token,
      row.revision,
    ]),
  ).toEqual({ dispatched: true });
  expect(
    await f.rpc("wake_backend_queue_revision", [
      claimed.id,
      claimed.lease_token,
      row.revision,
    ]),
  ).toEqual({ dispatched: false });
  expect(await dispatches()).toBe(1);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(claimed.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (
      await f.db.query<any>(
        "select status,attempts from public.jobs where id=$1",
        [ready.id],
      )
    ).rows[0],
  ).toEqual({ status: "queued", attempts: 1 });
  expect(
    (
      await f.db.query<any>("select * from public.provider_usage where id=$1", [
        usage,
      ])
    ).rows[0],
  ).toEqual(beforeUsage);
});

it.each([
  "cron_claim",
  "revision",
  "canceled",
  "restore",
  "expired",
  "unknown",
  "unaccepted",
  "other_reserved",
  "other_unknown",
  "failed_poll",
  "retry_after",
  "wrong_phase",
  "round_changed",
  "round_missing_input",
])("does not wake a stale or unsafe accepted poll after %s", async (change) => {
  const { claimed, usage, attempt, row } = await acceptedPoll();
  expect((await wake(claimed.id, claimed.lease_token, true)).wait_kind).toBe(
    "accepted_remote_poll",
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [claimed.id],
  );
  if (change === "cron_claim")
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(claimed.id);
  if (change === "revision")
    await f.db.query("update public.jobs set revision=revision+1 where id=$1", [
      claimed.id,
    ]);
  if (change === "canceled")
    await f.db.query(
      "update public.jobs set status='canceled',cancel_requested=true,revision=revision+1 where id=$1",
      [claimed.id],
    );
  if (change === "restore")
    await f.db.query(
      "insert into public.restore_sessions(workspace_id,state,manifest,created_by,expires_at) values($1,'staging','{}',$2,now()+interval '1 hour')",
      [f.w, f.owner],
    );
  if (change === "expired")
    await f.db.query(
      "update public.provider_usage set remote_deadline=now()-interval '1 second' where id=$1",
      [usage],
    );
  if (change === "unknown")
    await f.db.query(
      "update public.provider_usage set state='unknown' where id=$1",
      [usage],
    );
  if (change === "unaccepted")
    await f.db.query(
      "update public.provider_usage set remote_request_id=null,remote_deadline=null where id=$1",
      [usage],
    );
  if (change === "other_reserved" || change === "other_unknown")
    await f.db.query(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) select workspace_id,job_id,lease_token,'fixture-other','openai',model,input_hash,application_day,settings_revision,1,1,$2,created_by from public.provider_usage where id=$1`,
      [usage, change === "other_reserved" ? "reserved" : "unknown"],
    );
  if (change === "failed_poll")
    await f.db.query(
      "update public.model_attempts set http_status=429 where id=$1",
      [attempt],
    );
  if (change === "retry_after")
    await f.db.query(
      "update public.model_attempts set retry_after=now()+interval '1 minute' where id=$1",
      [attempt],
    );
  if (change === "wrong_phase")
    await f.db.query(
      "update public.model_attempts set request_phase='count' where id=$1",
      [attempt],
    );
  if (change === "round_changed")
    await f.db.query(
      "update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_round,input_hash}',to_jsonb('different'::text)) where id=$1",
      [claimed.id],
    );
  if (change === "round_missing_input")
    await f.db.query(
      "update public.jobs set checkpoint=checkpoint #- '{model_round,input_hash}' where id=$1",
      [claimed.id],
    );
  expect(
    await f.rpc("wake_backend_queue_revision", [
      claimed.id,
      claimed.lease_token,
      row.revision,
    ]),
  ).toEqual({ dispatched: false });
  expect(await dispatches()).toBe(0);
});

it("preserves remote retry backoff and rejects a different released lease", async () => {
  const { claimed, row } = await acceptedPoll();
  await f.db.query(
    "update public.jobs set next_attempt_at=now()+interval '10 minutes' where id=$1",
    [claimed.id],
  );
  const before = (
    await f.db.query<any>("select * from public.jobs where id=$1", [claimed.id])
  ).rows[0];
  expect(await wake(claimed.id, claimed.lease_token, true)).toEqual({
    dispatched: false,
  });
  expect(
    await f.rpc("wake_backend_queue_revision", [
      claimed.id,
      crypto.randomUUID(),
      row.revision,
    ]),
  ).toEqual({ dispatched: false });
  expect(
    (
      await f.db.query<any>("select * from public.jobs where id=$1", [
        claimed.id,
      ])
    ).rows[0],
  ).toEqual(before);
});

it.each([
  ["expired same-phase telemetry", true],
  ["unrelated job with live deadline", true],
  ["different structured phase with live deadline", true],
  ["same phase with live deadline", false],
  ["same input on another job with live deadline", false],
  ["legacy same-job key with live deadline", false],
  ["recent unaccepted same-phase request", false],
] as const)(
  "scopes unknown usage for an accepted poll: %s (allowed=%s)",
  async (mode, allowed) => {
    const { claimed, usage } = await acceptedPoll();
    const input = "e".repeat(64);
    const originalKey = `draft:candidate-0:${input.slice(0, 16)}:1:${crypto.randomUUID()}`;
    await f.db.query(
      "update public.provider_usage set call_key=$2 where id=$1",
      [usage, originalKey],
    );
    const unrelated =
      mode.includes("unrelated job") || mode.includes("another job");
    const otherJob = unrelated ? await job() : claimed;
    const otherHash = mode.includes("same input") ? input : "d".repeat(64);
    const phase = mode.includes("different structured")
      ? "draft:verification-v3:other"
      : "draft:candidate-0";
    const key = mode.includes("legacy")
      ? "legacy-writer-attempt"
      : `${phase}:${otherHash.slice(0, 16)}:2:${crypto.randomUUID()}`;
    const recent = mode.includes("recent unaccepted");
    const expired = mode.includes("expired");
    await f.db.query(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_at,created_by)
     values($1,$2,$3,$4,'openai','fixture-model',$5,current_date,1,100,100,'unknown',
      case when $6 then null else 'resp_old_fixture' end,
      case when $6 then null when $7 then now()-interval '1 hour' else now()+interval '1 hour' end,
      case when $6 then now() else now()-interval '1 day' end,$8)`,
      [
        f.w,
        otherJob.id,
        crypto.randomUUID(),
        key,
        otherHash,
        recent,
        expired,
        f.owner,
      ],
    );
    const before = (
      await f.db.query<any>("select * from public.provider_usage order by id")
    ).rows;
    const result = await wake(claimed.id, claimed.lease_token, true);
    if (allowed)
      expect(result).toMatchObject({
        dispatched: false,
        wait_kind: "accepted_remote_poll",
      });
    else expect(result).toEqual({ dispatched: false });
    expect(await dispatches()).toBe(0);
    expect(
      (await f.db.query<any>("select * from public.provider_usage order by id"))
        .rows,
    ).toEqual(before);
  },
);

it("performs one delayed RPC for an accepted request and safely loses a race to cron", async () => {
  const { claimed } = await acceptedPoll();
  let clock = 0;
  const internal = vi.fn(async (name: string, args: any) => {
    if (name === "wake_backend_queue_status")
      return wake(args.job_id, args.lease, true);
    expect(name).toBe("wake_backend_queue_revision");
    return f.rpc(name, [args.job_id, args.lease, args.expected_revision]);
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [claimed.id],
    );
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(claimed.id);
  });
  await wakeReadyQueue(
    { internal, invocationStartedAt: 0, invocationBudgetMs: 130000 },
    claimed,
    { now: () => clock, sleep },
  );
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(internal).toHaveBeenCalledTimes(2);
  expect(await dispatches()).toBe(0);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(1);
});

it("a released canceled job wakes unrelated work without reviving cancellation-marked siblings", async () => {
  const terminal = await job("canceled", "USER_CANCELED");
  const sibling = await job("queued");
  await f.db.query(
    "update public.jobs set cancel_requested=true where id=any($1::uuid[])",
    [[terminal.id, sibling.id]],
  );
  expect(await wake(terminal.id)).toBe(false);
  const other = await job();
  expect(await wake(terminal.id)).toBe(true);
  // Claim may first consume the canceled sibling; neither can receive a lease.
  const first = await f.rpc("claim_backend_job_v2");
  const claimed = first ?? (await f.rpc("claim_backend_job_v2"));
  expect(claimed.id).toBe(other.id);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.jobs where id=any($1::uuid[]) and lease_token is not null",
        [[terminal.id, sibling.id]],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("dispatches the existing queue once after completion without changing jobs or their priority", async () => {
  const completed = await job("succeeded");
  const waiting = await job();
  const before = (
    await f.db.query<any>(
      "select id,status,revision,checkpoint,next_attempt_at from public.jobs order by id",
    )
  ).rows;
  expect(await wake(completed.id)).toBe(true);
  expect(await wake(completed.id)).toBe(false);
  expect(await dispatches()).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select id,status,revision,checkpoint,next_attempt_at from public.jobs order by id",
      )
    ).rows,
  ).toEqual(before);
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(waiting.id);
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
});

it("wakes a canonically claimed and yielded graph continuation while retaining its saved identity and history", async () => {
  const checkpoint = {
    model_executor: 2,
    immutable: "fixture-context",
  };
  const queued = await job("queued", null, checkpoint);
  const continuation = await f.rpc("claim_backend_job_v2");
  expect(continuation.id).toBe(queued.id);
  const lease = continuation.lease_token;
  const thread = "a".repeat(64);
  const graph = (action: string, payload = {}) =>
    f.rpc("model_graph_store", [
      continuation.id,
      lease,
      thread,
      action,
      JSON.stringify(payload),
    ]);
  await graph("init", {
    input_hash: "b".repeat(64),
    task: "analyze_chunk",
    graph_version: 1,
  });
  const result = await graph("result_put", {
    key: "candidate-0",
    value: { result: { fixture: "saved immutable result" } },
  });
  const attempt = await f.rpc("start_model_attempt", [
    continuation.id,
    lease,
    "openai",
    "fixture-model",
    "fixture",
    "verify_grounding",
  ]);
  await f.rpc("finish_model_attempt", [
    attempt,
    lease,
    "SUCCEEDED",
    false,
    null,
    "{}",
  ]);
  await graph("yield");
  const released = (
    await f.db.query<any>(
      "select status,error_code,lease_token,lease_until,next_attempt_at<=now() as due,checkpoint,attempts,revision from public.jobs where id=$1",
      [continuation.id],
    )
  ).rows[0];
  expect(released).toEqual({
    status: "retry_wait",
    error_code: "MODEL_IN_PROGRESS",
    lease_token: null,
    lease_until: null,
    due: true,
    checkpoint: { ...checkpoint, graph_thread: thread },
    attempts: 2,
    revision: 4,
  });
  expect(await wake(continuation.id, lease)).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select checkpoint,attempts,revision from public.jobs where id=$1",
        [continuation.id],
      )
    ).rows[0],
  ).toEqual({ checkpoint: released.checkpoint, attempts: 2, revision: 4 });
  expect(
    (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where id=$1",
        [result.id],
      )
    ).rows[0].value,
  ).toEqual({ result: { fixture: "saved immutable result" } });
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(continuation.id);
});

it("throttles different completions across the workspace and deduplicates older callbacks after the throttle expires", async () => {
  const first = await job("succeeded"),
    second = await job("succeeded");
  await job();
  expect(await wake(first.id)).toBe(true);
  expect(await wake(second.id)).toBe(false);
  await f.db.exec(
    "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds'",
  );
  expect(await wake(first.id)).toBe(false);
  expect(await wake(second.id)).toBe(true);
  expect(await dispatches()).toBe(2);
});

it.each([
  ["retry_wait", "MODEL_RATE_WAIT"],
  ["retry_wait", "MODEL_ROUND_EXHAUSTED"],
  ["quota_wait", "PROVIDER_QUOTA_WAIT"],
])("does not wake after %s / %s", async (status, code) => {
  const failed = await job(status!, code);
  await f.db.query(
    "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
    [failed.id],
  );
  const before = (
    await f.db.query<any>("select * from public.jobs where id=$1", [failed.id])
  ).rows[0];
  await job();
  expect(await wake(failed.id)).toBe(false);
  expect(await dispatches()).toBe(0);
  expect(
    (
      await f.db.query<any>("select * from public.jobs where id=$1", [
        failed.id,
      ])
    ).rows[0],
  ).toEqual(before);
});

it("a canonically blocked source hands off to another due graph without retrying the source", async () => {
  const ready = await job("queued", null, { model_executor: 2 });
  const graphJob = await f.rpc("claim_backend_job_v2");
  expect(graphJob.id).toBe(ready.id);
  const thread = "b".repeat(64);
  const graph = (lease: string, action: string, payload = {}) =>
    f.rpc("model_graph_store", [
      graphJob.id,
      lease,
      thread,
      action,
      JSON.stringify(payload),
    ]);
  await graph(graphJob.lease_token, "init", {
    input_hash: "c".repeat(64),
    task: "analyze_chunk",
    graph_version: 1,
  });
  const saved = await graph(graphJob.lease_token, "result_put", {
    key: "candidate-0",
    value: { result: { fixture: "Retain this completed model result" } },
  });
  await graph(graphJob.lease_token, "yield");
  const source = await f.command("source.create", {
    name: "Synthetic terminal source",
    kind: "manual",
    url: "https://source.example.test/",
  });
  const approved = await f.command("source.action", {
    id: source.id,
    expected_revision: source.revision,
    action: "approve",
    reason: "Synthetic public source fixture",
  });
  await f.command("source.collect", {
    id: approved.id,
    expected_revision: approved.revision,
  });
  await f.db.query(
    "update public.jobs set updated_at=now()-interval '3 minutes' where entity_id=$1",
    [approved.id],
  );
  const claimed = await f.rpc("claim_backend_job_v2");
  expect(claimed).toMatchObject({
    type: "source_collect",
    entity_id: source.id,
  });
  await f.rpc("fail_collection", [
    claimed.id,
    claimed.lease_token,
    "SOURCE_NOTICE_REDIRECTED",
    null,
  ]);
  const blocked = (
    await f.db.query<any>("select * from public.jobs where id=$1", [claimed.id])
  ).rows[0];
  expect(blocked).toMatchObject({
    status: "blocked",
    lease_token: null,
    lease_until: null,
  });
  expect(await wake(claimed.id, claimed.lease_token)).toBe(true);
  expect(await wake(claimed.id, claimed.lease_token)).toBe(false);
  const resumed = await f.rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(ready.id);
  expect(
    (await graph(resumed.lease_token, "result_get", { key: "candidate-0" })).id,
  ).toBe(saved.id);
  expect(
    (
      await f.db.query<any>("select * from public.jobs where id=$1", [
        claimed.id,
      ])
    ).rows[0],
  ).toEqual(blocked);
  expect(await dispatches()).toBe(1);
});

it.each(["blocked", "failed", "canceled"])(
  "wakes other due work once after terminal %s, without changing either job",
  async (status) => {
    const terminal = await job(status, "SYNTHETIC_TERMINAL_ERROR");
    const queued = await job();
    const before = (
      await f.db.query<any>("select * from public.jobs order by id")
    ).rows;
    expect(await wake(terminal.id)).toBe(true);
    await f.db.exec(
      "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds'",
    );
    expect(await wake(terminal.id)).toBe(false);
    expect(
      (await f.db.query<any>("select * from public.jobs order by id")).rows,
    ).toEqual(before);
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(queued.id);
    expect(await dispatches()).toBe(1);
  },
);

it.each(["blocked", "failed", "canceled"])(
  "never wakes a terminal %s job when it is the only work, even with a due timestamp",
  async (status) => {
    const terminal = await job(status, "SYNTHETIC_TERMINAL_ERROR");
    expect(await wake(terminal.id)).toBe(false);
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
    expect(await dispatches()).toBe(0);
  },
);

it.each(["running", "reserved", "restore", "cancel", "throttled", "future"])(
  "terminal handoff still respects %s",
  async (mode) => {
    const terminal = await job("blocked", "SYNTHETIC_TERMINAL_ERROR");
    const queued = await job();
    if (mode === "running")
      await f.db.query(
        "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1",
        [queued.id, crypto.randomUUID()],
      );
    if (mode === "reserved")
      await f.db.query(
        `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by)
        values($1,$2,$3,'fixture','openai','fixture-model','fixture',current_date,1,1,1,$4)`,
        [f.w, terminal.id, crypto.randomUUID(), f.owner],
      );
    if (mode === "restore")
      await f.db.query(
        "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
        [f.w, f.owner],
      );
    if (mode === "cancel")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [terminal.id],
      );
    if (mode === "future")
      await f.db.query(
        "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
        [queued.id],
      );
    if (mode === "throttled") {
      const completed = await job("succeeded");
      expect(await wake(completed.id)).toBe(true);
    }
    expect(await wake(terminal.id)).toBe(false);
    expect(await dispatches()).toBe(mode === "throttled" ? 1 : 0);
    if (mode === "throttled") {
      await f.db.exec(
        "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds'",
      );
      expect(await wake(terminal.id)).toBe(true);
      expect(await dispatches()).toBe(2);
    }
  },
);

it("reports cooldown only for an otherwise eligible wake and keeps the old boolean contract", async () => {
  const first = await job("succeeded");
  const terminal = await job("blocked", "SYNTHETIC_TERMINAL_ERROR");
  await job();
  expect(await wake(first.id)).toBe(true);
  const lease = crypto.randomUUID();
  const waiting = await wake(terminal.id, lease, true);
  expect(waiting.dispatched).toBe(false);
  expect(waiting.retry_after_ms).toBeGreaterThan(0);
  expect(waiting.retry_after_ms).toBeLessThanOrEqual(10000);
  expect(await wake(terminal.id, lease)).toBe(false);
  expect(await wake(first.id, lease, true)).toEqual({ dispatched: false });
  expect(await dispatches()).toBe(1);
});

it.each(["future", "running", "reserved", "restore", "cancel", "disabled"])(
  "does not suggest a cooldown retry when %s also prevents dispatch",
  async (mode) => {
    const first = await job("succeeded");
    const terminal = await job("blocked", "SYNTHETIC_TERMINAL_ERROR");
    const queued = await job();
    expect(await wake(first.id)).toBe(true);
    if (mode === "future")
      await f.db.query(
        "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
        [queued.id],
      );
    if (mode === "running")
      await f.db.query(
        "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1",
        [queued.id, crypto.randomUUID()],
      );
    if (mode === "reserved")
      await f.db.query(
        `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by)
        values($1,$2,$3,'fixture','openai','fixture-model','fixture',current_date,1,1,1,$4)`,
        [f.w, terminal.id, crypto.randomUUID(), f.owner],
      );
    if (mode === "restore")
      await f.db.query(
        "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
        [f.w, f.owner],
      );
    if (mode === "cancel")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [terminal.id],
      );
    if (mode === "disabled")
      await f.db.exec(
        "update app_private.dispatcher_settings set enabled=false",
      );
    expect(await wake(terminal.id, crypto.randomUUID(), true)).toEqual({
      dispatched: false,
    });
    expect(await dispatches()).toBe(1);
  },
);

it.each([false, true])(
  "a bounded deferred wake rechecks the actual database guards after waiting (another claim: %s)",
  async (claimedDuringWait) => {
    const first = await job("succeeded");
    const terminal = await job("blocked", "SYNTHETIC_TERMINAL_ERROR");
    const queued = await job();
    expect(await wake(first.id)).toBe(true);
    let clock = 1000;
    const lease = crypto.randomUUID();
    const internal = vi.fn(async (_name: string, args: any) =>
      wake(args.job_id, args.lease, true),
    );
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(10000);
      clock += ms;
      await f.db.exec(
        "update app_private.worker_queue_wakes set dispatched_at=clock_timestamp()-interval '11 seconds'",
      );
      if (claimedDuringWait)
        expect((await f.rpc("claim_backend_job_v2")).id).toBe(queued.id);
    });
    await wakeReadyQueue(
      { internal, invocationStartedAt: 0, invocationBudgetMs: 130000 },
      { id: terminal.id, lease_token: lease },
      { now: () => clock, sleep },
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(internal).toHaveBeenCalledTimes(2);
    expect(
      internal.mock.calls.every(
        ([name]) => name === "wake_backend_queue_status",
      ),
    ).toBe(true);
    expect(await dispatches()).toBe(claimedDuringWait ? 1 : 2);
    expect(
      (
        await f.db.query<any>(
          "select status,lease_token,attempts from public.jobs where id=$1",
          [terminal.id],
        )
      ).rows[0],
    ).toEqual({ status: "blocked", lease_token: null, attempts: 1 });
  },
);

it.each(["future", "failed-attempt", "saved-round", "wrong-lease"])(
  "does not accelerate a graph continuation with %s",
  async (mode) => {
    const continuation = await job("retry_wait", "MODEL_IN_PROGRESS", {
      graph_thread: "a".repeat(64),
      ...(mode === "saved-round" ? { model_round: { remaining: [] } } : {}),
    });
    const lease = crypto.randomUUID();
    await successfulAttempt(continuation.id, lease);
    if (mode === "future")
      await f.db.query(
        "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
        [continuation.id],
      );
    if (mode === "failed-attempt")
      await f.db.query(
        "update public.model_attempts set status='failed',result_code='EVIDENCE_REFERENCE_INVALID' where job_id=$1",
        [continuation.id],
      );
    await job();
    expect(
      await wake(
        continuation.id,
        mode === "wrong-lease" ? crypto.randomUUID() : lease,
      ),
    ).toBe(false);
    expect(await dispatches()).toBe(0);
  },
);

it.each(["none", "future", "capacity", "failed", "canceled", "new-executor"])(
  "does not dispatch when eligible queue is %s",
  async (mode) => {
    const completed = await job("succeeded");
    if (mode !== "none") {
      const queued = await job(
        mode === "capacity" || mode === "failed" ? "retry_wait" : "queued",
        mode === "capacity"
          ? "MODEL_RATE_WAIT"
          : mode === "failed"
            ? "SOURCE_TEMPORARY_FAILURE"
            : null,
        mode === "new-executor" ? { model_executor: 3 } : {},
      );
      if (mode === "future")
        await f.db.query(
          "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
          [queued.id],
        );
      if (mode === "canceled")
        await f.db.query(
          "update public.jobs set cancel_requested=true where id=$1",
          [queued.id],
        );
    }
    expect(await wake(completed.id)).toBe(false);
    expect(await dispatches()).toBe(0);
  },
);

it.each(["running", "reserved", "disabled", "restore"])(
  "preserves the %s global guard",
  async (mode) => {
    const completed = await job("succeeded");
    const queued = await job();
    if (mode === "running")
      await f.db.query(
        "update public.jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1",
        [queued.id, crypto.randomUUID()],
      );
    if (mode === "reserved")
      await f.db.query(
        `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by)
    values($1,$2,$3,'fixture','openai','fixture-model','fixture',current_date,1,1,1,$4)`,
        [f.w, completed.id, crypto.randomUUID(), f.owner],
      );
    if (mode === "disabled")
      await f.db.exec(
        "update app_private.dispatcher_settings set enabled=false",
      );
    if (mode === "restore")
      await f.db.query(
        "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
        [f.w, f.owner],
      );
    expect(await wake(completed.id)).toBe(false);
    expect(await dispatches()).toBe(0);
  },
);

it("restricts wake and its receipts to backend authority", async () => {
  for (const role of ["anon", "authenticated"])
    for (const name of [
      "public.wake_backend_queue(uuid,uuid)",
      "public.wake_backend_queue_status(uuid,uuid)",
      "public.wake_backend_queue_revision(uuid,uuid,bigint)",
      "app_private.wake_backend_queue_checked(uuid,uuid,bigint)",
    ])
      expect(
        (
          await f.db.query<any>(
            "select has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, name],
          )
        ).rows[0].allowed,
      ).toBe(false);
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('service_role','app_private.wake_backend_queue_checked(uuid,uuid,bigint)','EXECUTE') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('service_role','public.wake_backend_queue(uuid,uuid)','EXECUTE') allowed",
      )
    ).rows[0].allowed,
  ).toBe(true);
  expect(
    (
      await f.db.query<any>(
        "select has_table_privilege('service_role','app_private.worker_queue_wakes','SELECT') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
});

it.each([false, true])(
  "worker attempts one wake after durable success; dispatch failure remains nonfatal (%s)",
  async (failWake) => {
    const completed = await job("running"),
      queued = await job();
    const lease = crypto.randomUUID();
    completed.lease_token = lease;
    await f.db.query(
      "update public.jobs set lease_token=$2,lease_until=now()+interval '3 minutes' where id=$1",
      [completed.id, lease],
    );
    if (failWake)
      await f.db.exec(
        "create or replace function app_private.dispatch_backend() returns void language plpgsql as $$ begin raise exception 'fixture dispatcher unavailable';end $$",
      );
    processGeneration.mockImplementation(async () => {
      await f.db.query(
        "update public.jobs set status='succeeded',lease_token=null,lease_until=null,revision=revision+1 where id=$1",
        [completed.id],
      );
    });
    const internal = vi.fn(async (name: string, args: any = {}) => {
      if (name === "wake_backend_queue_status")
        return wake(args.job_id, args.lease, true);
      return name === "claim_storage_cleanup" ? [] : null;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env: BackendEnvironment = {
      url: "https://synthetic.supabase.co",
      publishableKey: "fixture",
      serviceKey: "fixture",
      allowedOrigins: [],
      workerSecret: "fixture-worker",
      models: modelEnvironments(() => undefined),
    };
    const handler = createWorkerHandler(
      env,
      async () => [],
      () => ({ internal, claim: async () => completed }) as unknown as Backend,
    );
    const response = await handler(
      new Request("https://synthetic.test/worker", {
        method: "POST",
        headers: { "x-worker-secret": env.workerSecret },
      }),
    );
    expect(response.status).toBe(200);
    expect(
      internal.mock.calls.filter(
        ([name]) => name === "wake_backend_queue_status",
      ),
    ).toHaveLength(1);
    expect(
      (
        await f.db.query<any>(
          "select status,lease_token from public.jobs where id=$1",
          [completed.id],
        )
      ).rows[0],
    ).toEqual({ status: "succeeded", lease_token: null });
    expect(
      (
        await f.db.query<any>("select status from public.jobs where id=$1", [
          queued.id,
        ])
      ).rows[0].status,
    ).toBe("queued");
    expect(await dispatches()).toBe(failWake ? 0 : 1);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from app_private.worker_queue_wakes",
        )
      ).rows[0].count,
    ).toBe(failWake ? 0 : 1);
    expect(
      warning.mock.calls.some(
        ([message]) => message === "queue_wakeup_pending",
      ),
    ).toBe(failWake);
  },
);
