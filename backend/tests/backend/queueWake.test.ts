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
  ["canceled", null],
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

it.each(["blocked", "failed"])(
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

it.each(["blocked", "failed"])(
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
    for (const name of ["wake_backend_queue", "wake_backend_queue_status"])
      expect(
        (
          await f.db.query<any>(
            "select has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, `public.${name}(uuid,uuid)`],
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
