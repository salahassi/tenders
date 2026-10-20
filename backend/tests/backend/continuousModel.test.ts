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
function worker(
  fetcher: typeof fetch,
  cleanup: typeof fetch = async () => new Response(null, { status: 204 }),
) {
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
    (url, init) =>
      init?.method === "DELETE" ? cleanup(url, init) : fetcher(url, init),
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
const ready = (id = "synthetic-check") =>
  Response.json({
    id,
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
  });

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

it("supports provider-managed quotas without billing attestations while retaining valid quota shape and Owner authority", async () => {
  for (const provider of [
    "gemini_free",
    "qwen_free",
    "mistral_free",
    "groq_free",
    "zai_free",
    "openai",
    "anthropic",
  ]) {
    const input = {
      ...policy,
      provider,
      free_only: false,
      billing_verified: false,
      free_quota_only: false,
    };
    expect(commandSchemas["model.configure"].safeParse(input).success).toBe(
      true,
    );
    expect((await f.command("model.configure", input)).enabled).toBe(true);
  }
  await expect(
    f.command("model.configure", {
      ...policy,
      expected_revision: 1,
      quota_remaining_tokens: 100,
    }),
  ).rejects.toThrow();
  expect(
    commandSchemas["model.configure"].safeParse({
      ...policy,
      quota_mode: "verified_budget",
    }).success,
  ).toBe(false);
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

it("retains uncertain requests while independent continuous Gemini checks can complete", async () => {
  await f.command("model.configure", policy);
  const original = await f.command("model.probe", {});
  let generations = 0;
  const tick = worker(async (url) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    generations++;
    if (generations === 1) throw Error("Synthetic connection lost after send");
    return ready();
  });
  await tick();
  expect((await job(original.id)).status).toBe("blocked");
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'",
  );
  // Even a new attempt/lease for the same job must never resend uncertain work.
  await f.db.query(
    "update public.jobs set status='queued',next_attempt_at=now() where id=$1",
    [original.id],
  );
  await tick();
  expect((await job(original.id)).error_code).toBe("USAGE_REVIEW_REQUIRED");
  expect(generations).toBe(1);
  const independent = await f.command("model.probe", {});
  expect(independent.id).not.toBe(original.id);
  await tick();
  expect((await job(independent.id)).status).toBe("succeeded");
  expect(generations).toBe(2);
  const usage = (
    await f.db.query<any>(
      "select * from public.provider_usage order by created_at",
    )
  ).rows;
  expect(usage).toHaveLength(2);
  expect(usage[0]).toMatchObject({
    state: "unknown",
    actual_input: null,
    actual_output: null,
    reserved_input: 276,
    reserved_output: 1024,
  });
  expect(usage[1]).toMatchObject({
    state: "settled",
    actual_input: 20,
    actual_output: 7,
  });
  expect(usage[0].input_hash).not.toBe(usage[1].input_hash);
});

it("does not bypass unknown request hashes, pending reservations, legacy policies or daily accounting", async () => {
  await f.command("model.configure", policy);
  await f.command("model.probe", {});
  await worker(async (url) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    throw Error("Synthetic uncertain delivery");
  })();
  const original = (
    await f.db.query<any>("select * from public.provider_usage")
  ).rows[0];
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'",
  );
  await f.command("model.probe", {});
  const claimed = await rpc("claim_backend_job");
  const args = {
    job_id: claimed.id,
    lease: claimed.lease_token,
    call_key: "independent",
    input_hash: original.input_hash,
    input_tokens: 276,
    output_tokens: 256,
    manifest: [],
    target_provider: "gemini_free",
  };
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "USAGE_REVIEW_REQUIRED",
  });
  args.input_hash = "f".repeat(64);
  await f.db.exec("update public.provider_usage set state='reserved'");
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "USAGE_REVIEW_REQUIRED",
  });
  await f.db.exec(
    "update public.provider_usage set state='unknown'; update public.model_settings set quota_mode='verified_budget',quota_ends_at=now()+interval '1 day',quota_remaining_tokens=100000",
  );
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "USAGE_REVIEW_REQUIRED",
  });
  await f.db.exec(
    "update public.model_settings set quota_mode='provider_managed',quota_ends_at=null,quota_remaining_tokens=null,calls_per_day=1",
  );
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "MODEL_DAILY_QUOTA_WAIT",
  });
  args.input_tokens = 800;
  args.output_tokens = 800;
  await f.db.exec(
    "update public.model_settings set calls_per_day=50,input_per_day=1000",
  );
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "MODEL_DAILY_QUOTA_WAIT",
  });
  await f.db.exec(
    "update public.model_settings set input_per_day=250000,output_per_day=1000",
  );
  await expect(rpc("reserve_model_call", args)).rejects.toMatchObject({
    code: "MODEL_DAILY_QUOTA_WAIT",
  });
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

it("also resumes an unsupported background request on legacy automatic routing", async () => {
  await f.command("model.configure", policy);
  await f.command("model.routing", {
    enabled: true,
    strategy: "priority",
    expected_revision: 0,
  });
  const queued = await f.command("model.probe", {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  const tick = worker(async (url, init) => {
    calls++;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    if (calls === 1) {
      expect(body.background).toBe(true);
      return Response.json(
        {
          error: {
            message: "Background processing is not supported for this model",
          },
        },
        { status: 400 },
      );
    }
    expect(calls).toBe(2);
    expect(body.background).toBeUndefined();
    expect(String(url)).toContain(":generateContent");
    return Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: '{"status":"ready"}' }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 0,
      },
    });
  });
  try {
    await tick();
    expect(await job(queued.id)).toMatchObject({
      status: "retry_wait",
      error_code: "MODEL_IN_PROGRESS",
    });
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [queued.id],
    );
    await tick();
    expect(await job(queued.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(calls).toBe(2);
  } finally {
    warning.mockRestore();
  }
});

it("polls one persisted background generation across leases and transient network failures", async () => {
  await f.command("model.configure", { ...policy, calls_per_day: 1 });
  const queued = await f.command("model.probe", {});
  const methods: string[] = [];
  let polls = 0;
  const tick = worker(async (url, init) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    methods.push(init!.method!);
    if (init!.method === "POST") {
      expect(JSON.parse(String(init!.body))).toMatchObject({
        background: true,
        store: true,
        generation_config: { max_output_tokens: 1024 },
      });
      expect(new Headers(init!.headers).get("Api-Revision")).toBe("2026-05-20");
      return Response.json({
        id: "synthetic-background",
        status: "in_progress",
      });
    }
    expect(String(url)).toMatch(/interactions\/synthetic-background$/);
    expect(init?.body).toBeUndefined();
    polls++;
    if (polls === 1) throw Error("Synthetic dropped GET response");
    if (polls === 2)
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "180" },
      });
    if (polls === 3)
      return Response.json({
        id: "synthetic-background",
        status: "in_progress",
      });
    return ready("synthetic-background");
  });
  for (let i = 0; i < 5; i++) {
    await f.db.exec(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where status='retry_wait'",
    );
    await tick();
    if (i < 4) {
      expect(await job(queued.id)).toMatchObject({
        status: "retry_wait",
        error_code: "MODEL_IN_PROGRESS",
      });
      expect(
        (
          await f.db.query<any>(
            "select state,remote_request_id from public.provider_usage",
          )
        ).rows,
      ).toEqual([
        { state: "reserved", remote_request_id: "synthetic-background" },
      ]);
    }
  }
  expect(methods).toEqual(["POST", "GET", "GET", "GET", "GET"]);
  expect(await job(queued.id)).toMatchObject({
    status: "succeeded",
    attempts: 5,
  });
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input,actual_output from public.provider_usage",
      )
    ).rows,
  ).toEqual([{ state: "settled", actual_input: 20, actual_output: 7 }]);
});

it("recovers a lost worker lease by retrieving the recorded request instead of creating another", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let creates = 0,
    gets = 0;
  const tick = worker(async (url, init) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    if (init!.method === "POST") {
      creates++;
      return Response.json({ id: "synthetic-crash", status: "in_progress" });
    }
    gets++;
    return ready("synthetic-crash");
  });
  await tick();
  await f.db.exec(
    "update public.jobs set next_attempt_at=now()-interval '1 second'",
  );
  const claimed = await rpc("claim_backend_job");
  const usage = (await f.db.query<any>("select * from public.provider_usage"))
    .rows[0];
  await rpc("resume_model_request", {
    job_id: queued.id,
    lease: claimed.lease_token,
    input_hash: usage.input_hash,
    target_provider: "gemini_free",
    manifest: [],
  });
  await f.db.exec(
    "update public.jobs set lease_until=now()-interval '1 second' where status='running'",
  );
  await tick();
  expect(creates).toBe(1);
  expect(gets).toBe(1);
  expect(await job(queued.id)).toMatchObject({
    status: "succeeded",
    attempts: 3,
  });
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(1);
});

it("keeps an expired background result unknown without resubmitting and rejects browser checkpoint writes", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let creates = 0;
  const tick = worker(async (url) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    creates++;
    return Response.json({ id: "synthetic-expired", status: "in_progress" });
  });
  await tick();
  for (const name of [
    "resume_model_request",
    "checkpoint_model_request",
    "defer_model_request",
  ]) {
    expect(
      (
        await f.db.query<any>(
          "select has_function_privilege('authenticated',p.oid,'execute') allowed from pg_proc p where proname=$1",
          [name],
        )
      ).rows[0].allowed,
    ).toBe(false);
  }
  await f.db.exec(
    "update public.provider_usage set remote_deadline=now()-interval '1 second'; update public.jobs set next_attempt_at=now()-interval '1 second'",
  );
  await tick();
  expect(creates).toBe(1);
  expect(await job(queued.id)).toMatchObject({
    status: "blocked",
    error_code: "MODEL_RESULT_EXPIRED",
  });
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input from public.provider_usage",
      )
    ).rows[0],
  ).toEqual({ state: "unknown", actual_input: null });
});

it("pins background identity and conservatively retains canceled usage", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  await worker(async (url) =>
    String(url).endsWith(":countTokens")
      ? Response.json({ totalTokens: 20 })
      : Response.json({ id: "synthetic-pinned", status: "in_progress" }),
  )();
  await f.db.exec(
    "update public.jobs set next_attempt_at=now()-interval '1 second'",
  );
  const claimed = await rpc("claim_backend_job");
  const usage = (await f.db.query<any>("select * from public.provider_usage"))
    .rows[0];
  const args = {
    job_id: queued.id,
    lease: claimed.lease_token,
    input_hash: "e".repeat(64),
    target_provider: "gemini_free",
    manifest: [],
  };
  await expect(rpc("resume_model_request", args)).rejects.toMatchObject({
    code: "MODEL_IDENTITY_CHANGED",
  });
  args.input_hash = usage.input_hash;
  await rpc("resume_model_request", args);
  await expect(
    rpc("checkpoint_model_request", {
      job_id: queued.id,
      lease: claimed.lease_token,
      reservation: usage.id,
      remote_id: "synthetic-other",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await rpc("defer_model_request", {
    job_id: queued.id,
    lease: claimed.lease_token,
    reservation: usage.id,
  });
  const current = await job(queued.id);
  await f.command("job.action", {
    id: queued.id,
    expected_revision: current.revision,
    action: "cancel",
    reason: "Synthetic cancellation acceptance",
  });
  expect(await job(queued.id)).toMatchObject({ status: "canceled" });
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input,remote_request_id from public.provider_usage",
      )
    ).rows[0],
  ).toEqual({
    state: "unknown",
    actual_input: null,
    remote_request_id: "synthetic-pinned",
  });
});

it("reconciles canceled background usage by GET only and never publishes the canceled result", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let posts = 0,
    gets = 0;
  const tick = worker(async (url, init) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 20 });
    if (init?.method === "POST") {
      posts++;
      return Response.json({
        id: "synthetic-abandoned",
        status: "in_progress",
      });
    }
    gets++;
    return gets === 1
      ? new Response(null, { status: 503 })
      : ready("synthetic-abandoned");
  });
  await tick();
  const current = await job(queued.id);
  await f.command("job.action", {
    id: queued.id,
    expected_revision: current.revision,
    action: "cancel",
    reason: "Synthetic evidence superseded",
  });
  await tick();
  await tick();
  expect(gets).toBe(1); // Throttled after a failed GET, with unknown usage retained.
  expect(
    (await f.db.query<any>("select state from public.provider_usage")).rows[0]
      .state,
  ).toBe("unknown");
  await f.db.exec(
    "update public.provider_usage set reconciliation_after=now()-interval '1 second'",
  );
  await tick();
  expect(posts).toBe(1);
  expect(gets).toBe(2);
  expect((await job(queued.id)).status).toBe("canceled");
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input,actual_output,error_code from public.provider_usage",
      )
    ).rows,
  ).toEqual([
    {
      state: "settled",
      actual_input: 20,
      actual_output: 7,
      error_code: "SUPERSEDED_RESULT_RECONCILED",
    },
  ]);
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','public.claim_abandoned_model_request()','execute') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
});

it("deletes stored provider output only after the verified job result commits", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  let deleted = false;
  await worker(
    async (url) =>
      String(url).endsWith(":countTokens")
        ? Response.json({ totalTokens: 20 })
        : ready("synthetic-delete"),
    async (url, init) => {
      expect(init?.method).toBe("DELETE");
      expect(String(url)).toMatch(/interactions\/synthetic-delete$/);
      expect((await job(queued.id)).status).toBe("succeeded");
      deleted = true;
      return new Response(null, { status: 204 });
    },
  )();
  expect(deleted).toBe(true);
});

it("keeps committed model success if provider cleanup is temporarily unavailable", async () => {
  await f.command("model.configure", policy);
  const queued = await f.command("model.probe", {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await worker(
    async (url) =>
      String(url).endsWith(":countTokens")
        ? Response.json({ totalTokens: 20 })
        : ready("synthetic-cleanup-failure"),
    async () => new Response(null, { status: 503 }),
  )();
  expect((await job(queued.id)).status).toBe("succeeded");
  expect(warning).toHaveBeenCalledWith("provider_request_cleanup_pending");
  warning.mockRestore();
});
