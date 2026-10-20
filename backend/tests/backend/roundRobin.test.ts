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
import { ROUND_ROBIN_PROVIDERS } from "../../supabase/functions/_shared/modelProviders";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint routing_rpc; set local role service_role");
  try {
    return (
      await f.db.query<{ data: any }>(
        `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) data`,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).rows[0]?.data;
  } catch (e) {
    await f.db.exec("rollback to savepoint routing_rpc");
    throw databaseError(e as Error);
  } finally {
    await f.db.exec("reset role; release savepoint routing_rpc");
  }
}
const models = modelEnvironments((name) => {
  if (name.startsWith("APP_MODEL_")) {
    if (name.endsWith("_KEY")) return "synthetic-key";
    if (name.endsWith("_NAME"))
      return name.includes("GEMINI") ? "gemini-3.8-flash" : "synthetic-model";
    if (name.endsWith("_PROJECT"))
      return name.includes("CLOUDFLARE")
        ? "syntheticaccount"
        : "synthetic-project";
    if (name.endsWith("_FREE_ONLY")) return "true";
  }
  return undefined;
});
const environment: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-private",
  workerSecret: "synthetic-worker",
  allowedOrigins: [],
  models,
};
const meta = (slots = environment.models) =>
  ROUND_ROBIN_PROVIDERS.map((provider) => ({
    provider,
    model: slots[provider].model,
    project_ref: slots[provider].projectRef,
    key_configured: Boolean(slots[provider].key),
  }));
async function enable() {
  return f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
}
async function queue() {
  return f.command("model.probe", {});
}
async function job(id: string) {
  return (await f.db.query<any>("select * from public.jobs where id=$1", [id]))
    .rows[0];
}
async function usage(id: string) {
  return (
    await f.db.query<any>(
      "select * from public.provider_usage where job_id=$1 order by created_at,id",
      [id],
    )
  ).rows;
}
function worker(fetcher: typeof fetch, env = environment) {
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
  const handler = createWorkerHandler(
    env,
    async () => [],
    () => backend as unknown as Backend,
    fetcher,
  );
  return () =>
    handler(
      new Request("https://synthetic.test/worker", {
        method: "POST",
        headers: { "x-worker-secret": env.workerSecret },
      }),
    );
}
function providerOf(url: string) {
  return url.includes("api.cloudflare.com")
    ? "cloudflare_free"
    : url.includes("googleapis")
      ? "gemini_free"
      : url.includes("aliyuncs")
        ? "qwen_free"
        : url.includes("mistral.ai")
          ? "mistral_free"
          : url.includes("api.openai.com")
            ? "openai"
            : url.includes("api.anthropic.com")
              ? "anthropic"
              : url.includes("api.z.ai")
                ? "zai_free"
                : "groq_free";
}
function success(provider: string, id = "synthetic-request") {
  if (provider === "openai")
    return Response.json({
      id,
      model: "synthetic-model",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"status":"ready"}' }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
  if (provider === "anthropic")
    return Response.json({
      id,
      model: "synthetic-model",
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"status":"ready"}' }],
      usage: {
        input_tokens: 80,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 15,
        output_tokens: 10,
      },
    });
  return provider === "gemini_free"
    ? Response.json({
        id,
        status: "completed",
        usage: {
          total_input_tokens: 100,
          total_output_tokens: 10,
          total_thought_tokens: 0,
        },
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: '{"status":"ready"}' }],
          },
        ],
      })
    : Response.json({
        choices: [
          { finish_reason: "stop", message: { content: '{"status":"ready"}' } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
}
function transport(
  call: (
    provider: string,
    url: string,
    init?: RequestInit,
  ) => Promise<Response> | Response,
): typeof fetch {
  return vi.fn(async (url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 100 });
    return call(providerOf(String(url)), String(url), init);
  }) as typeof fetch;
}
async function age() {
  // Advance inferred provider backoff along with the reservation clock.
  // Explicit Retry-After timestamps remain under each test's control.
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'; update public.model_attempts set started_at=now()-interval '2 minutes'; update public.jobs set next_attempt_at=now()-interval '1 second' where status in ('quota_wait','retry_wait')",
  );
}

it.each(["priority", "round_robin"] as const)(
  "continues a slow provider round across leases without resending or changing its round number: %s",
  async (strategy) => {
    await f.command("model.routing", {
      enabled: true,
      expected_revision: 0,
      strategy,
    });
    const q = await queue();
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const sent: string[] = [];
    try {
      const run = worker(
        transport((provider) => {
          sent.push(provider);
          if (provider === "gemini_free") {
            clock += 90000;
            return Response.json(
              { error: { code: "rate_limit" } },
              { status: 429 },
            );
          }
          return success(provider);
        }),
      );
      expect((await run()).status).toBe(200);
      const first = await job(q.id);
      expect(first).toMatchObject({
        status: "retry_wait",
        error_code: "MODEL_IN_PROGRESS",
        lease_token: null,
        failure_count: 0,
      });
      expect(
        first.checkpoint.model_round.remaining.map((p: any) => p.provider),
      ).not.toContain("gemini_free");
      expect(first.checkpoint.model_routing.round_attempts).toBe(1);
      expect(sent).toEqual(["gemini_free"]);
      expect((await run()).status).toBe(200);
      const second = await job(q.id);
      expect(second.status).toBe("succeeded");
      expect(second.attempts).toBe(2);
      expect(second.checkpoint.model_round).toBeUndefined();
      expect(second.checkpoint.model_routing.round_attempts).toBe(1);
      expect(sent).toEqual(["gemini_free", "qwen_free"]);
      expect(await usage(q.id)).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  },
);

it("keeps round checkpoints private, input-bound, lease-bound and canceled-job safe", async () => {
  await enable();
  const q = await queue();
  const j = await rpc("claim_backend_job");
  await rpc("prepare_model_routing", {
    job_id: j.id,
    lease: j.lease_token,
    server_models: meta(),
  });
  const state = {
    input_hash: "a".repeat(64),
    remaining: [
      {
        provider: "qwen_free",
        model: models.qwen_free.model,
        project_ref: models.qwen_free.projectRef,
      },
    ],
    output_error: "MODEL_OUTPUT_TRUNCATED",
    retry_windows: [null],
  };
  await rpc("save_model_round", {
    job_id: q.id,
    lease: j.lease_token,
    progress: state,
    release_job: false,
  });
  expect(
    await rpc("load_model_round", {
      job_id: q.id,
      lease: j.lease_token,
      input_hash: state.input_hash,
    }),
  ).toEqual(state);
  await expect(
    rpc("load_model_round", {
      job_id: q.id,
      lease: j.lease_token,
      input_hash: "b".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
  await expect(
    rpc("save_model_round", {
      job_id: q.id,
      lease: crypto.randomUUID(),
      progress: state,
      release_job: true,
    }),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
  await expect(
    rpc("save_model_round", {
      job_id: q.id,
      lease: j.lease_token,
      progress: {
        ...state,
        remaining: [{ ...state.remaining[0], model: "changed-model" }],
      },
      release_job: false,
    }),
  ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
  const grants = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','public.save_model_round(uuid,uuid,jsonb,boolean)','execute') as browser,has_function_privilege('service_role','public.load_model_round(uuid,uuid,text)','execute') as worker",
    )
  ).rows[0];
  expect(grants).toEqual({ browser: false, worker: true });
  await f.db.query("update public.jobs set cancel_requested=true where id=$1", [
    q.id,
  ]);
  await expect(
    rpc("save_model_round", {
      job_id: q.id,
      lease: j.lease_token,
      progress: state,
      release_job: true,
    }),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
});

it("records all eight missing slots and schedules retry without unauthenticated requests", async () => {
  await enable();
  const q = await queue();
  const send = vi.fn<typeof fetch>();
  await worker(send, {
    ...environment,
    models: modelEnvironments(() => undefined),
  })();
  const j = await job(q.id);
  expect(j.status).toBe("retry_wait");
  expect(j.error_code).toBe("MODEL_ROUND_EXHAUSTED");
  expect(Number.isFinite(Date.parse(j.next_attempt_at))).toBe(true);
  expect(j.checkpoint.model_routing.checks).toHaveLength(8);
  expect(
    j.checkpoint.model_routing.checks.every(
      (x: any) => x.code === "MODEL_NOT_CONFIGURED" && !x.sent,
    ),
  ).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(await usage(q.id)).toHaveLength(0);
});
it("falls through 400, 401 and 429 to Groq with all individual policies absent", async () => {
  await enable();
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return p === "groq_free"
        ? success(p)
        : new Response(null, {
            status: p === "gemini_free" ? 400 : p === "qwen_free" ? 401 : 429,
          });
    }),
  )();
  expect(calls).toEqual(ROUND_ROBIN_PROVIDERS.slice(0, 4));
  const j = await job(q.id);
  expect(j.status).toBe("succeeded");
  const rows = await usage(q.id);
  expect(rows).toHaveLength(4);
  expect(rows.every((x) => x.state === "settled")).toBe(true);
  expect(rows.find((x) => x.provider === "groq_free").actual_output).toBe(10);
  expect(
    (await f.db.query("select * from public.model_settings")).rows,
  ).toHaveLength(0);
  expect(j.checkpoint.model_routing.checks.map((x: any) => x.code)).toEqual([
    "PROVIDER_REQUEST_INVALID",
    "PROVIDER_AUTH_FAILED",
    "PROVIDER_QUOTA_WAIT",
    "SUCCEEDED",
  ]);
});
it("uses configured free providers even when their individual policy is disabled", async () => {
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: false,
    provider: "qwen_free",
    model: "synthetic-model",
    project_ref: "synthetic-project",
    free_only: true,
    billing_verified: true,
    free_quota_only: true,
    quota_mode: "verified_budget",
    quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
    quota_remaining_tokens: 100000,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
  });
  await enable();
  await f.db.exec("update public.model_routing set next_position=1");
  const q = await queue();
  const calls: string[] = [];
  const env = {
    ...environment,
    models: {
      ...models,
      qwen_free: { ...models.qwen_free },
    },
  };
  await worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
    env,
  )();
  expect(calls).toEqual(["qwen_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  expect(
    (
      await f.db.query<any>(
        "select enabled from public.model_settings where provider='qwen_free'",
      )
    ).rows[0].enabled,
  ).toBe(false);
});
it("rotates the first provider across independent jobs without resetting the durable cursor", async () => {
  await enable();
  const calls: string[] = [];
  const tick = worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
  );
  for (let i = 0; i < ROUND_ROBIN_PROVIDERS.length; i++) {
    const q = await queue();
    await tick();
    expect((await job(q.id)).status).toBe("succeeded");
    await age();
  }
  expect(calls).toEqual([...ROUND_ROBIN_PROVIDERS]);
}, 15000);
it("continues after uncertain delivery while retaining each unknown reservation and its budget", async () => {
  await enable();
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      if (p === "groq_free") return success(p);
      throw new TypeError("synthetic network interruption");
    }),
  )();
  expect(calls).toEqual(ROUND_ROBIN_PROVIDERS.slice(0, 4));
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = await usage(q.id);
  expect(rows.filter((x) => x.state === "unknown")).toHaveLength(3);
  expect(
    rows
      .filter((x) => x.state === "unknown")
      .every((x) => x.actual_input === null && x.reserved_input > 0),
  ).toBe(true);
});
it("retries with rotation, prevents immediate ambiguous duplicates, then permits a fresh round after cooldown", async () => {
  await enable();
  const q = await queue();
  const send = transport(() => {
    throw new TypeError("synthetic loss");
  });
  const tick = worker(send);
  await tick();
  expect((await job(q.id)).status).toBe("retry_wait");
  expect(await usage(q.id)).toHaveLength(8);
  await f.db.query(
    "update public.jobs set status='queued',next_attempt_at=now() where id=$1",
    [q.id],
  );
  await age();
  const before = vi.mocked(send).mock.calls.length;
  await tick();
  expect((await job(q.id)).status).toBe("retry_wait");
  expect(await usage(q.id)).toHaveLength(8);
  expect(vi.mocked(send).mock.calls.slice(before)).toHaveLength(0);
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '16 minutes'; update public.jobs set next_attempt_at=now() where status='retry_wait'",
  );
  await tick();
  expect(await usage(q.id)).toHaveLength(16);
  expect(
    (await usage(q.id)).every(
      (u) => u.actual_input === null && u.actual_output === null,
    ),
  ).toBe(true);
});
it("keeps a known pending Gemini request first after a lease change instead of starting the next provider", async () => {
  await enable();
  const q = await queue();
  let create = 0,
    poll = 0;
  const calls: string[] = [];
  const tick = worker(
    transport((p, u, init) => {
      calls.push(p);
      if (p !== "gemini_free") throw Error("unexpected fallback");
      if (init?.method === "GET") {
        poll++;
        return success(p);
      }
      create++;
      return Response.json({ id: "synthetic-request", status: "in_progress" });
    }),
  );
  await tick();
  expect((await job(q.id)).error_code).toBe("MODEL_IN_PROGRESS");
  expect(
    (await f.db.query<any>("select next_position from public.model_routing"))
      .rows[0].next_position,
  ).toBe(1);
  await f.db.exec("update public.model_routing set next_position=3");
  await age();
  await tick();
  expect((await job(q.id)).status).toBe("succeeded");
  expect(create).toBe(1);
  expect(poll).toBe(1);
  expect(
    (await f.db.query<any>("select next_position from public.model_routing"))
      .rows[0].next_position,
  ).toBe(3);
  expect(await usage(q.id)).toHaveLength(1);
  expect((await job(q.id)).checkpoint.model_routing.round_attempts).toBe(1);
});
it("falls back after a failed retrieval of a saved Gemini request without creating Gemini again", async () => {
  await enable();
  const q = await queue();
  let phase = 0;
  const calls: string[] = [];
  const tick = worker(
    transport((p, u, init) => {
      calls.push(p);
      if (p !== "gemini_free") return success(p);
      if (init?.method === "GET") return new Response(null, { status: 503 });
      phase++;
      return Response.json({ id: "synthetic-request", status: "in_progress" });
    }),
  );
  await tick();
  await age();
  await tick();
  expect((await job(q.id)).status).toBe("succeeded");
  expect(phase).toBe(1);
  expect(calls).toEqual(["gemini_free", "gemini_free", "qwen_free"]);
  expect(
    (await usage(q.id)).find((x) => x.provider === "gemini_free").state,
  ).toBe("unknown");
});
it("tries every automatic provider despite old daily ceilings and retains unknown usage", async () => {
  await enable();
  await f.db.exec(
    "update public.workspaces set settings=settings||'{\"daily_call_limit\":2}'::jsonb",
  );
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      throw new TypeError("synthetic loss");
    }),
  )();
  expect(calls).toHaveLength(8);
  expect((await job(q.id)).error_code).toBe("MODEL_ROUND_EXHAUSTED");
  expect((await job(q.id)).status).toBe("retry_wait");
  expect(await usage(q.id)).toHaveLength(8);
  expect(
    (await usage(q.id)).every(
      (u) => u.actual_input === null && u.actual_output === null,
    ),
  ).toBe(true);
});

it("can fail over within a one-request token budget after a proven initial 429 rejection", async () => {
  await enable();
  await f.db.exec(
    "update public.workspaces set settings=settings||'{\"output_token_limit\":1024}'::jsonb",
  );
  const q = await queue(),
    calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return p === "gemini_free"
        ? new Response(null, { status: 429 })
        : success(p);
    }),
  )();
  expect(calls).toEqual(["gemini_free", "qwen_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const records = await usage(q.id);
  expect(records.find((x) => x.provider === "gemini_free")).toMatchObject({
    state: "settled",
    actual_output: null,
    reserved_output: 1024,
  });
  expect(records.find((x) => x.provider === "qwen_free")).toMatchObject({
    state: "settled",
    actual_output: 10,
  });
});
it("requires exact per-provider content permission and service-only metadata preparation", async () => {
  await enable();
  const q = await queue();
  const claimed = await rpc("claim_backend_job");
  await rpc("prepare_model_routing", {
    job_id: q.id,
    lease: claimed.lease_token,
    server_models: meta(),
  });
  const one = await job(q.id);
  await rpc("prepare_model_routing", {
    job_id: q.id,
    lease: claimed.lease_token,
    server_models: meta(),
  });
  expect((await job(q.id)).checkpoint).toEqual(one.checkpoint);
  await expect(
    rpc("model_preflight", {
      job_id: q.id,
      lease: claimed.lease_token,
      manifest: [{ entity_kind: "notice" }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const grants = await f.db.query<any>(
    "select has_function_privilege('authenticated','public.prepare_model_routing(uuid,uuid,jsonb)','execute') prepare,has_function_privilege('authenticated','public.record_model_attempt(uuid,uuid,text,text,boolean)','execute') record",
  );
  expect(grants.rows[0]).toEqual({ prepare: false, record: false });
  const item = await f.command("knowledge.save", {
    title: "Synthetic routing evidence",
    content: "Builds software.",
    category: "company",
    enabled: true,
    evidence: "Fixture only",
  });
  const ref = (await f.rpc("eligibility_candidates")).items.find(
    (x: any) => x.entity_id === item.id,
  );
  await f.db.query(
    "update public.jobs set type='classify_opportunity' where id=$1",
    [q.id],
  );
  await expect(
    rpc("model_preflight", {
      job_id: q.id,
      lease: claimed.lease_token,
      manifest: [ref],
    }),
  ).rejects.toMatchObject({ code: "DATA_AUTHORIZATION_REQUIRED" });
  await f.command("content.authorize", {
    entity_kind: ref.entity_kind,
    entity_id: ref.entity_id,
    content_hash: ref.content_hash,
    provider: "qwen_free",
    attestation: "nonconfidential_nonpersonal",
  });
  expect(
    (
      await rpc("model_preflight", {
        job_id: q.id,
        lease: claimed.lease_token,
        manifest: [ref],
      })
    ).providers.map((x: any) => x.provider),
  ).toEqual(["qwen_free"]);
});
it("runs configured models without a billing attestation and retains routing revision checks", async () => {
  const saved = await enable();
  const q = await queue();
  const withoutAttestation = modelEnvironments((n) =>
    n.endsWith("_FREE_ONLY")
      ? undefined
      : n.endsWith("_KEY")
        ? "synthetic-key"
        : n.endsWith("_NAME")
          ? "synthetic-model"
          : n.endsWith("_PROJECT")
            ? "synthetic-project"
            : undefined,
  );
  const send = transport((p) => success(p));
  await worker(send, { ...environment, models: withoutAttestation })();
  expect(send).toHaveBeenCalled();
  expect((await job(q.id)).status).toBe("succeeded");
  expect((await job(q.id)).checkpoint.model_routing.checks).toContainEqual(
    expect.objectContaining({ provider: "gemini_free", code: "SUCCEEDED" }),
  );
  await expect(
    f.command("model.routing", { enabled: false, expected_revision: 0 }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await f.command("model.routing", {
    enabled: false,
    expected_revision: saved.revision,
  });
  expect(
    (await f.db.query<any>("select enabled from public.model_routing")).rows[0]
      .enabled,
  ).toBe(false);
});

it("denies routing configuration and visibility to a non-Owner, and disables routing on restore", async () => {
  await enable();
  await f.db.query(
    "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
    [f.w, f.owner],
  );
  await f.db.exec("update public.restore_sessions set state='committed'");
  expect(
    (await f.db.query<any>("select enabled from public.model_routing")).rows[0]
      .enabled,
  ).toBe(false);
  await f.db.query(
    "update public.memberships set role='Editor' where user_id=$1",
    [f.owner],
  );
  await expect(
    f.command("model.routing", { enabled: true, expected_revision: 2 }),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  await f.db.exec("set local role authenticated");
  expect(
    (await f.db.query("select * from public.model_routing")).rows,
  ).toHaveLength(0);
  await f.db.exec("reset role");
});

it("uses the global next provider when a retry interleaves with another completed job", async () => {
  await enable();
  const first = await queue();
  await worker(transport(() => new Response(null, { status: 429 })))();
  expect((await job(first.id)).error_code).toBe("MODEL_ROUND_EXHAUSTED");
  await f.db.query("update public.jobs set status='blocked' where id=$1", [
    first.id,
  ]);
  const second = await queue();
  await age();
  const calls: string[] = [];
  const tick = worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
  );
  await tick();
  expect((await job(second.id)).status).toBe("succeeded");
  expect(calls).toEqual(["qwen_free"]);
  await f.db.query("update public.jobs set status='quota_wait' where id=$1", [
    first.id,
  ]);
  await age();
  await tick();
  expect((await job(first.id)).status).toBe("succeeded");
  expect(calls).toEqual(["qwen_free", "mistral_free"]);
});

it("fails over through four unavailable providers to z.ai using an arbitrary configured model", async () => {
  await enable();
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((provider, url, init) => {
      calls.push(provider);
      if (provider !== "zai_free") return new Response(null, { status: 429 });
      expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "synthetic-model",
      });
      return success(provider);
    }),
  )();
  expect(calls).toEqual(ROUND_ROBIN_PROVIDERS.slice(0, 5));
  expect((await job(q.id)).status).toBe("succeeded");
  expect(
    (await usage(q.id)).find((x) => x.provider === "zai_free"),
  ).toMatchObject({ state: "settled", actual_input: 100, actual_output: 10 });
});
it("accepts four-slot workers during deployment even when the new cursor points at z.ai", async () => {
  await enable();
  await f.db.exec("update public.model_routing set next_position=4");
  const q = await queue();
  const claimed = await rpc("claim_backend_job");
  await rpc("prepare_model_routing", {
    job_id: q.id,
    lease: claimed.lease_token,
    server_models: meta().filter((x) =>
      ["gemini_free", "qwen_free", "mistral_free", "groq_free"].includes(
        x.provider,
      ),
    ),
  });
  expect(
    (await job(q.id)).checkpoint.model_routing.providers.map(
      (x: any) => x.provider,
    ),
  ).toEqual(ROUND_ROBIN_PROVIDERS.slice(0, 4));
});
it.each(["groq_free", "zai_free"] as const)(
  "uses saved free-only attestation for %s and reads a changed model from secrets",
  async (provider) => {
    await enable();
    await f.command("model.configure", {
      expected_revision: 0,
      enabled: true,
      provider,
      model: "previous-model",
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
    });
    await f.db.query("update public.model_routing set next_position=$1", [
      ROUND_ROBIN_PROVIDERS.indexOf(provider),
    ]);
    const q = await queue();
    const calls: string[] = [];
    const changed = {
      ...models,
      [provider]: {
        ...models[provider],
        model: "owner-selected-new-model",
      },
    };
    await worker(
      transport((p, _url, init) => {
        calls.push(p);
        expect(JSON.parse(String(init?.body)).model).toBe(
          "owner-selected-new-model",
        );
        return success(p);
      }),
      { ...environment, models: changed },
    )();
    expect(calls).toEqual([provider]);
    expect((await job(q.id)).status).toBe("succeeded");
    expect((await usage(q.id))[0].model).toBe("owner-selected-new-model");
  },
);
it("keeps z.ai exact-content consent separate from Gemini consent", async () => {
  await enable();
  const item = await f.command("knowledge.save", {
    title: "Synthetic z.ai permission evidence",
    content: "Builds workflow software.",
    category: "company",
    enabled: true,
    evidence: "Fixture only",
  });
  const ref = (await f.rpc("eligibility_candidates")).items.find(
    (x: any) => x.entity_id === item.id,
  );
  const q = await queue();
  const claimed = await rpc("claim_backend_job");
  await f.db.query(
    "update public.jobs set type='classify_opportunity' where id=$1",
    [q.id],
  );
  await rpc("prepare_model_routing", {
    job_id: q.id,
    lease: claimed.lease_token,
    server_models: meta(),
  });
  await expect(
    rpc("model_preflight", {
      job_id: q.id,
      lease: claimed.lease_token,
      manifest: [ref],
    }),
  ).rejects.toMatchObject({ code: "DATA_AUTHORIZATION_REQUIRED" });
  await f.command("content.authorize", {
    entity_kind: ref.entity_kind,
    entity_id: ref.entity_id,
    content_hash: ref.content_hash,
    provider: "zai_free",
    attestation: "nonconfidential_nonpersonal",
  });
  expect(
    (
      await rpc("model_preflight", {
        job_id: q.id,
        lease: claimed.lease_token,
        manifest: [ref],
      })
    ).providers.map((x: any) => x.provider),
  ).toEqual(["zai_free"]);
});

it("ignores legacy free-account metadata and runs z.ai without a FREE_ONLY secret or profile", async () => {
  const route = await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    free_providers: ["zai_free"],
  });
  await f.command("model.routing", {
    enabled: true,
    expected_revision: route.revision,
  });
  const slots = modelEnvironments((name) =>
    name.startsWith("APP_MODEL_ZAI_")
      ? name.endsWith("_KEY")
        ? "synthetic-key"
        : name.endsWith("_NAME")
          ? "owner-selected-model"
          : name.endsWith("_PROJECT")
            ? "synthetic-account"
            : undefined
      : undefined,
  );
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
    { ...environment, models: slots },
  )();
  expect(calls).toEqual(["zai_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  expect(
    (await f.db.query("select * from public.model_settings")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query<any>("select free_providers from public.model_routing"))
      .rows[0].free_providers,
  ).toEqual(["zai_free"]);
  await f.db.query(
    "insert into public.restore_sessions(workspace_id,manifest,created_by) values($1,'{}',$2)",
    [f.w, f.owner],
  );
  await f.db.exec("update public.restore_sessions set state='committed'");
  expect(
    (
      await f.db.query<any>(
        "select free_providers,enabled from public.model_routing",
      )
    ).rows[0],
  ).toEqual({ free_providers: [], enabled: false });
});

it("uses the saved priority on every new job and skips failures in that order", async () => {
  const order = [
    "groq_free",
    "zai_free",
    "gemini_free",
    "mistral_free",
    "qwen_free",
  ];
  const route = await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
    provider_order: order,
  });
  const readback = (
    await f.db.query<any>(
      "select provider_order,strategy from public.model_routing",
    )
  ).rows[0];
  expect(readback).toEqual({
    provider_order: [...order, "openai", "anthropic", "cloudflare_free"],
    strategy: "priority",
  });
  for (let round = 0; round < 2; round++) {
    await age();
    const q = await queue();
    const calls: string[] = [];
    await worker(
      transport((p) => {
        calls.push(p);
        return p === "groq_free"
          ? new Response(null, { status: 401 })
          : success(p);
      }),
    )();
    expect(calls).toEqual(["groq_free", "zai_free"]);
    expect((await job(q.id)).status).toBe("succeeded");
  }
  await expect(
    f.command("model.routing", {
      enabled: true,
      expected_revision: route.revision,
      provider_order: [...order.slice(0, 4), "groq_free"],
    }),
  ).rejects.toThrow("INVALID_INPUT");
  await expect(
    f.command("model.routing", {
      enabled: true,
      expected_revision: 0,
      strategy: "round_robin",
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await f.command("model.routing", {
    enabled: true,
    expected_revision: route.revision,
  });
  expect(
    (
      await f.db.query<any>(
        "select provider_order,strategy from public.model_routing",
      )
    ).rows[0],
  ).toEqual(readback);
});

it("rotates within the saved provider order when round robin is selected", async () => {
  const order = [
    "zai_free",
    "groq_free",
    "mistral_free",
    "qwen_free",
    "gemini_free",
  ];
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
    provider_order: order,
  });
  const calls: string[] = [];
  for (let i = 0; i < 3; i++) {
    await age();
    await queue();
    await worker(
      transport((p) => {
        calls.push(p);
        return success(p);
      }),
    )();
  }
  expect(calls).toEqual(order.slice(0, 3));
});

it("keeps an assessment pending after all providers error and schedules automatic reassessment", async () => {
  await enable();
  const source = await f.command("source.create", {
    name: "Synthetic manual source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic software procurement",
    reference: "TEST-FAILOVER",
    description: "Implement a software approval workflow.",
    language: "en",
    decision: "undecided",
  });
  const ref = (await f.rpc("eligibility_candidates")).items.find(
    (x: any) => x.entity_id === opportunity.id && x.entity_kind === "notice",
  );
  for (const provider of ROUND_ROBIN_PROVIDERS)
    await f.command("content.authorize", {
      entity_kind: ref.entity_kind,
      entity_id: ref.entity_id,
      content_hash: ref.content_hash,
      provider,
      attestation: "nonconfidential_nonpersonal",
    });
  await f.command("opportunity.assess", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return new Response(null, {
        status:
          p === "gemini_free"
            ? 400
            : p === "qwen_free"
              ? 401
              : p === "mistral_free"
                ? 404
                : 429,
      });
    }),
  )();
  expect(calls).toEqual(ROUND_ROBIN_PROVIDERS);
  const plan = (
    await f.db.query<any>(
      "select * from public.generation_plans where opportunity_id=$1",
      [opportunity.id],
    )
  ).rows[0];
  expect(plan).toMatchObject({
    status: "running",
    error_code: "MODEL_ROUND_EXHAUSTED",
  });
  const discovery = (
    await f.db.query<any>(
      "select * from public.opportunity_discovery where id=$1",
      [opportunity.id],
    )
  ).rows[0];
  expect(discovery).toMatchObject({
    assessment_state: "retry_wait",
    assessment_attempts: 1,
    assessment_error: "MODEL_ROUND_EXHAUSTED",
    inbox_visible: false,
  });
  expect(
    (await f.db.query("select * from public.fit_assessments")).rows,
  ).toHaveLength(0);
  expect(Number.isFinite(Date.parse(discovery.next_attempt_at))).toBe(true);
});

it("automatically resumes a failed round when a provider becomes available", async () => {
  await enable();
  const q = await queue();
  await worker(transport(() => new Response(null, { status: 429 })))();
  expect((await job(q.id)).status).toBe("retry_wait");
  await age();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
  )();
  expect((await job(q.id)).status).toBe("succeeded");
  expect(calls).toEqual(["qwen_free"]);
  expect((await job(q.id)).checkpoint.model_routing.round_attempts).toBe(2);
});

it("targets z.ai only, persists measured validation outcome and safe request metadata", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "zai_free" });
  const sent: string[] = [];
  await worker(
    transport((provider) => {
      sent.push(provider);
      return Response.json(
        {
          id: "synthetic-response",
          model: "synthetic-reported",
          choices: [
            {
              finish_reason: "stop",
              message: { content: '{"status":"ready"}' },
            },
          ],
          usage: {
            prompt_tokens: 123,
            completion_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        },
        { headers: { "x-request-id": "synthetic-request" } },
      );
    }),
  )();
  expect(sent).toEqual(["zai_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    provider: "zai_free",
    model: "synthetic-model",
    status: "succeeded",
    result_code: "SUCCEEDED",
    actual_input: 123,
    actual_output: 8,
    thinking_tokens: 2,
    http_status: 200,
    request_id: "synthetic-request",
    response_id: "synthetic-response",
    finish_reason: "stop",
    round_number: 1,
    operation: "connection_probe",
  });
  expect(Number(rows[0].duration_ms)).toBeGreaterThanOrEqual(0);
  // Browser members can read this workspace, cannot write telemetry or see another workspace.
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  await f.db.exec("set local role authenticated");
  expect(
    (await f.db.query("select * from public.model_activity")).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query<any>(
        "select has_table_privilege('authenticated','public.model_attempts','insert') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
  await f.db.exec("reset role");
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    crypto.randomUUID(),
  ]);
  await f.db.exec("set local role authenticated");
  expect(
    (await f.db.query("select * from public.model_activity")).rows,
  ).toHaveLength(0);
  await f.db.exec("reset role");
});
it("keeps failure history across retry rounds and distinguishes invalid JSON from measured usage", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "zai_free" });
  await worker(
    transport(() =>
      Response.json({
        choices: [
          { finish_reason: "stop", message: { content: '{"status":"wrong"}' } },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      }),
    ),
  )();
  let rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "failed",
    result_code: "MODEL_OUTPUT_INVALID",
    actual_input: 50,
    actual_output: 5,
    usage_state: "settled",
  });
  await age();
  await worker(transport((p) => success(p)))();
  rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows.map((r) => r.status)).toEqual(["failed", "succeeded"]);
  expect(rows.map((r) => r.round_number)).toEqual([1, 2]);
});
it("records missing targeted credentials without calling a different provider", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "zai_free" });
  const send = vi.fn<typeof fetch>();
  await worker(send, {
    ...environment,
    models: { ...models, zai_free: { ...models.zai_free, key: "" } },
  })();
  expect(send).not.toHaveBeenCalled();
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    provider: "zai_free",
    status: "skipped",
    sent: false,
    result_code: "MODEL_NOT_CONFIGURED",
    actual_input: null,
  });
});

it("never substitutes a manual Gemini profile if routing is disabled after a z.ai check is queued", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "zai_free" });
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "gemini_free",
    model: "gemini-3.8-flash",
    project_ref: "synthetic-project",
    free_only: false,
    billing_verified: false,
    free_quota_only: false,
    quota_mode: "provider_managed",
    quota_ends_at: null,
    quota_remaining_tokens: null,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
  });
  await f.command("model.routing", { enabled: false, expected_revision: 1 });
  const send = vi.fn<typeof fetch>();
  await worker(send)();
  expect(send).not.toHaveBeenCalled();
  expect((await job(q.id)).status).not.toBe("succeeded");
  expect(await usage(q.id)).toHaveLength(0);
});

it("persists z.ai's overload reason, fails over in configured order, and retains the failed attempt", async () => {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
    provider_order: [
      "zai_free",
      "groq_free",
      "gemini_free",
      "qwen_free",
      "mistral_free",
    ],
  });
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return p === "zai_free"
        ? Response.json(
            {
              error: {
                code: "1305",
                message: "The service may be temporarily overloaded",
              },
            },
            { status: 429, headers: { "x-request-id": "synthetic-overload" } },
          )
        : success(p);
    }),
  )();
  expect(calls).toEqual(["zai_free", "groq_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    provider: "zai_free",
    status: "failed",
    http_status: 429,
    provider_error_code: "1305",
    provider_error_reason: "overloaded",
    request_id: "synthetic-overload",
    actual_input: null,
    actual_output: null,
    round_number: 1,
  });
  expect(rows[1]).toMatchObject({
    provider: "groq_free",
    status: "succeeded",
    actual_input: 100,
    actual_output: 10,
    provider_error_code: null,
  });
});
it("keeps a targeted overload check waiting, counts its retry, and succeeds when z.ai recovers", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "zai_free" });
  await worker(
    transport(() =>
      Response.json(
        { error: { code: "1305", message: "overloaded" } },
        { status: 429, headers: { "retry-after": "90" } },
      ),
    ),
  )();
  expect((await job(q.id)).status).toBe("retry_wait");
  expect((await job(q.id)).checkpoint.model_routing.round_attempts).toBe(1);
  await age();
  const coolingNetwork = vi.fn<typeof fetch>();
  await worker(coolingNetwork)();
  expect(coolingNetwork).not.toHaveBeenCalled();
  expect((await job(q.id)).status).toBe("retry_wait");
  await f.db.query(
    "update public.model_attempts set retry_after=now()-interval '1 second' where job_id=$1",
    [q.id],
  );
  await age();
  await worker(transport((p) => success(p)))();
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows.map((r) => r.round_number)).toEqual([1, 2, 3]);
  expect(rows[0].provider_error_code).toBe("1305");
  expect(rows[0].retry_after).not.toBeNull();
  expect(rows[1]).toMatchObject({
    status: "skipped",
    sent: false,
    result_code: "PROVIDER_QUOTA_WAIT",
  });
  expect(rows[2].status).toBe("succeeded");
});

it.each(["openai", "anthropic", "cloudflare_free"] as const)(
  "runs a targeted %s probe with durable native usage and model identity",
  async (provider) => {
    await enable();
    const q = await f.command("model.probe", { provider });
    const calls: string[] = [];
    await worker(
      transport((p) => {
        calls.push(p);
        return success(p);
      }),
    )();
    expect(calls).toEqual([provider]);
    expect((await job(q.id)).status).toBe("succeeded");
    const row = (
      await f.db.query<any>(
        "select * from public.model_activity where job_id=$1",
        [q.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      provider,
      model: "synthetic-model",
      actual_input: 100,
      actual_output: 10,
      status: "succeeded",
      round_number: 1,
      http_status: 200,
    });
  },
);
it("uses the supplied Cloudflare account and model, fails over, and retains measured usage", async () => {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
    provider_order: [
      "cloudflare_free",
      ...ROUND_ROBIN_PROVIDERS.filter((p) => p !== "cloudflare_free"),
    ],
  });
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p, url, init) => {
      calls.push(p);
      if (p === "cloudflare_free") {
        expect(url).toBe(
          "https://api.cloudflare.com/client/v4/accounts/syntheticaccount/ai/v1/chat/completions",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer synthetic-key",
        );
        expect(JSON.parse(String(init?.body)).model).toBe(
          "@cf/owner/chosen-model",
        );
        return Response.json(
          { error: { code: "rate_limit_exceeded" } },
          { status: 429 },
        );
      }
      return success(p);
    }),
    {
      ...environment,
      models: {
        ...models,
        cloudflare_free: {
          ...models.cloudflare_free,
          model: "@cf/owner/chosen-model",
        },
      },
    },
  )();
  expect(calls).toEqual(["cloudflare_free", "gemini_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows[0]).toMatchObject({
    provider: "cloudflare_free",
    model: "@cf/owner/chosen-model",
    status: "failed",
    http_status: 429,
  });
  expect(rows[1]).toMatchObject({
    provider: "gemini_free",
    status: "succeeded",
    actual_input: 100,
    actual_output: 10,
  });
});
it("skips Cloudflare with a missing account ID without sending a request", async () => {
  await enable();
  const q = await f.command("model.probe", { provider: "cloudflare_free" });
  const send = vi.fn<typeof fetch>();
  await worker(send, {
    ...environment,
    models: {
      ...models,
      cloudflare_free: { ...models.cloudflare_free, projectRef: "" },
    },
  })();
  expect(send).not.toHaveBeenCalled();
  expect((await job(q.id)).status).toBe("retry_wait");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 and provider='cloudflare_free'",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "skipped",
    result_code: "MODEL_NOT_CONFIGURED",
    sent: false,
  });
});
it("accepts a seven-slot worker with a cursor at Cloudflare without removing the saved slot", async () => {
  await enable();
  await f.db.exec("update public.model_routing set next_position=7");
  const q = await queue();
  const claimed = await rpc("claim_backend_job");
  await rpc("prepare_model_routing", {
    job_id: q.id,
    lease: claimed.lease_token,
    server_models: meta().filter((p) => p.provider !== "cloudflare_free"),
  });
  expect((await job(q.id)).checkpoint.model_routing.provider_count).toBe(7);
  expect(
    (await f.db.query<any>("select provider_order from public.model_routing"))
      .rows[0].provider_order,
  ).toEqual(ROUND_ROBIN_PROVIDERS);
});
it("fails over from OpenAI rate rejection to Claude while retaining the rejection and native usage", async () => {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
    provider_order: [
      "openai",
      "anthropic",
      "gemini_free",
      "qwen_free",
      "mistral_free",
      "groq_free",
      "zai_free",
    ],
  });
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return p === "openai"
        ? Response.json(
            {
              error: {
                type: "rate_limit_error",
                code: "rate_limit_exceeded",
                message: "Rate limit reached",
              },
            },
            { status: 429, headers: { "retry-after": "60" } },
          )
        : success(p);
    }),
  )();
  expect(calls).toEqual(["openai", "anthropic"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 order by sequence",
      [q.id],
    )
  ).rows;
  expect(rows[0]).toMatchObject({
    provider: "openai",
    provider_error_code: "rate_limit_exceeded",
    provider_error_reason: "rate_limit",
    status: "failed",
  });
  expect(rows[1]).toMatchObject({
    provider: "anthropic",
    status: "succeeded",
    actual_input: 100,
    actual_output: 10,
  });
});
it("skips unconfigured OpenAI and Claude without external requests", async () => {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
    provider_order: [
      "openai",
      "anthropic",
      "gemini_free",
      "qwen_free",
      "mistral_free",
      "groq_free",
      "zai_free",
    ],
  });
  const q = await queue();
  const calls: string[] = [];
  await worker(
    transport((p) => {
      calls.push(p);
      return success(p);
    }),
    {
      ...environment,
      models: {
        ...models,
        openai: { ...models.openai, key: "" },
        anthropic: { ...models.anthropic, model: "" },
      },
    },
  )();
  expect(calls).toEqual(["gemini_free"]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = (
    await f.db.query<any>(
      "select * from public.model_activity where job_id=$1 and provider in ('openai','anthropic')",
      [q.id],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (r) =>
        r.status === "skipped" &&
        r.result_code === "MODEL_NOT_CONFIGURED" &&
        !r.sent,
    ),
  ).toBe(true);
});

it("accepts validated automatic output with unknown usage and never calls a count-token endpoint", async () => {
  await enable();
  const q = await queue();
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain(":countTokens");
      return Response.json({
        id: "synthetic-no-usage",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: '{"status":"ready"}' }],
          },
        ],
      });
    },
  );
  expect((await worker(fetcher as typeof fetch)()).status).toBe(200);
  expect((await job(q.id)).status).toBe("succeeded");
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toHaveLength(1);
  expect((await usage(q.id))[0]).toMatchObject({
    state: "unknown",
    actual_input: null,
    actual_output: null,
  });
});
