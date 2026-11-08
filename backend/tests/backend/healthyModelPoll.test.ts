// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const row = async (sql: string, args: unknown[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
async function accepted() {
  const job = await row(
    `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,
    lease_token,lease_until,attempts,checkpoint) values($1,'model_probe',$1,repeat('a',64),'running',$2,
    gen_random_uuid(),now()+interval '3 minutes',1,'{"model_executor":2}'::jsonb) returning *`,
    [f.w, f.owner],
  );
  const usage = await row(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
    application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    values($1,$2,$3,$4,'openai','synthetic-model',repeat('a',64),current_date,1,100,100,'reserved',
    'resp_synthetic',now()+interval '1 hour',$5) returning *`,
    [f.w, job.id, job.lease_token, crypto.randomUUID(), f.owner],
  );
  return { job, usage };
}
async function receipt(
  x: Awaited<ReturnType<typeof accepted>>,
  overrides: Record<string, any> = {},
) {
  const value = {
    lease: x.job.lease_token,
    usage: x.usage.id,
    phase: "generation",
    status: "waiting",
    code: "MODEL_IN_PROGRESS",
    http: 200,
    retry: null,
    finished: true,
    model: "synthetic-model",
    ...overrides,
  };
  await f.db.query(
    `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,
    round_number,worker_attempt,status,result_code,sent,usage_id,request_phase,http_status,retry_after,finished_at)
    values($1,$2,$3,'openai',$4,'connection_probe',1,1,$5,$6,true,$7,$8,$9,$10,
      case when $11 then clock_timestamp() else null end)`,
    [
      f.w,
      x.job.id,
      value.lease,
      value.model,
      value.status,
      value.code,
      value.usage,
      value.phase,
      value.http,
      value.retry,
      value.finished,
    ],
  );
}
async function defer(
  x: Awaited<ReturnType<typeof accepted>>,
  lease = x.job.lease_token,
  usage = x.usage.id,
  retry?: string,
) {
  await f.db.exec("savepoint poll_call; set local role service_role");
  try {
    await f.rpc(
      retry === undefined
        ? "defer_pending_model_request"
        : "defer_model_request",
      retry === undefined
        ? [x.job.id, lease, usage]
        : [x.job.id, lease, usage, retry],
    );
  } catch (error) {
    await f.db.exec("rollback to savepoint poll_call");
    throw error;
  } finally {
    await f.db.exec("reset role; release savepoint poll_call");
  }
}
const timing = async (id: string) =>
  row(
    `select status,error_code,lease_token,
 extract(epoch from next_attempt_at-now())::int delay from public.jobs where id=$1`,
    [id],
  );

it.each([0, 1, 2, 3, 20])(
  "uses only %i completed healthy polls of this reservation for bounded backoff",
  async (count) => {
    const x = await accepted();
    for (let i = 0; i < count; i++)
      await receipt(x, {
        phase: "poll",
        lease: i === count - 1 ? x.job.lease_token : crypto.randomUUID(),
      });
    if (!count) await receipt(x);
    await defer(x);
    expect(await timing(x.job.id)).toEqual({
      status: "retry_wait",
      error_code: "MODEL_IN_PROGRESS",
      lease_token: null,
      delay: [5, 10, 15, 30][Math.min(count, 3)],
    });
    expect(
      await row("select * from public.provider_usage where id=$1", [
        x.usage.id,
      ]),
    ).toEqual(x.usage);
    expect(
      (await row("select count(*)::int n from public.provider_usage")).n,
    ).toBe(1);
    await expect(defer(x)).rejects.toThrow("STALE_LEASE");
  },
);

it("does not count different reservations, unrelated jobs, failed or incomplete polls", async () => {
  const other = await accepted();
  await receipt(other, { phase: "poll" });
  await defer(other);
  const otherBefore = await row("select * from public.jobs where id=$1", [
    other.job.id,
  ]);
  const x = await accepted();
  const prior = await row(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
    application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    select workspace_id,job_id,lease_token,'prior-call',provider,model,input_hash,application_day,settings_revision,
    reserved_input,reserved_output,'settled','resp_prior',remote_deadline,created_by from public.provider_usage where id=$1 returning *`,
    [x.usage.id],
  );
  await receipt(x, {
    phase: "poll",
    usage: prior.id,
    lease: crypto.randomUUID(),
  });
  await receipt(x, {
    phase: "poll",
    status: "failed",
    code: "PROVIDER_QUOTA_WAIT",
    http: 429,
    lease: crypto.randomUUID(),
  });
  await receipt(x, {
    phase: "poll",
    finished: false,
    lease: crypto.randomUUID(),
  });
  await receipt(x, {
    phase: "poll",
    model: "different-model",
    lease: crypto.randomUUID(),
  });
  await receipt(x, {
    phase: "poll",
    retry: "2030-01-01T00:00:00Z",
    lease: crypto.randomUUID(),
  });
  await receipt(x);
  await defer(x);
  expect((await timing(x.job.id)).delay).toBe(5);
  expect(
    await row("select * from public.jobs where id=$1", [other.job.id]),
  ).toEqual(otherBefore);
});

it.each([
  "absent",
  "prior-lease",
  "failed",
  "retry-after",
  "wrong-usage",
  "unfinished",
])(
  "keeps historical cadence without a current exact healthy receipt: %s",
  async (mode) => {
    const x = await accepted();
    if (mode === "prior-lease")
      await receipt(x, { lease: crypto.randomUUID() });
    if (mode === "failed")
      await receipt(x, {
        status: "failed",
        code: "PROVIDER_QUOTA_WAIT",
        http: 429,
      });
    if (mode === "retry-after")
      await receipt(x, { retry: "2030-01-01T00:00:00Z" });
    if (mode === "wrong-usage") await receipt(x, { usage: null });
    if (mode === "unfinished") await receipt(x, { finished: false });
    await defer(x);
    expect((await timing(x.job.id)).delay).toBe(30);
  },
);

it.each([
  "lease",
  "expired-lease",
  "canceled",
  "expired-remote",
  "wrong-reservation",
])(
  "retains accepted-request rejection before any mutation: %s",
  async (kind) => {
    const x = await accepted();
    await receipt(x);
    if (kind === "expired-lease")
      await f.db.query(
        "update jobs set lease_until=now()-interval '1 second' where id=$1",
        [x.job.id],
      );
    if (kind === "canceled")
      await f.db.query("update jobs set cancel_requested=true where id=$1", [
        x.job.id,
      ]);
    if (kind === "expired-remote")
      await f.db.query(
        "update provider_usage set remote_deadline=now()-interval '1 second' where id=$1",
        [x.usage.id],
      );
    const beforeJob = await row("select * from jobs where id=$1", [x.job.id]);
    const beforeUsage = await row("select * from provider_usage where id=$1", [
      x.usage.id,
    ]);
    await expect(
      defer(
        x,
        kind === "lease" ? crypto.randomUUID() : x.job.lease_token,
        kind === "wrong-reservation" ? crypto.randomUUID() : x.usage.id,
      ),
    ).rejects.toThrow(
      kind === "expired-remote"
        ? "MODEL_RESULT_EXPIRED"
        : kind === "wrong-reservation"
          ? "MODEL_CALL_ALREADY_RESERVED"
          : "STALE_LEASE",
    );
    expect(await row("select * from jobs where id=$1", [x.job.id])).toEqual(
      beforeJob,
    );
    expect(
      await row("select * from provider_usage where id=$1", [x.usage.id]),
    ).toEqual(beforeUsage);
  },
);

it("never extends the original remote deadline and preserves provider Retry-After independently", async () => {
  const x = await accepted();
  await receipt(x);
  await f.db.query(
    "update provider_usage set remote_deadline=now()+interval '3 seconds' where id=$1",
    [x.usage.id],
  );
  await defer(x);
  expect((await timing(x.job.id)).delay).toBe(3);
  const other = await accepted();
  const retry = (await row("select now()+interval '10 minutes' retry_at"))
    .retry_at;
  await receipt(other, { phase: "poll", status: "waiting", http: 429, retry });
  await defer(other, other.job.lease_token, other.usage.id, retry);
  expect((await timing(other.job.id)).delay).toBe(600);
  expect(
    await row("select * from provider_usage where id=$1", [other.usage.id]),
  ).toEqual(other.usage);
});

it("preserves service-only authority and rejects an unexpected predecessor function body", async () => {
  const definition =
    await row(`select p.prosrc,has_function_privilege('anon',p.oid,'execute') anon,
    has_function_privilege('authenticated',p.oid,'execute') browser,
    has_function_privilege('service_role',p.oid,'execute') service,p.prosecdef,p.proconfig
    from pg_proc p where p.oid='public.defer_pending_model_request(uuid,uuid,uuid)'::regprocedure`);
  expect(definition).toMatchObject({
    anon: false,
    browser: false,
    service: true,
    prosecdef: true,
    proconfig: ['search_path=""'],
  });
  await f.db.exec("savepoint migration_replay");
  await expect(
    f.db.exec(
      readFileSync(
        "supabase/migrations/20261108180821_healthy_model_poll_backoff.sql",
        "utf8",
      ),
    ),
  ).rejects.toThrow("HEALTHY_POLL_POLICY_CHANGED");
  await f.db.exec(
    "rollback to savepoint migration_replay; release savepoint migration_replay",
  );
  expect(
    (
      await row(
        "select prosrc from pg_proc where oid='public.defer_pending_model_request(uuid,uuid,uuid)'::regprocedure",
      )
    ).prosrc,
  ).toBe(definition.prosrc);
});
