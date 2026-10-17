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
  if (name.startsWith("APP_MODEL_") && !name.includes("CLOUDFLARE")) {
    if (name.endsWith("_KEY")) return "synthetic-key";
    if (name.endsWith("_NAME"))
      return name.includes("GEMINI") ? "gemini-3.8-flash" : "synthetic-model";
    if (name.endsWith("_PROJECT")) return "synthetic-project";
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
    free_tier_confirmed: slots[provider].freeTierConfirmed === true,
  }));
async function enable() {
  return f.command("model.routing", { enabled: true, expected_revision: 0 });
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
  return url.includes("googleapis")
    ? "gemini_free"
    : url.includes("aliyuncs")
      ? "qwen_free"
      : url.includes("mistral.ai")
        ? "mistral_free"
        : "groq_free";
}
function success(provider: string, id = "synthetic-request") {
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
  await f.db.exec(
    "update public.provider_usage set created_at=now()-interval '2 minutes'; update public.jobs set next_attempt_at=now()-interval '1 second' where status in ('quota_wait','retry_wait')",
  );
}

it("visits all four missing slots without sending unauthenticated requests and schedules a finite retry", async () => {
  await enable();
  const q = await queue();
  const send = vi.fn<typeof fetch>();
  await worker(send, {
    ...environment,
    models: modelEnvironments(() => undefined),
  })();
  const j = await job(q.id);
  expect(j.status).toBe("quota_wait");
  expect(j.error_code).toBe("MODEL_ROUND_EXHAUSTED");
  expect(Number.isFinite(Date.parse(j.next_attempt_at))).toBe(true);
  expect(j.checkpoint.model_routing.checks).toHaveLength(4);
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
  expect(calls).toEqual([...ROUND_ROBIN_PROVIDERS]);
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
      qwen_free: { ...models.qwen_free, freeTierConfirmed: undefined },
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
  for (let i = 0; i < 4; i++) {
    const q = await queue();
    await tick();
    expect((await job(q.id)).status).toBe("succeeded");
    await age();
  }
  expect(calls).toEqual([...ROUND_ROBIN_PROVIDERS]);
});
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
  expect(calls).toEqual([...ROUND_ROBIN_PROVIDERS]);
  expect((await job(q.id)).status).toBe("succeeded");
  const rows = await usage(q.id);
  expect(rows.filter((x) => x.state === "unknown")).toHaveLength(3);
  expect(
    rows
      .filter((x) => x.state === "unknown")
      .every((x) => x.actual_input === null && x.reserved_input > 0),
  ).toBe(true);
});
it("retries an exhausted round with a rotated start, but never resends ambiguous calls to the same provider", async () => {
  await enable();
  const q = await queue();
  const send = transport(() => {
    throw new TypeError("synthetic loss");
  });
  const tick = worker(send);
  await tick();
  expect((await job(q.id)).status).toBe("quota_wait");
  expect(await usage(q.id)).toHaveLength(4);
  await age();
  const before = vi.mocked(send).mock.calls.length;
  await tick();
  expect((await job(q.id)).status).toBe("quota_wait");
  expect(await usage(q.id)).toHaveLength(4);
  // Gemini token counting is allowed; generation must not be repeated.
  expect(
    vi
      .mocked(send)
      .mock.calls.slice(before)
      .every(([u]) => String(u).endsWith(":countTokens")),
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
  await age();
  await tick();
  expect((await job(q.id)).status).toBe("succeeded");
  expect(create).toBe(1);
  expect(poll).toBe(1);
  expect(await usage(q.id)).toHaveLength(1);
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
it("keeps workspace daily limits across providers, including uncertain attempts", async () => {
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
  expect(calls).toHaveLength(2);
  expect((await job(q.id)).error_code).toBe("MODEL_DAILY_QUOTA_WAIT");
  expect(await usage(q.id)).toHaveLength(2);
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
it("does not infer free billing from API-key presence and can disable automatic routing with revision checks", async () => {
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
  const send = vi.fn<typeof fetch>();
  await worker(send, { ...environment, models: withoutAttestation })();
  expect(send).not.toHaveBeenCalled();
  expect(
    (await job(q.id)).checkpoint.model_routing.checks.every(
      (x: any) => x.code === "FREE_ONLY_REQUIRED",
    ),
  ).toBe(true);
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
