// @vitest-environment node
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const policy = {
  expected_revision: 0,
  enabled: true,
  provider: "gemini_free",
  model: "gemini-3.8-flash",
  project_ref: "synthetic-project",
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
};
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  if (![name, ...entries.map(([key]) => key)].every((x) => /^[a-z_]+$/.test(x)))
    throw Error("Bad fixture identifier");
  await f.db.exec("savepoint worker_rpc; set local role service_role");
  try {
    return (
      await f.db.query<{ data: any }>(
        `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) data`,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).rows[0]?.data;
  } catch (e) {
    await f.db.exec("rollback to savepoint worker_rpc");
    throw databaseError(e as Error);
  } finally {
    await f.db.exec("reset role; release savepoint worker_rpc");
  }
}
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-private",
  workerSecret: "synthetic-worker",
  allowedOrigins: [],
  models: modelEnvironments(
    (name) =>
      ({
        APP_MODEL_GEMINI_NAME: policy.model,
        APP_MODEL_GEMINI_PROJECT: policy.project_ref,
        APP_MODEL_GEMINI_KEY: "synthetic-provider-key",
      })[name],
  ),
};
function worker(fetcher: typeof fetch) {
  const backend = {
    internal: rpc,
    claim: () => rpc("claim_backend_job"),
    finish: (
      job_id: string,
      lease: string,
      result_status: string,
      result_error: string | null,
    ) =>
      rpc("finish_backend_job", { job_id, lease, result_status, result_error }),
  };
  const handle = createWorkerHandler(
    env,
    async () => [],
    () => backend as unknown as Backend,
    fetcher,
  );
  return async () => {
    const response = await handle(
      new Request("https://worker.example.test", {
        method: "POST",
        headers: { "x-worker-secret": env.workerSecret },
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  };
}
const ready = () =>
  new Response(
    JSON.stringify({
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: '{"status":"ready"}' }],
        },
      ],
      usage: {
        total_input_tokens: 20,
        total_output_tokens: 7,
        total_thought_tokens: 0,
      },
    }),
  );
async function job(id: string) {
  return (await f.db.query<any>("select * from public.jobs where id=$1", [id]))
    .rows[0];
}

it("saves an attested continuous Gemini policy without an invented quota or periodic expiry", async () => {
  expect(commandSchemas["model.configure"].parse(policy)).toMatchObject({
    quota_remaining_tokens: null,
    quota_ends_at: null,
  });
  const saved = await f.command("model.configure", policy);
  expect(saved.quota_mode).toBe("provider_managed");
  await f.db.exec(
    "update public.model_settings set verified_at=now()-interval '100 days'",
  );
  const queued = await f.command(
    "model.probe",
    {},
    "00000000-0000-4000-8000-000000000010",
  );
  expect(
    (await f.command("model.probe", {}, "00000000-0000-4000-8000-000000000010"))
      .id,
  ).toBe(queued.id);
  expect(
    (await f.command("model.probe", {}, "00000000-0000-4000-8000-000000000011"))
      .id,
  ).toBe(queued.id);
  const claimed = await rpc("claim_backend_job");
  await expect(
    rpc("finish_backend_job", {
      job_id: claimed.id,
      lease: claimed.lease_token,
      result_status: "succeeded",
      result_error: null,
    }),
  ).rejects.toMatchObject({ code: "HANDLER_NOT_IMPLEMENTED" });
  const pool = await rpc("model_preflight", {
    job_id: claimed.id,
    lease: claimed.lease_token,
    manifest: [],
  });
  expect(pool.providers).toHaveLength(1);
  await expect(
    rpc("model_preflight", {
      job_id: claimed.id,
      lease: claimed.lease_token,
      manifest: [{ content: "not allowed" }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await f.db.query(
    "update public.jobs set type='classify_opportunity' where id=$1",
    [claimed.id],
  );
  await expect(
    rpc("model_preflight", {
      job_id: claimed.id,
      lease: claimed.lease_token,
      manifest: [],
    }),
  ).rejects.toMatchObject({ code: "DATA_AUTHORIZATION_REQUIRED" });
});

it("keeps provider-managed mode restricted to Gemini and requires the Owner's free-tier attestation", async () => {
  for (const patch of [
    { provider: "qwen_free", free_quota_only: true },
    { billing_verified: false },
    { quota_remaining_tokens: 100 },
  ]) {
    await expect(
      f.command("model.configure", { ...policy, ...patch }),
    ).rejects.toThrow();
  }
  expect(
    commandSchemas["model.configure"].safeParse({
      ...policy,
      provider: "qwen_free",
    }).success,
  ).toBe(false);
  expect(
    commandSchemas["model.configure"].safeParse({
      ...policy,
      quota_mode: "verified_budget",
    }).success,
  ).toBe(false);
  await f.command("model.configure", policy);
  await f.db.query(
    "update public.memberships set role='Reviewer' where user_id=$1",
    [f.owner],
  );
  await expect(f.command("model.probe", {})).rejects.toThrow("ROLE_FORBIDDEN");
});

it("resumes the same durable probe after a headerless 429 and records measured usage on success", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let generations = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith(":countTokens")
      ? new Response('{"totalTokens":20}')
      : ++generations === 1
        ? new Response("", { status: 429 })
        : ready(),
  );
  const tick = worker(fetcher);
  await tick();
  const waiting = await job(queued.id);
  expect(waiting.status).toBe("quota_wait");
  expect(waiting.error_code).toBe("PROVIDER_QUOTA_WAIT");
  expect(Date.parse(waiting.next_attempt_at)).toBeGreaterThan(Date.now());
  expect(Date.parse(waiting.next_attempt_at)).toBeLessThan(Date.now() + 120000);
  expect((await tick()).data.claimed).toBe(false);
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'",
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [queued.id],
  );
  await tick();
  const completed = await job(queued.id);
  expect(completed).toMatchObject({ status: "succeeded", error_code: null });
  expect(completed.attempts).toBe(2);
  expect(generations).toBe(2);
  const usage = (
    await f.db.query<any>(
      "select * from public.provider_usage order by created_at",
    )
  ).rows;
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({
    state: "settled",
    actual_input: null,
    error_code: "PROVIDER_QUOTA_WAIT",
  });
  expect(usage[1]).toMatchObject({
    state: "settled",
    actual_input: 20,
    actual_output: 7,
  });
  expect(
    (await f.db.query("select id from public.opportunities")).rows,
  ).toHaveLength(0);
});

it("keeps uncertain generation usage blocked instead of repeating the request", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let generations = 0;
  const tick = worker(async (url) => {
    if (String(url).endsWith(":countTokens"))
      return new Response('{"totalTokens":20}');
    generations++;
    throw Error("Synthetic connection lost after send");
  });
  await tick();
  expect((await job(queued.id)).status).toBe("blocked");
  expect(
    (await f.db.query<any>("select state from public.provider_usage")).rows[0]
      .state,
  ).toBe("unknown");
  await f.command("model.probe", {});
  await tick();
  expect(generations).toBe(1);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(1);
});

it("honors finite Retry-After and bounds invalid or repeated provider quota waits", async () => {
  await f.command("model.configure", policy);
  await f.command("model.probe", {});
  for (const [retryAfter, attempts, expectedSeconds] of [
    [null, 50, 3600],
    ["infinity", 1, 60],
    ["2020-01-01T00:00:00Z", 1, 60],
  ] as const) {
    await f.db.exec(
      "update public.jobs set next_attempt_at=now()-interval '1 second'",
    );
    const claimed = await rpc("claim_backend_job");
    await f.db.query("update public.jobs set attempts=$1 where id=$2", [
      attempts,
      claimed.id,
    ]);
    await rpc("fail_generation", {
      job_id: claimed.id,
      lease: claimed.lease_token,
      error_code: "PROVIDER_QUOTA_WAIT",
      retry_after: retryAfter,
    });
    const delay = (
      await f.db.query<any>(
        "select extract(epoch from next_attempt_at-now()) seconds from public.jobs where id=$1",
        [claimed.id],
      )
    ).rows[0].seconds;
    expect(Number(delay)).toBe(expectedSeconds);
  }
  await f.db.exec(
    "update public.jobs set next_attempt_at=now()-interval '1 second'",
  );
  const claimed = await rpc("claim_backend_job");
  const next = new Date(Date.now() + 600000).toISOString();
  await rpc("fail_generation", {
    job_id: claimed.id,
    lease: claimed.lease_token,
    error_code: "PROVIDER_QUOTA_WAIT",
    retry_after: next,
  });
  expect(new Date((await job(claimed.id)).next_attempt_at).toISOString()).toBe(
    next,
  );
});

it("retains daily application limits and resumes after the next application day", async () => {
  await f.command("model.configure", { ...policy, calls_per_day: 1 });
  const tick = worker(async (url) =>
    String(url).endsWith(":countTokens")
      ? new Response('{"totalTokens":20}')
      : ready(),
  );
  await f.command("model.probe", {});
  await tick();
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'",
  );
  const queued = await f.command("model.probe", {});
  await tick();
  const waiting = await job(queued.id);
  expect(waiting.error_code).toBe("MODEL_DAILY_QUOTA_WAIT");
  expect(waiting.status).toBe("quota_wait");
  const expected = (
    await f.db.query<any>(
      "select (((now() at time zone 'Asia/Riyadh')::date+1)::timestamp at time zone 'Asia/Riyadh') next_day",
    )
  ).rows[0].next_day;
  expect(waiting.next_attempt_at).toEqual(expected);
  await f.db.exec(
    "update public.provider_usage set application_day=application_day-1",
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [queued.id],
  );
  await tick();
  expect((await job(queued.id)).status).toBe("succeeded");
});
