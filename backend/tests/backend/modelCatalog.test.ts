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
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import {
  executeModel,
  ModelDeferred,
} from "../../supabase/functions/_shared/model";
import { modelLedger } from "../../supabase/functions/_shared/modelLedger";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await f.db.exec("rollback");
});
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint catalog_rpc;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) value`,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).rows[0]?.value;
  } catch (error) {
    await f.db.exec("rollback to savepoint catalog_rpc");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role;release savepoint catalog_rpc");
  }
}
async function configure(
  provider: "groq_free" | "openai" | "gemini_free" = "groq_free",
) {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
  });
  const connection = await f.command("model.connection.save", {
    provider,
    label: "Fixture account",
    credential_alias:
      provider === "openai"
        ? "APP_MODEL_OPENAI_KEY"
        : provider === "gemini_free"
          ? "APP_MODEL_GEMINI_KEY"
          : "APP_MODEL_GROQ_KEY",
    project_ref: "fixture-account",
    enabled: true,
    expected_revision: 0,
  });
  const models = [];
  for (const model of ["fixture-model-a", "fixture-model-b"])
    models.push(
      await f.command("model.configuration.save", {
        connection_id: connection.id,
        label: model,
        model,
        enabled: true,
        capabilities: defaultCapabilities(provider),
        expected_revision: 0,
      }),
    );
  const route = await f.command("model.task_route.save", {
    task: "default",
    model_ids: models.map((m) => m.id),
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
  });
  const queued = await f.command("model.probe", {});
  const job = await rpc("claim_backend_job_v2");
  expect(job.id).toBe(queued.id);
  const envs = modelEnvironments((name) =>
    name.endsWith("_KEY")
      ? "fixture-key"
      : name.endsWith("_PROJECT")
        ? "fixture-account"
        : undefined,
  );
  const backend = { internal: rpc } as unknown as Backend;
  return {
    job,
    models,
    connection,
    route,
    envs,
    ledger: modelLedger(backend, job, `probe:${job.id}`, envs),
    backend,
  };
}

it.each([
  { crash: false, atomic: false },
  { crash: true, atomic: false },
  { crash: false, atomic: true },
])(
  "recovers a blocked unchanged complete report without another call or budget reset (accept crash: $crash, atomic claims: $atomic)",
  async ({ crash, atomic }) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { ModelGraphStore } =
      await import("../../supabase/functions/_shared/modelGraphStore");
    const { candidateContent } =
      await import("../../supabase/functions/_shared/modelGrounding");
    const { sha256 } = await import("../../supabase/functions/_shared/model");
    const { job, backend, envs } = await configure();
    const atomicQuotes = [
      "We deliver software.",
      "Buyer approval remains required.",
    ];
    const compoundClaim = atomicQuotes.join(" ");
    const companyEvidence = {
      id: "company",
      text: compoundClaim,
      kind: "company" as const,
      verified: true,
    };
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: [
        {
          type: "paragraph",
          text: atomic
            ? compoundClaim
            : "Proposed work requires buyer confirmation.",
        },
      ],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: atomic
        ? [{ claim: compoundClaim, quote: compoundClaim, source_id: "company" }]
        : [],
      assumptions: [],
      questions: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(candidate) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      }),
    );
    const options = {
      backend,
      job,
      prefix: `step:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: atomic ? [companyEvidence] : [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
      ModelDeferred,
    );
    const current = await rpc("claim_backend_job_v2");
    const thread = (
      await f.db.query<any>(
        "select id from app_private.model_graph_threads where job_id=$1",
        [job.id],
      )
    ).rows[0];
    const store = new ModelGraphStore(backend, current, thread.id);
    const original = await store.action("result_get", { key: "candidate-0" });
    const hash = await sha256(JSON.stringify(original.value.result));
    const units = candidateContent(original.value.result);
    const retained = await store.action("result_put", {
      key: `invalid-verification-repair-${hash}`,
      value: {
        code: atomic
          ? "MODEL_COVERAGE_INCOMPLETE"
          : "EVIDENCE_REFERENCE_INVALID",
        producer: { model: "fixture-corrective" },
        result: {
          checked_candidate_hash: hash,
          reviewed_all_content: true,
          processed_content_ids: units.map((u) => u.id),
          claims: atomic
            ? atomicQuotes.map((quote, index) => ({
                id: `atomic-${index}`,
                claim: quote,
                candidate_quote: quote,
                kind: index ? "assumption" : "company_fact",
                status: "supported",
                source_refs: [{ id: "company", quote: compoundClaim }],
                finding: "Exact atomic assertion reviewed.",
              }))
            : [
                {
                  id: "claim",
                  claim: units[0].text,
                  candidate_quote: units[0].text,
                  kind: "assumption",
                  status: "supported",
                  source_refs: [],
                  finding: "Proposed work.",
                },
              ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        },
      },
    });
    await store.action("needs_review");
    await f.db.query(
      "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'verifier-exhausted',3),($1,'verifier-corrective',1)",
      [thread.id],
    );
    const usage = async () =>
      (
        await f.db.query<any>(
          "select id,state,actual_input,actual_output,graph_candidate_recorded from public.provider_usage where job_id=$1 order by id",
          [job.id],
        )
      ).rows;
    const budgets = async () =>
      (
        await f.db.query<any>(
          "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
          [thread.id],
        )
      ).rows;
    const usageBefore = await usage();
    const budgetsBefore = await budgets();
    expect(await store.action("recovery_ready")).toBe(true);
    for (const state of ["reserved", "unknown"]) {
      await f.db.query(
        "update public.provider_usage set state=$2 where id=$1",
        [usageBefore[0].id, state],
      );
      expect(await store.action("recovery_ready")).toBe(false);
    }
    await f.db.query("update public.provider_usage set state=$2 where id=$1", [
      usageBefore[0].id,
      usageBefore[0].state,
    ]);
    await f.db.query(
      "update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_round}','{}') where id=$1",
      [job.id],
    );
    expect(await store.action("recovery_ready")).toBe(false);
    await f.db.query(
      "update public.jobs set checkpoint=checkpoint-'model_round' where id=$1",
      [job.id],
    );
    // Reuse the held normal queue lease. No provider transport is allowed from
    // this point, including if acceptance crashes after saving its immutable row.
    fetcher.mockClear();
    fetcher.mockImplementation(async () => {
      throw Error("Recovery must make zero model requests");
    });
    if (crash) {
      let failAccept = true;
      const crashingBackend = {
        ...backend,
        internal: async (name: string, args: any) => {
          if (
            name === "model_graph_store" &&
            args.action === "accept" &&
            failAccept
          ) {
            failAccept = false;
            throw Error("Synthetic crash after accepted result saved");
          }
          return backend.internal(name, args);
        },
      } as Backend;
      await expect(
        executeGuardedModel({
          ...options,
          backend: crashingBackend,
          job: current,
        }),
      ).rejects.toThrow("Synthetic crash");
      expect(
        (await store.action("result_get", { key: "accepted" })).value,
      ).toEqual(original.value.result);
    }
    expect(
      (await executeGuardedModel({ ...options, job: current })).result,
    ).toEqual(original.value.result);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await usage()).toEqual(usageBefore);
    expect(await budgets()).toEqual(budgetsBefore);
    expect(
      (await store.action("result_get", { id: original.id })).value,
    ).toEqual(original.value);
    expect(
      (await store.action("result_get", { id: retained.id })).value,
    ).toEqual(retained.value);
    expect(
      (
        await f.db.query<any>(
          "select status,candidate_count,result_id from app_private.model_graph_threads where id=$1",
          [thread.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "accepted", candidate_count: 1 });
    const marker = await store.action("result_get", {
      key: `validated-recovery-${original.id}-${retained.id}`,
    });
    expect(marker.value).toMatchObject({
      received_candidate_budgets_unchanged: true,
      new_provider_requests: 0,
    });
    expect(await store.action("recovery_ready")).toBe(false);
  },
  30000,
);

it("admits two distinct background jobs, keeps the same-job guard and drains accepted work after a limit reduction", async () => {
  const s = await configure("openai");
  await s.ledger.preflight([], "connection_probe");
  const reserve = (job: any, key: string, hash: string) =>
    rpc("reserve_task_model_call", {
      job_id: job.id,
      lease: job.lease_token,
      call_key: key,
      input_hash: hash.repeat(64),
      input_tokens: 100,
      output_tokens: 100,
      manifest: [],
      target_model: s.models[0].id,
      target_connection: s.connection.id,
    });
  const first = await reserve(s.job, "parallel-first", "a");
  await rpc("checkpoint_model_request", {
    job_id: s.job.id,
    lease: s.job.lease_token,
    reservation: first.id,
    remote_id: "resp_parallel_first",
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 1,
    max_parallel_requests: 2,
  });
  await expect(reserve(s.job, "same-job-duplicate", "b")).rejects.toMatchObject(
    { code: "MODEL_RATE_WAIT" },
  );
  await f.db.query(
    "update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute' where id=$1",
    [s.job.id],
  );
  const queued = (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by)
    select workspace_id,type,entity_id,'parallel-second','queued',created_by from public.jobs where id=$1 returning *`,
      [s.job.id],
    )
  ).rows[0];
  const secondJob = await rpc("claim_backend_job_v2");
  expect(secondJob.id).toBe(queued.id);
  expect(await rpc("claim_backend_job_v2")).toBeNull();
  const ledger = modelLedger(
    s.backend,
    secondJob,
    `probe:${secondJob.id}`,
    s.envs,
  );
  await ledger.preflight([], "connection_probe");
  const second = await reserve(secondJob, "parallel-second", "b");
  await rpc("checkpoint_model_request", {
    job_id: secondJob.id,
    lease: secondJob.lease_token,
    reservation: second.id,
    remote_id: "resp_parallel_second",
  });
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.provider_usage where state='reserved'",
      )
    ).rows[0].n,
  ).toBe(2);
  await f.db.query(
    "update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute' where id=$1",
    [secondJob.id],
  );
  const thirdQueued = (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by)
    select workspace_id,type,entity_id,'parallel-third','queued',created_by from public.jobs where id=$1 returning *`,
      [s.job.id],
    )
  ).rows[0];
  expect(await rpc("claim_backend_job_v2")).toBeNull();
  // Admission now waits before leasing a third inference job. Also exercise
  // reservation protection for a worker leased before a capacity reduction.
  const thirdJob = (
    await f.db.query<any>(
      "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=1 where id=$1 returning *",
      [thirdQueued.id],
    )
  ).rows[0];
  await modelLedger(
    s.backend,
    thirdJob,
    `probe:${thirdJob.id}`,
    s.envs,
  ).preflight([], "connection_probe");
  await expect(
    reserve(thirdJob, "third-at-capacity", "c"),
  ).rejects.toMatchObject({ code: "MODEL_RATE_WAIT" });
  const before = (
    await f.db.query<any>("select * from public.provider_usage order by id")
  ).rows;
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 2,
    max_parallel_requests: 1,
  });
  expect(
    (await f.db.query<any>("select * from public.provider_usage order by id"))
      .rows,
  ).toEqual(before);
  await expect(reserve(thirdJob, "over-capacity", "c")).rejects.toMatchObject({
    code: "MODEL_RATE_WAIT",
  });
  await f.db.query(
    "update public.jobs set status='retry_wait',lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute' where id=$1",
    [thirdJob.id],
  );
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    s.job.id,
  ]);
  const resumed = await rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(s.job.id);
  const pending = await rpc("resume_task_model_request", {
    job_id: resumed.id,
    lease: resumed.lease_token,
    input_hash: "a".repeat(64),
    manifest: [],
    target_model: s.models[0].id,
    target_connection: s.connection.id,
  });
  expect(pending).toMatchObject({
    id: first.id,
    remote_request_id: "resp_parallel_first",
    state: "reserved",
  });
  expect(
    (
      await f.db.query<any>(
        "select state from public.provider_usage where id=$1",
        [second.id],
      )
    ).rows[0].state,
  ).toBe("reserved");
});

it("preserves a saved concurrency limit when older clients only toggle task routing", async () => {
  await configure();
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 1,
    max_parallel_requests: 2,
  });
  const saved = await f.command("model.execution.configure", {
    enabled: false,
    expected_revision: 2,
  });
  expect(saved).toMatchObject({ enabled: false, max_parallel_requests: 2 });
});

it.each([0, 5, 1.5, "2", null])(
  "rejects invalid concurrency %s without changing routing",
  async (value) => {
    await configure();
    await expect(
      f.command("model.execution.configure", {
        enabled: true,
        expected_revision: 1,
        max_parallel_requests: value,
      }),
    ).rejects.toThrow("INVALID_INPUT");
    expect(
      (
        await f.db.query<any>(
          "select enabled,revision,max_parallel_requests from public.model_execution_settings",
        )
      ).rows[0],
    ).toEqual({ enabled: true, revision: 1, max_parallel_requests: 1 });
  },
);

it("treats a reserved workspace request as local capacity without dispatching another model", async () => {
  const s = await configure();
  await s.ledger.preflight([], "connection_probe");
  const first = await rpc("reserve_task_model_call", {
    job_id: s.job.id,
    lease: s.job.lease_token,
    call_key: "first",
    input_hash: "a".repeat(64),
    input_tokens: 100,
    output_tokens: 100,
    manifest: [],
    target_model: s.models[0].id,
    target_connection: s.connection.id,
  });
  expect(first.state).toBe("reserved");
  const fetcher = vi.fn();
  await expect(
    executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      s.envs,
      s.ledger,
      "en",
      false,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: "MODEL_RATE_WAIT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (await f.db.query("select id from public.provider_usage")).rows,
  ).toHaveLength(1);
});
it.each([false, true])(
  "negotiates an unsupported Gemini thinking control once per frozen target and transport (background: %s)",
  async (background) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { geminiReasoningTransport } =
      await import("../../supabase/functions/_shared/modelReasoning");
    const { job, backend, envs, models, connection } =
      await configure("gemini_free");
    await f.command("model.task_route.save", {
      task: "connection_probe",
      model_ids: [models[0].id],
      inherit_default: false,
      strategy: "priority",
      profile: {
        ...taskRegistry.verify_grounding.profile,
        reasoning: "medium",
      },
      expected_revision: 0,
    });
    await f.command("model.configuration.save", {
      id: models[0].id,
      connection_id: connection.id,
      label: models[0].label,
      model: models[0].model,
      enabled: true,
      capabilities: { ...defaultCapabilities("gemini_free"), background },
      expected_revision: models[0].revision,
    });
    const bodies: any[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const generation = background
        ? body.generation_config
        : body.generationConfig;
      const level = background
        ? generation.thinking_level
        : generation.thinkingConfig?.thinkingLevel;
      expect(
        background ? generation.max_output_tokens : generation.maxOutputTokens,
      ).toBe(40000);
      if (bodies.length === 1) {
        expect(level?.toLowerCase()).toBe("medium");
        return Response.json(
          {
            error: {
              message: "Thinking level is not supported for this model.",
            },
          },
          { status: 400 },
        );
      }
      expect(level).toBeUndefined();
      if (background) {
        expect(String(url)).toContain("/interactions");
        return Response.json({
          id: `completed-${bodies.length}`,
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: '{"status":"ready"}' }],
            },
          ],
          usage: {
            total_input_tokens: 10,
            total_output_tokens: 8,
            total_thought_tokens: 0,
          },
        });
      }
      expect(String(url)).toContain("fixture-model-a:generateContent");
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
    };
    const options = {
      backend,
      job,
      prefix: `probe:${job.id}`,
      task: "connection_probe" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
      ModelDeferred,
    );
    expect(bodies).toHaveLength(1);
    const resumed = await rpc("claim_backend_job_v2");
    expect(resumed.id).toBe(job.id);
    expect(resumed.lease_token).not.toBe(job.lease_token);
    const identity = {
      job_id: job.id,
      lease: resumed.lease_token,
      target_provider: "gemini_free",
      target_model: models[0].model,
      target_project: connection.project_ref,
      target_connection: connection.id,
      target_configuration: models[0].id,
      target_transport: geminiReasoningTransport(background),
      target_level: "medium",
    };
    expect(await rpc("model_reasoning_allowed", identity)).toBe(false);
    expect(
      await rpc("model_reasoning_allowed", {
        ...identity,
        target_level: "low",
      }),
    ).toBe(true);
    expect(
      await rpc("model_reasoning_allowed", {
        ...identity,
        target_transport: geminiReasoningTransport(!background),
      }),
    ).toBe(true);
    await expect(
      rpc("model_reasoning_allowed", { ...identity, lease: job.lease_token }),
    ).rejects.toMatchObject({ code: "STALE_LEASE" });
    await expect(
      rpc("model_reasoning_allowed", {
        ...identity,
        target_model: "wrong-target",
      }),
    ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
    const outcome = await executeGuardedModel({ ...options, job: resumed });
    expect(outcome.result).toEqual({ status: "ready" });
    expect(bodies).toHaveLength(2);
    const attempts = (
      await f.db.query<any>(
        "select status,result_code,provider_error_reason,execution_metadata from public.model_attempts where job_id=$1 order by id",
        [job.id],
      )
    ).rows;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      status: "failed",
      result_code: "PROVIDER_REQUEST_INVALID",
      provider_error_reason: "reasoning_unsupported",
      execution_metadata: {
        profile: { reasoning: "medium", max_output_tokens: 40000 },
        reasoning_control: {
          requested: "medium",
          effective: "medium",
          transport: identity.target_transport,
        },
      },
    });
    expect(attempts[1]).toMatchObject({
      status: "succeeded",
      execution_metadata: {
        profile: { reasoning: "none", max_output_tokens: 40000 },
        reasoning_control: {
          requested: "medium",
          effective: "none",
          transport: identity.target_transport,
        },
      },
    });
    expect(
      (
        await f.db.query<any>(
          "select state from public.provider_usage where job_id=$1",
          [job.id],
        )
      ).rows.every((u) => u.state === "settled"),
    ).toBe(true);
    // A later request with this unchanged model configuration uses the observed
    // fallback immediately, rather than repeating its rejected optional field.
    await rpc("complete_model_probe_graph", {
      job_id: job.id,
      lease: resumed.lease_token,
      result: outcome.result,
      thread_id: outcome.threadId,
    });
    const queued = await f.command("model.probe", {});
    const next = await rpc("claim_backend_job_v2");
    expect(next.id).toBe(queued.id);
    expect(
      (
        await executeGuardedModel({
          ...options,
          job: next,
          prefix: `probe:${next.id}`,
        })
      ).result,
    ).toEqual({ status: "ready" });
    expect(bodies).toHaveLength(3);
    const nextIdentity = {
      ...identity,
      job_id: next.id,
      lease: next.lease_token,
    };
    expect(await rpc("model_reasoning_allowed", nextIdentity)).toBe(false);
    // An edited configuration revision invalidates the observation only for
    // newly frozen routes. The held job snapshot remains authoritative.
    await f.db.query(
      "update public.provider_usage set settings_revision=settings_revision+1 where id=(select usage_id from public.model_attempts where job_id=$1 and provider_error_reason='reasoning_unsupported' limit 1)",
      [job.id],
    );
    expect(await rpc("model_reasoning_allowed", nextIdentity)).toBe(true);
    const permissions = (
      await f.db.query<any>(
        "select has_function_privilege('anon','public.model_reasoning_allowed(uuid,uuid,text,text,text,text,text,uuid,uuid)','execute') anon,has_function_privilege('authenticated','public.model_reasoning_allowed(uuid,uuid,text,text,text,text,text,uuid,uuid)','execute') authenticated,has_function_privilege('service_role','public.model_reasoning_allowed(uuid,uuid,text,text,text,text,text,uuid,uuid)','execute') service",
      )
    ).rows[0];
    expect(permissions).toEqual({
      anon: false,
      authenticated: false,
      service: true,
    });
  },
  30000,
);

it("preserves a historical draft request through the semantic-policy rollout with GET-only continuation", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { ModelGraphStore } =
    await import("../../supabase/functions/_shared/modelGraphStore");
  const { modelPrompt, sha256 } =
    await import("../../supabase/functions/_shared/model");
  const { SEMANTIC_INSTRUCTIONS_V1 } =
    await import("../../supabase/functions/_shared/modelSemanticInstructions");
  const configured = await configure("gemini_free");
  const { backend, envs } = configured;
  let job = configured.job;
  const prefix = `step:${job.id}`;
  await modelLedger(backend, job, prefix, envs).preflight([], "draft_section");
  job = (
    await f.db.query<any>("select * from public.jobs where id=$1", [job.id])
  ).rows[0];
  const inputHash = await sha256(
    JSON.stringify({
      version: 1,
      task: "draft_section",
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      language: "en",
    }),
  );
  const threadId = await sha256(`${job.id}:${prefix}:${inputHash}`);
  const store = new ModelGraphStore(backend, job, threadId);
  await store.action("init", {
    input_hash: inputHash,
    task: "draft_section",
    graph_version: 1,
  });
  const legacyHash = await sha256(
    modelPrompt("draft_section", {}, [], [], "en"),
  );
  const pinKey = `semantic-instructions-${await sha256(`${prefix}:candidate-0`)}`;
  // Recreate a pre-rollout initial dispatch. Deleting only this synthetic pin
  // below models a historical accepted request with no semantic policy record.
  await store.action("result_put", {
    key: pinKey,
    value: { version: 0, legacy_input_hash: legacyHash },
  });
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: [
      { type: "paragraph", text: "Proposed work needs buyer confirmation." },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    methods.push(init?.method ?? "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.system_instruction).not.toContain(SEMANTIC_INSTRUCTIONS_V1);
      return Response.json({ id: "historical-draft", status: "in_progress" });
    }
    return Response.json({
      id: "historical-draft",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(candidate) }],
        },
      ],
      usage: {
        total_input_tokens: 10,
        total_output_tokens: 8,
        total_thought_tokens: 0,
      },
    });
  };
  const options = {
    backend,
    job,
    prefix,
    task: "draft_section" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en" as const,
    repair: false,
    fetcher,
  };
  await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  const original = (
    await f.db.query<any>(
      "select execution_metadata from public.model_attempts where job_id=$1 and sent order by id limit 1",
      [job.id],
    )
  ).rows[0].execution_metadata;
  expect(original.input_hash).toBe(legacyHash);
  await f.db.query(
    "delete from app_private.model_graph_results where thread_id=$1 and result_key=$2",
    [threadId, pinKey],
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  const resumed = await rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(job.id);
  // Producing the paid candidate yields before independent verification. No
  // new writer, reserve, or altered-input generation is permitted on replay.
  await expect(
    executeGuardedModel({ ...options, job: resumed }),
  ).rejects.toBeInstanceOf(ModelDeferred);
  expect(methods).toEqual(["POST", "GET"]);
  const calls = (
    await f.db.query<any>(
      "select input_hash,state,remote_request_id from public.provider_usage where job_id=$1",
      [job.id],
    )
  ).rows;
  expect(calls).toEqual([
    {
      input_hash: legacyHash,
      state: "settled",
      remote_request_id: "historical-draft",
    },
  ]);
  const after = (
    await f.db.query<any>(
      "select execution_metadata from public.model_attempts where job_id=$1 order by id desc limit 1",
      [job.id],
    )
  ).rows[0].execution_metadata;
  for (const key of [
    "input_hash",
    "prompt_version",
    "profile",
    "capabilities",
    "route_revision",
  ])
    expect(after[key]).toEqual(original[key]);
  expect(
    (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where thread_id=$1 and result_key=$2",
        [threadId, pinKey],
      )
    ).rows[0].value.version,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where thread_id=$1 and result_key='candidate-0'",
        [threadId],
      )
    ).rows[0].value.result,
  ).toEqual(candidate);
}, 30000);

it("resumes an accepted Gemini request with its original effective metadata and GET only", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { job, backend, envs, models } = await configure("gemini_free");
  await f.command("model.task_route.save", {
    task: "connection_probe",
    model_ids: [models[0].id],
    inherit_default: false,
    strategy: "priority",
    profile: { ...taskRegistry.verify_grounding.profile, reasoning: "medium" },
    expected_revision: 0,
  });
  const internal = vi.fn(backend.internal);
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    methods.push(init?.method ?? "");
    if (init?.method === "POST") {
      expect(
        JSON.parse(String(init.body)).generation_config.thinking_level,
      ).toBe("medium");
      return Response.json({ id: "accepted-original", status: "in_progress" });
    }
    return Response.json({
      id: "accepted-original",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: '{"status":"ready"}' }],
        },
      ],
      usage: {
        total_input_tokens: 10,
        total_output_tokens: 8,
        total_thought_tokens: 2,
      },
    });
  };
  const options = {
    backend: { ...backend, internal } as unknown as Backend,
    job,
    prefix: `probe:${job.id}`,
    task: "connection_probe" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en" as const,
    repair: false,
    fetcher,
  };
  await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  const original = (
    await f.db.query<any>(
      "select execution_metadata from public.model_attempts where job_id=$1 and sent order by id limit 1",
      [job.id],
    )
  ).rows[0].execution_metadata;
  expect(original.profile.reasoning).toBe("medium");
  expect(original.capabilities.reasoning).toBe("gemini_level");
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  const resumed = await rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(job.id);
  internal.mockClear();
  expect(
    (await executeGuardedModel({ ...options, job: resumed })).result,
  ).toEqual({ status: "ready" });
  expect(methods).toEqual(["POST", "GET"]);
  expect(
    internal.mock.calls.some(
      ([name]) =>
        name === "model_reasoning_allowed" ||
        name === "model_background_allowed" ||
        name === "reserve_task_model_call",
    ),
  ).toBe(false);
  const after = (
    await f.db.query<any>(
      "select execution_metadata from public.model_attempts where job_id=$1 order by id desc limit 1",
      [job.id],
    )
  ).rows[0].execution_metadata;
  for (const key of [
    "input_hash",
    "profile",
    "capabilities",
    "prompt_version",
    "route_revision",
    "reasoning_control",
  ])
    expect(after[key]).toEqual(original[key]);
}, 30000);

it.each(["openai", "gemini_free"] as const)(
  "automatically retries an explicitly unsupported %s background request on the same model in a fresh graph lease",
  async (provider) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { job, backend, envs, models, connection } =
      await configure(provider);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: any[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.background)
        return Response.json(
          {
            error: {
              message: "This model does not support background requests.",
            },
          },
          { status: 400 },
        );
      if (provider === "gemini_free") {
        expect(String(url)).toContain("fixture-model-a:generateContent");
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
      }
      expect(body).toMatchObject({
        model: "fixture-model-a",
        store: false,
      });
      expect(body.background).toBeUndefined();
      return Response.json({
        id: "fixture-standard",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"status":"ready"}' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 8 },
      });
    };
    const options = {
      backend,
      job,
      prefix: `probe:${job.id}`,
      task: "connection_probe" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
      ModelDeferred,
    );
    expect(bodies).toHaveLength(1);
    expect(
      (
        await f.db.query<any>(
          "select status,error_code,lease_token from public.jobs where id=$1",
          [job.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: "retry_wait",
      error_code: "MODEL_IN_PROGRESS",
      lease_token: null,
    });
    await f.db.query(
      "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [job.id],
    );
    const resumed = await rpc("claim_backend_job_v2");
    expect(resumed.lease_token).not.toBe(job.lease_token);
    const identity = {
      job_id: job.id,
      lease: resumed.lease_token,
      target_provider: provider,
      target_model: models[0].model,
      target_project: connection.project_ref,
      target_connection: connection.id,
      target_configuration: models[0].id,
    };
    expect(await rpc("model_background_allowed", identity)).toBe(false);
    expect(
      await rpc("model_background_allowed", {
        ...identity,
        target_model: models[1].model,
        target_configuration: models[1].id,
      }),
    ).toBe(true);
    await expect(
      rpc("model_background_allowed", {
        ...identity,
        target_model: "forged-model",
      }),
    ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
    await expect(
      rpc("model_background_allowed", { ...identity, lease: job.lease_token }),
    ).rejects.toMatchObject({ code: "STALE_LEASE" });
    const outcome = await executeGuardedModel({ ...options, job: resumed });
    expect(outcome.result).toEqual({ status: "ready" });
    expect(bodies).toHaveLength(2);
    const attempts = (
      await f.db.query<any>(
        "select lease_token,model,model_config_id,status,result_code,provider_error_reason,execution_metadata from public.model_attempts where job_id=$1 order by id",
        [job.id],
      )
    ).rows;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      model: models[0].model,
      model_config_id: models[0].id,
      status: "failed",
      result_code: "PROVIDER_REQUEST_INVALID",
      provider_error_reason: "background_unsupported",
      execution_metadata: { capabilities: { background: true } },
    });
    expect(attempts[1]).toMatchObject({
      model: models[0].model,
      model_config_id: models[0].id,
      status: "succeeded",
      execution_metadata: { capabilities: { background: false } },
    });
    expect(new Set(attempts.map((a) => a.lease_token)).size).toBe(2);
    expect(
      (
        await f.db.query<any>(
          "select state,actual_input,actual_output from public.provider_usage where job_id=$1 order by created_at,id",
          [job.id],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { state: "settled", actual_input: null, actual_output: null },
        { state: "settled", actual_input: 10, actual_output: 8 },
      ]),
    );
    // Cache expiry allows a later capability check; ordinary schema failures do not disable background processing.
    await f.db.query(
      "update public.model_attempts set started_at=now()-interval '2 days' where job_id=$1 and status='failed'",
      [job.id],
    );
    expect(await rpc("model_background_allowed", identity)).toBe(true);
    await f.db.query(
      "update public.model_attempts set started_at=now(),provider_error_reason='provider_rejected' where job_id=$1 and status='failed'",
      [job.id],
    );
    expect(await rpc("model_background_allowed", identity)).toBe(true);
    const permissions = (
      await f.db.query<any>(
        "select has_function_privilege('anon','public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid)','execute') anon,has_function_privilege('authenticated','public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid)','execute') authenticated,has_function_privilege('service_role','public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid)','execute') service",
      )
    ).rows[0];
    expect(permissions).toEqual({
      anon: false,
      authenticated: false,
      service: true,
    });
  },
);
it("uses another model on the same connection after a model error, preserving distinct attempts and usage", async () => {
  const { job, models, envs, ledger } = await configure();
  const sent: string[] = [];
  const result = await executeModel(
    "connection_probe",
    {},
    [],
    [],
    [],
    envs,
    ledger,
    "en",
    false,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body.model);
      if (body.model === "fixture-model-a")
        return Response.json(
          { error: { code: "model_not_found" } },
          { status: 404 },
        );
      return Response.json({
        choices: [
          { finish_reason: "stop", message: { content: '{"status":"ready"}' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    },
  );
  expect(result).toEqual({ status: "ready" });
  expect(sent).toEqual(["fixture-model-a", "fixture-model-b"]);
  const usage = (
    await f.db.query<any>(
      "select model,model_config_id,connection_id,state from public.provider_usage where job_id=$1 order by created_at,id",
      [job.id],
    )
  ).rows;
  expect(usage).toHaveLength(2);
  expect(new Set(usage.map((u) => u.model_config_id))).toEqual(
    new Set(models.map((m) => m.id)),
  );
  const attempts = (
    await f.db.query<any>(
      "select model_config_id,status from public.model_attempts where job_id=$1 order by id",
      [job.id],
    )
  ).rows;
  expect(attempts).toEqual([
    { model_config_id: models[0].id, status: "failed" },
    { model_config_id: models[1].id, status: "succeeded" },
  ]);
});
it("keeps a pending remote request pinned to its original model across settings edits and a new lease", async () => {
  const { job, models, envs, ledger, backend } = await configure("openai");
  const methods: string[] = [];
  const send: typeof fetch = async (_url, init) => {
    methods.push(init?.method ?? "POST");
    return init?.method === "GET"
      ? Response.json({
          id: "fixture-remote",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"status":"ready"}' }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        })
      : Response.json({ id: "fixture-remote", status: "queued" });
  };
  await expect(
    executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      envs,
      ledger,
      "en",
      false,
      send,
    ),
  ).rejects.toBeInstanceOf(ModelDeferred);
  await f.command("model.configuration.save", {
    id: models[0].id,
    expected_revision: 1,
    connection_id: models[0].connection_id,
    label: "Changed for future work",
    model: "future-model",
    enabled: true,
    capabilities: defaultCapabilities("openai"),
  });
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  const resumed = await rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(job.id);
  expect(
    await executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      envs,
      modelLedger(backend, resumed, `probe:${job.id}`, envs),
      "en",
      false,
      send,
    ),
  ).toEqual({ status: "ready" });
  expect(methods).toEqual(["POST", "GET"]);
  expect(
    (
      await f.db.query<any>(
        "select model from public.provider_usage where job_id=$1",
        [job.id],
      )
    ).rows,
  ).toEqual([{ model: "fixture-model-a" }]);
});

it("makes healthy polls eligible at the next normal cron tick without shortening error waits or generating again", async () => {
  const { job, backend, envs } = await configure("openai");
  const methods: string[] = [];
  let retryAfter: string | null = null;
  const fetcher: typeof fetch = async (_url, init) => {
    methods.push(init?.method ?? "POST");
    if (init?.method === "POST")
      return Response.json({ id: "fixture-poll-timing", status: "queued" });
    return Response.json(
      { error: { message: "Temporary provider failure" } },
      {
        status: retryAfter ? 429 : 503,
        headers: retryAfter ? { "retry-after": retryAfter } : undefined,
      },
    );
  };
  const run = (current: typeof job) =>
    executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      envs,
      modelLedger(backend, current, `probe:${job.id}`, envs),
      "en",
      false,
      fetcher,
    );
  const timing = async () =>
    (
      await f.db.query<any>(
        "select status,lease_token,extract(epoch from next_attempt_at-now())::int delay from jobs where id=$1",
        [job.id],
      )
    ).rows[0];
  await expect(run(job)).rejects.toBeInstanceOf(ModelDeferred);
  const healthy = await timing();
  expect(healthy).toEqual({
    status: "retry_wait",
    lease_token: null,
    delay: 30,
  });
  // Check the actual DB interval against a deterministic minute-boundary clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime("2026-10-21T12:00:05.000Z");
    const eligibleAt = Date.now() + healthy.delay * 1000;
    const previousPolicyAt = Date.now() + 60000;
    vi.setSystemTime("2026-10-21T12:01:00.000Z");
    expect(Date.now() >= eligibleAt).toBe(true);
    expect(Date.now() >= previousPolicyAt).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  // Move only this isolated fixture to due time. Both errors remain GET-only.
  for (const expected of [60, 600]) {
    if (expected === 600)
      retryAfter = new Date(
        (
          await f.db.query<any>(
            "select now()+interval '10 minutes' retry_after",
          )
        ).rows[0].retry_after,
      ).toISOString();
    await f.db.query(
      "update jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [job.id],
    );
    const current = await rpc("claim_backend_job_v2");
    expect(current.id).toBe(job.id);
    await expect(run(current)).rejects.toBeInstanceOf(ModelDeferred);
    expect(await timing()).toEqual({
      status: "retry_wait",
      lease_token: null,
      delay: expected,
    });
  }
  expect(methods).toEqual(["POST", "GET", "GET"]);
  expect(
    (
      await f.db.query<any>(
        "select state,remote_request_id,actual_input,actual_output from provider_usage where job_id=$1",
        [job.id],
      )
    ).rows,
  ).toEqual([
    {
      state: "reserved",
      remote_request_id: "fixture-poll-timing",
      actual_input: null,
      actual_output: null,
    },
  ]);
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('anon',p.oid,'execute') anon_execute,has_function_privilege('authenticated',p.oid,'execute') browser_execute,has_function_privilege('service_role',p.oid,'execute') service_execute from pg_proc p where proname='defer_pending_model_request'",
      )
    ).rows,
  ).toEqual([
    { anon_execute: false, browser_execute: false, service_execute: true },
  ]);
});

it("isolates phase resumptions while preserving unknown requests and rejecting changed inputs within a phase", async () => {
  const { job, ledger, models, connection } = await configure("gemini_free");
  await ledger.preflight([], "connection_probe");
  const hash = "a".repeat(64),
    prefix = `step:${job.id}:candidate-0`;
  const usage = await rpc("reserve_task_model_call", {
    job_id: job.id,
    lease: job.lease_token,
    call_key: `${prefix}:${hash.slice(0, 16)}:1:${models[0].id}`,
    input_tokens: 10,
    output_tokens: 1024,
    input_hash: hash,
    manifest: [],
    target_model: models[0].id,
    target_connection: connection.id,
  });
  await rpc("checkpoint_model_request", {
    job_id: job.id,
    lease: job.lease_token,
    reservation: usage.id,
    remote_id: "fixture-accepted",
  });
  await rpc("settle_model_call", {
    reservation: usage.id,
    actual_input: null,
    actual_output: null,
    thinking: null,
    error_code: "PROVIDER_REQUEST_INVALID",
  });
  const args = {
    job_id: job.id,
    lease: job.lease_token,
    input_hash: hash,
    manifest: [],
    target_model: models[0].id,
    target_connection: connection.id,
    request_prefix: prefix,
  };
  expect((await rpc("resume_task_model_request_phase", args)).id).toBe(
    usage.id,
  );
  await expect(
    rpc("resume_task_model_request_phase", {
      ...args,
      input_hash: "b".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
  expect(
    await rpc("resume_task_model_request_phase", {
      ...args,
      input_hash: "b".repeat(64),
      request_prefix: `step:${job.id}:verification-v3`,
    }),
  ).toBeNull();
  await rpc("settle_model_call", {
    reservation: usage.id,
    actual_input: null,
    actual_output: null,
    thinking: null,
    error_code: "PROVIDER_BACKGROUND_RETRIEVAL_FAILED",
  });
  expect((await rpc("resume_task_model_request_phase", args)).id).toBe(
    usage.id,
  );
  expect(
    await rpc("model_background_allowed", {
      job_id: job.id,
      lease: job.lease_token,
      target_provider: "gemini_free",
      target_model: models[0].model,
      target_project: "fixture-account",
      target_connection: connection.id,
      target_configuration: models[0].id,
    }),
  ).toBe(false);
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input,actual_output from provider_usage where id=$1",
        [usage.id],
      )
    ).rows[0],
  ).toEqual({ state: "unknown", actual_input: null, actual_output: null });
});

it.each([
  { finalRemainingMs: 20000, reorderedPolicy: false },
  { finalRemainingMs: 5000, reorderedPolicy: false },
  { finalRemainingMs: 20000, reorderedPolicy: true },
  { finalRemainingMs: 5000, reorderedPolicy: true },
  { finalRemainingMs: 20000, reorderedPolicy: true, internalReferences: true },
])(
  "durably verifies batches across restarts ($finalRemainingMs ms, JSONB policy order: $reorderedPolicy)",
  async ({ finalRemainingMs, reorderedPolicy, internalReferences }) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { candidateContent } =
      await import("../../supabase/functions/_shared/modelGrounding");
    const { job, backend, envs } = await configure();
    if (reorderedPolicy) {
      const internal = backend.internal;
      backend.internal = async (name, args) => {
        const row = await internal.call(backend, name, args);
        if (
          name === "model_graph_store" &&
          row?.result_key?.startsWith("verification-batches-") &&
          row.value?.policy
        )
          return {
            ...row,
            value: {
              policy: {
                outputTokens: row.value.policy.outputTokens,
                version: row.value.policy.version,
              },
              version: row.value.version,
            },
          };
        return row;
      };
    }
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const invocationBudgetMs = 130000;
    let activeLease = job.lease_token;
    let coverageLease: string | undefined;
    const calls: { lease: string; scope: string }[] = [];
    const text = (
      "Proposed approach requires buyer confirmation. " +
      (internalReferences ? "See delivery-7-access_gate. " : "")
    ).repeat(internalReferences ? 30 : 42);
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: Array.from({ length: reorderedPolicy ? 18 : 9 }, () => ({
        type: "paragraph",
        text,
      })),
      requirement_ids: ["required-1"],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    let writes = 0;
    const batches = new Set<string>();
    const fetcher: typeof fetch = async (_url, init) => {
      const prompt = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content.split(
          "\nJSON schema: ",
        )[0],
      );
      let result: any;
      calls.push({
        lease: activeLease,
        scope: prompt.untrusted_data.verification_scope ?? "writer",
      });
      if (prompt.task === "draft_section") {
        writes++;
        result = candidate;
      } else {
        const c = prompt.untrusted_data;
        const coverage = c.verification_scope === "requirements_only";
        if (coverage) {
          coverageLease = activeLease;
          now += invocationBudgetMs - finalRemainingMs;
        }
        expect(["content_batch", "requirements_only"]).toContain(
          c.verification_scope,
        );
        const key =
          c.verification_scope +
          c.content_units.map((u: any) => u.id).join(",");
        expect(batches.has(key)).toBe(false);
        batches.add(key);
        result = {
          checked_candidate_hash: c.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: c.content_units.map((u: any) => u.id),
          claims: coverage
            ? []
            : [
                {
                  id: "claim",
                  claim: "Proposed approach",
                  candidate_quote: c.content_units[0].text,
                  kind: internalReferences ? "tender_fact" : "assumption",
                  status: "supported",
                  source_refs: internalReferences
                    ? [{ id: "notice", quote: "Buyer approval is required." }]
                    : [],
                  finding: "Conditional proposed work",
                },
              ],
          processed_requirement_ids: coverage ? ["required-1"] : [],
          requirement_checks: coverage
            ? [
                {
                  requirement_id: "required-1",
                  status: "supported",
                  candidate_quote:
                    "Proposed approach requires buyer confirmation.",
                  source_refs: [],
                  finding: "Proposed work is explicit.",
                },
              ]
            : [],
          findings: [],
        };
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    let current = job,
      outcome;
    for (let i = 0; i < 12; i++) {
      activeLease = current.lease_token;
      Object.assign(backend, { invocationStartedAt: now, invocationBudgetMs });
      try {
        outcome = await executeGuardedModel({
          backend,
          job: current,
          prefix: `step:${job.id}`,
          task: "draft_section",
          context: reorderedPolicy
            ? {
                workflow_version: 2,
                verification_output_tokens: 40000,
                ...(internalReferences
                  ? {
                      response_locations: [
                        { section_key: "delivery-7-access_gate" },
                      ],
                    }
                  : {}),
              }
            : {},
          evidence: internalReferences
            ? [
                {
                  id: "notice",
                  text: "Buyer approval is required.",
                  kind: "notice",
                  verified: false,
                },
              ]
            : [],
          requiredIds: ["required-1"],
          manifest: [],
          environments: envs,
          language: "en",
          repair: false,
          fetcher,
        });
        expect(calls.filter((call) => call.lease === activeLease)).toHaveLength(
          finalRemainingMs >= 10000 ? 1 : 0,
        );
        break;
      } catch (error) {
        if (!(error instanceof ModelDeferred)) throw error;
        const sent = calls.filter((call) => call.lease === activeLease);
        expect(sent).toHaveLength(1);
        expect(
          sent[0].scope === "requirements_only" && finalRemainingMs >= 10000,
        ).toBe(false);
        // Every content lease stops after its one call and saves the report;
        // a final coverage lease yields only when local commit time is short.
        if (sent[0].scope !== "writer") {
          const cached = (
            await f.db.query<any>(
              "select result_key from app_private.model_graph_results where result_key like 'verification-v3-%'",
            )
          ).rows;
          expect(cached).toHaveLength(batches.size);
          expect(
            (
              await f.db.query<any>(
                "select count(*)::int count from app_private.model_graph_results where result_key='accepted'",
              )
            ).rows[0].count,
          ).toBe(0);
        }
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    expect(outcome?.result).toEqual(candidate);
    expect(writes).toBe(1);
    expect(batches.size).toBeGreaterThan(2);
    expect(activeLease === coverageLease).toBe(finalRemainingMs >= 10000);
    const saved = (
      await f.db.query<any>(
        "select result_key,value from app_private.model_graph_results where result_key like 'verification-%' or result_key='accepted'",
      )
    ).rows;
    const merged = saved.find((row) =>
      /^verification-[a-f0-9]{64}$/.test(row.result_key),
    );
    expect(merged.value.result.processed_content_ids).toEqual(
      candidateContent(candidate).map((unit) => unit.id),
    );
    expect(merged.value.result.processed_requirement_ids).toEqual([
      "required-1",
    ]);
    expect(merged.value.result.requirement_checks[0].status).toBe("supported");
    expect(saved.find((row) => row.result_key === "accepted").value).toEqual(
      candidate,
    );
    expect(
      (
        await f.db.query<any>(
          "select status,candidate_count from app_private.model_graph_threads",
        )
      ).rows,
    ).toEqual([{ status: "accepted", candidate_count: 1 }]);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from public.provider_usage",
        )
      ).rows[0].count,
    ).toBe(1 + batches.size);
  },
);
it("allows a distinct phase past unknown Gemini usage while preserving same-phase and same-input guards", async () => {
  const { job, models, connection, ledger } = await configure("gemini_free");
  await ledger.preflight([], "connection_probe");
  const originalHash = "a".repeat(64),
    nextHash = "b".repeat(64);
  const prefix = `probe:${job.id}:candidate-0`;
  const reserve = (phase: string, hash: string, attempt: number) =>
    rpc("reserve_task_model_call", {
      job_id: job.id,
      lease: job.lease_token,
      call_key: `${phase}:${hash.slice(0, 16)}:${attempt}:${models[0].id}`,
      input_hash: hash,
      input_tokens: 100,
      output_tokens: 100,
      manifest: [],
      target_model: models[0].id,
      target_connection: connection.id,
    });
  const old = await reserve(prefix, originalHash, 1);
  await rpc("checkpoint_model_request", {
    job_id: job.id,
    lease: job.lease_token,
    reservation: old.id,
    remote_id: "fixture-phase-retrieval",
  });
  await expect(
    reserve(`${prefix}:verification`, nextHash, 2),
  ).rejects.toMatchObject({ code: "MODEL_RATE_WAIT" });
  await rpc("settle_model_call", {
    reservation: old.id,
    actual_input: null,
    actual_output: null,
    thinking: null,
    error_code: "PROVIDER_BACKGROUND_RETRIEVAL_FAILED",
  });
  for (const [phase, hash] of [
    [prefix, originalHash],
    [prefix, nextHash],
    [`${prefix}:verification`, originalHash],
  ])
    await expect(reserve(phase, hash, 2)).rejects.toMatchObject({
      code: "USAGE_REVIEW_REQUIRED",
    });
  // Callers without an identifiable phase retain the conservative old guard.
  await expect(
    rpc("reserve_task_model_call", {
      job_id: job.id,
      lease: job.lease_token,
      call_key: "legacy-unstructured",
      input_hash: nextHash,
      input_tokens: 100,
      output_tokens: 100,
      manifest: [],
      target_model: models[0].id,
      target_connection: connection.id,
    }),
  ).rejects.toMatchObject({ code: "USAGE_REVIEW_REQUIRED" });
  const before = (
    await f.db.query<any>(
      "select id,state,actual_input,actual_output,thinking_tokens,remote_request_id,remote_deadline from provider_usage where id=$1",
      [old.id],
    )
  ).rows[0];
  const next = await reserve(`${prefix}:verification`, nextHash, 2);
  expect(next.state).toBe("reserved");
  expect(next.id).not.toBe(old.id);
  expect(
    (
      await f.db.query<any>(
        "select id,state,actual_input,actual_output,thinking_tokens,remote_request_id,remote_deadline from provider_usage where id=$1",
        [old.id],
      )
    ).rows[0],
  ).toEqual(before);
  expect(before).toMatchObject({
    state: "unknown",
    actual_input: null,
    actual_output: null,
    thinking_tokens: null,
    remote_request_id: "fixture-phase-retrieval",
  });
  // The old accepted request remains retrievable under its own phase identity.
  expect(
    (
      await rpc("resume_task_model_request_phase", {
        job_id: job.id,
        lease: job.lease_token,
        input_hash: originalHash,
        manifest: [],
        target_model: models[0].id,
        target_connection: connection.id,
        request_prefix: prefix,
      })
    ).id,
  ).toBe(old.id);
});

it("retains unknown accepted-request protection across jobs with the same input", async () => {
  const { job, models, connection, ledger, backend, envs } =
    await configure("gemini_free");
  await ledger.preflight([], "connection_probe");
  const hash = "a".repeat(64);
  const old = await rpc("reserve_task_model_call", {
    job_id: job.id,
    lease: job.lease_token,
    call_key: `old-phase:${hash.slice(0, 16)}:1:${models[0].id}`,
    input_hash: hash,
    input_tokens: 100,
    output_tokens: 100,
    manifest: [],
    target_model: models[0].id,
    target_connection: connection.id,
  });
  await rpc("checkpoint_model_request", {
    job_id: job.id,
    lease: job.lease_token,
    reservation: old.id,
    remote_id: "fixture-cross-job-unknown",
  });
  await rpc("settle_model_call", {
    reservation: old.id,
    actual_input: null,
    actual_output: null,
    thinking: null,
    error_code: "PROVIDER_BACKGROUND_RETRIEVAL_FAILED",
  });
  await f.db.query(
    "update jobs set status='succeeded',lease_token=null,lease_until=null where id=$1",
    [job.id],
  );
  const queued = await f.command("model.probe", {});
  const next = await rpc("claim_backend_job_v2");
  expect(next.id).toBe(queued.id);
  await modelLedger(backend, next, "new-phase", envs).preflight(
    [],
    "connection_probe",
  );
  await expect(
    rpc("reserve_task_model_call", {
      job_id: next.id,
      lease: next.lease_token,
      call_key: `new-phase:${hash.slice(0, 16)}:1:${models[0].id}`,
      input_hash: hash,
      input_tokens: 100,
      output_tokens: 100,
      manifest: [],
      target_model: models[0].id,
      target_connection: connection.id,
    }),
  ).rejects.toMatchObject({ code: "USAGE_REVIEW_REQUIRED" });
  expect(
    (await f.db.query<any>("select count(*)::int count from provider_usage"))
      .rows[0].count,
  ).toBe(1);
});
it("imports legacy names once, preserving subsequent database edits", async () => {
  const { job, models, connection } = await configure();
  const metadata = [
    {
      provider: "groq_free",
      model: "obsolete-secret-name",
      project_ref: connection.project_ref,
      key_configured: true,
      capabilities: defaultCapabilities("groq_free"),
    },
  ];
  await rpc("import_model_catalog", {
    job_id: job.id,
    lease: job.lease_token,
    server_models: metadata,
  });
  await rpc("import_model_catalog", {
    job_id: job.id,
    lease: job.lease_token,
    server_models: metadata,
  });
  expect(
    (
      await f.db.query<any>(
        "select model from public.model_configurations where connection_id=$1 order by model",
        [connection.id],
      )
    ).rows.map((x) => x.model),
  ).toEqual(models.map((m) => m.model));
});
it("keeps jobs on legacy routing when new-work admission is disabled", async () => {
  const { ledger } = await configure();
  await f.command("model.execution.configure", {
    enabled: false,
    expected_revision: 1,
  });
  expect(
    (await ledger.preflight([], "connection_probe")).executor_version,
  ).toBeUndefined();
});
it("imports an existing server setup before new routes have been configured", async () => {
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  await f.command("model.probe", {});
  const job = await rpc("claim_backend_job_v2");
  const envs = modelEnvironments((name) =>
    name.endsWith("_KEY")
      ? "fixture-key"
      : name.endsWith("_PROJECT")
        ? "fixture-account"
        : name.endsWith("_NAME")
          ? "fixture-model"
          : undefined,
  );
  const ledger = modelLedger(
    { internal: rpc } as unknown as Backend,
    job,
    "fixture",
    envs,
  );
  expect(
    (await ledger.preflight([], "connection_probe")).providers.length,
  ).toBe(8);
});
it("shares an account 429 with sibling models while keeping other accounts independently eligible", async () => {
  const { job, models, ledger } = await configure();
  await ledger.preflight([], "connection_probe");
  await f.db.query(
    `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,connection_id,model_config_id,http_status,sent)
    select workspace_id,$1,$2,'groq_free',model,'fixture-account','connection_probe',1,1,'failed',connection_id,id,429,true from public.model_configurations where id=$3`,
    [job.id, job.lease_token, models[0].id],
  );
  const waits = await rpc("task_model_retry_windows", {
    job_id: job.id,
    lease: job.lease_token,
  });
  expect(new Set(waits.map((w: any) => w.model_config_id))).toEqual(
    new Set(models.map((m) => m.id)),
  );
});
it("requires explicit grants, RLS, Owner commands, revisions and current leases", async () => {
  const { job, models } = await configure();
  const tables = [
    "model_connections",
    "model_configurations",
    "model_task_routes",
    "model_execution_settings",
  ];
  for (const name of tables) {
    const row = (
      await f.db.query<any>(
        "select relrowsecurity,has_table_privilege('anon',oid,'select') anon_read,has_table_privilege('authenticated',oid,'insert') browser_write,has_table_privilege('service_role',oid,'select') service_read from pg_class where oid=$1::regclass",
        ["public." + name],
      )
    ).rows[0];
    expect(row).toEqual({
      relrowsecurity: true,
      anon_read: false,
      browser_write: false,
      service_read: true,
    });
  }
  await expect(
    f.command("model.configuration.save", {
      id: models[0].id,
      expected_revision: 0,
      connection_id: models[0].connection_id,
      label: "Changed",
      model: "other",
      enabled: true,
      capabilities: defaultCapabilities("groq_free"),
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await expect(
    rpc("prepare_task_model_route", {
      job_id: job.id,
      lease: crypto.randomUUID(),
      task_name: "connection_probe",
      default_profile: taskRegistry.connection_probe.profile,
    }),
  ).rejects.toMatchObject({ code: "STALE_LEASE" });
});

it("runs the actual durable probe graph and commits once without duplicate requests", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { job, backend, envs } = await configure();
  vi.stubEnv("LANGSMITH_TRACING", "true");
  vi.stubEnv("LANGSMITH_TRACING_V2", "true");
  vi.stubEnv("LANGCHAIN_TRACING", "true");
  vi.stubEnv("LANGCHAIN_TRACING_V2", "true");
  vi.stubEnv("LANGSMITH_API_KEY", "isolated-fixture-not-a-secret");
  const externalTrace = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected trace export"));
  let sends = 0;
  const outcome = await executeGuardedModel({
    backend,
    job,
    prefix: `probe:${job.id}`,
    task: "connection_probe",
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en",
    repair: false,
    fetcher: async () => {
      sends++;
      return Response.json({
        choices: [
          { finish_reason: "stop", message: { content: '{"status":"ready"}' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    },
  });
  expect(outcome.result).toEqual({ status: "ready" });
  expect(outcome.threadId).toBeTruthy();
  await rpc("complete_model_probe_graph", {
    job_id: job.id,
    lease: job.lease_token,
    thread_id: outcome.threadId,
    result: outcome.result,
  });
  expect(sends).toBe(1);
  expect(externalTrace).not.toHaveBeenCalled();
  expect(
    (
      await f.db.query<any>("select status from public.jobs where id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("succeeded");
  expect(
    (
      await f.db.query<any>(
        "select status from app_private.model_graph_threads where id=$1",
        [outcome.threadId],
      )
    ).rows[0].status,
  ).toBe("committed");
});

it("persists a pending provider request before releasing the graph lease and polls it after restart", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { job, backend, envs } = await configure("openai");
  const methods: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    methods.push(init?.method ?? "POST");
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    return init?.method === "GET"
      ? Response.json({
          id: "fixture-graph-remote",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"status":"ready"}' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 8 },
        })
      : Response.json({ id: "fixture-graph-remote", status: "queued" });
  };
  const options = {
    backend,
    job,
    prefix: `probe:${job.id}`,
    task: "connection_probe" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en" as const,
    repair: false,
    fetcher,
  };
  await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [job.id],
  );
  const resumed = await rpc("claim_backend_job_v2");
  const outcome = await executeGuardedModel({ ...options, job: resumed });
  expect(outcome.result).toEqual({ status: "ready" });
  expect(methods).toEqual(["POST", "GET", "DELETE"]);
});

it.each(["corrected", "unchanged", "evolving", "unsupported_verifier"])(
  "bounds whole-text correction across graph restarts: %s",
  async (mode) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { job, backend, envs } = await configure();
    const initial = {
      key: "approach",
      title: "Approach",
      content_blocks: [
        { type: "paragraph", text: "We have 50 certified engineers." },
      ],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    const fixed = {
      ...initial,
      content_blocks: [
        {
          type: "paragraph",
          text: "Proposed team size requires confirmation.",
        },
      ],
    };
    const calls: string[] = [];
    let repairCount = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const prompt = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content.split(
          "\nJSON schema: ",
        )[0],
      );
      calls.push(prompt.task);
      let result: any;
      if (prompt.task === "draft_section") result = initial;
      else if (prompt.task === "repair_result") {
        repairCount++;
        result = {
          target_task: "draft_section",
          result:
            mode === "corrected"
              ? fixed
              : mode === "unchanged"
                ? initial
                : {
                    ...initial,
                    content_blocks: [
                      {
                        type: "paragraph",
                        text: `We have ${50 + repairCount} certified engineers.`,
                      },
                    ],
                  },
          changes: ["Fixture correction candidate."],
        };
      } else {
        const c = prompt.untrusted_data;
        expect(c.candidate).toBeUndefined();
        expect(c.candidate_text).toBeUndefined();
        expect(c.response_style).toBe("compact-verification-v2");
        const paragraph = c.content_units.find((u: any) =>
          /engineers|team size/.test(u.text),
        ).text;
        const corrected = paragraph === fixed.content_blocks[0].text;
        result = {
          checked_candidate_hash: c.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: c.content_units.map((u: any) => u.id),
          claims: [
            {
              id: "claim-1",
              claim: paragraph,
              candidate_quote: paragraph,
              kind: corrected ? "assumption" : "company_fact",
              status:
                corrected || mode === "unsupported_verifier"
                  ? "supported"
                  : "insufficient",
              source_refs: [],
              finding: corrected
                ? "Explicit missing input."
                : "No verified company evidence supports this staffing claim.",
            },
          ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        };
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    const options = {
      backend,
      job,
      prefix: `test:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    let current = job,
      outcome,
      terminal;
    for (let i = 0; i < 10; i++) {
      try {
        outcome = await executeGuardedModel({ ...options, job: current });
        break;
      } catch (e) {
        if ((e as any).code === "MODEL_CORRECTION_EXHAUSTED") {
          terminal = e;
          break;
        }
        expect(e).toBeInstanceOf(ModelDeferred);
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    if (mode === "corrected") {
      expect(outcome?.result).toEqual(fixed);
      expect(calls).toEqual([
        "draft_section",
        "verify_grounding",
        "repair_result",
        "verify_grounding",
      ]);
    } else {
      expect(terminal).toBeTruthy();
      expect(outcome).toBeUndefined();
      expect(calls.length).toBe(mode === "unchanged" ? 3 : 6);
      expect(
        (
          await f.db.query<any>(
            "select status from app_private.model_graph_threads where job_id=$1",
            [job.id],
          )
        ).rows[0].status,
      ).toBe("needs_review");
    }
    expect(
      (
        await f.db.query<any>(
          "select candidate_count from app_private.model_graph_threads where job_id=$1",
          [job.id],
        )
      ).rows[0].candidate_count,
    ).toBe(1);
    expect(
      (
        await f.db.query<any>(
          "select b.candidates from app_private.model_graph_budgets b join app_private.model_graph_threads t on t.id=b.thread_id where t.job_id=$1 and b.unit='writer-repair'",
          [job.id],
        )
      ).rows[0].candidates,
    ).toBe(["evolving", "unsupported_verifier"].includes(mode) ? 2 : 1);
    if (mode === "unsupported_verifier") {
      expect(repairCount).toBe(2);
      expect(calls.filter((task) => task === "verify_grounding")).toHaveLength(
        3,
      );
      expect(
        (
          await f.db.query<any>(
            "select b.candidates from app_private.model_graph_budgets b join app_private.model_graph_threads t on t.id=b.thread_id where t.job_id=$1 and b.unit='writer'",
            [job.id],
          )
        ).rows[0].candidates,
      ).toBe(1);
      expect(
        (
          await f.db.query<any>(
            "select count(*)::int count from app_private.model_graph_results r join app_private.model_graph_threads t on t.id=r.thread_id where t.job_id=$1 and r.result_key='accepted'",
            [job.id],
          )
        ).rows[0].count,
      ).toBe(0);
    }
  },
);

it.each([false, true])(
  "repairs an invalid verifier report once without rewriting the candidate (repair invalid: %s)",
  async (stillInvalid) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { job, backend, envs } = await configure();
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: [
        { type: "paragraph", text: "Proposed team requires confirmation." },
      ],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    let writes = 0,
      reviews = 0,
      corrections = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const prompt = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content.split(
          "\nJSON schema: ",
        )[0],
      );
      let result: any;
      if (prompt.task === "draft_section") {
        writes++;
        result = candidate;
      } else {
        const c = prompt.untrusted_data;
        const correcting = Boolean(c.invalid_verification_result);
        if (correcting) {
          corrections++;
          expect(c.validation_error).toBe("EVIDENCE_REFERENCE_INVALID");
        } else reviews++;
        result = {
          checked_candidate_hash: c.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: c.content_units.map((u: any) => u.id),
          claims: [
            {
              id: "claim",
              claim: candidate.content_blocks[0].text,
              candidate_quote: candidate.content_blocks[0].text,
              kind: "assumption",
              status: "supported",
              source_refs:
                correcting && !stillInvalid
                  ? []
                  : [{ id: "invented-source", quote: "Fabricated citation" }],
              finding: "Explicit missing input.",
            },
          ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        };
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    const options = {
      backend,
      job,
      prefix: `step:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    let current = job,
      outcome,
      terminal;
    for (let i = 0; i < 8; i++) {
      try {
        outcome = await executeGuardedModel({ ...options, job: current });
        break;
      } catch (error) {
        if ((error as any).code === "MODEL_CORRECTION_EXHAUSTED") {
          terminal = error;
          break;
        }
        if (!(error instanceof ModelDeferred)) throw error;
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    expect(writes).toBe(1);
    expect(reviews).toBe(2);
    expect(corrections).toBe(1);
    if (stillInvalid) {
      expect(terminal).toBeTruthy();
      expect(outcome).toBeUndefined();
    } else {
      expect(terminal).toBeUndefined();
      expect(outcome?.result).toEqual(candidate);
    }
  },
);

it.each([false, true, "missing_support"])(
  "recovers retained batched correction without another model call or resetting budgets (semantic defect: %s)",
  async (semanticDefect) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { ModelGraphStore } =
      await import("../../supabase/functions/_shared/modelGraphStore");
    const { verificationBatches } =
      await import("../../supabase/functions/_shared/modelVerification");
    const { candidateContent } =
      await import("../../supabase/functions/_shared/modelGrounding");
    const { sha256 } = await import("../../supabase/functions/_shared/model");
    const { job, backend, envs } = await configure();
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: Array.from({ length: 9 }, () => ({
        type: "paragraph",
        text: (semanticDefect === "missing_support"
          ? "We have 50 certified engineers. "
          : "Proposed work requires buyer confirmation. "
        ).repeat(45),
      })),
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    let posts = 0;
    const fetcher: typeof fetch = async () => {
      posts++;
      if (posts > 1) throw new Error("Unexpected verification regeneration");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(candidate) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    const options = {
      backend,
      job,
      prefix: `step:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
      ModelDeferred,
    );
    const current = await rpc("claim_backend_job_v2");
    expect(current.id).toBe(job.id);
    const thread = (
      await f.db.query<any>(
        "select id from app_private.model_graph_threads where job_id=$1",
        [job.id],
      )
    ).rows[0];
    const store = new ModelGraphStore(backend, current, thread.id);
    const storedCandidate = (
      await store.action("result_get", { key: "candidate-0" })
    ).value.result;
    const hash = await sha256(JSON.stringify(storedCandidate));
    const batches = verificationBatches(storedCandidate);
    expect(batches.length).toBeGreaterThan(1);
    const scopes = [
      ...batches.map((units, index) => ({
        units,
        key: `content-${index}`,
        global: false,
      })),
      {
        units: candidateContent(storedCandidate),
        key: "requirements",
        global: true,
      },
    ];
    const producer = {
      provider: "groq_free",
      model: "retained-corrective-fixture",
    };
    let corrected: any;
    for (const [index, scope] of scopes.entries()) {
      const key = `verification-v3-${hash}-${scope.key}`;
      const report = {
        checked_candidate_hash: hash,
        reviewed_all_content: true,
        processed_content_ids: scope.units.map((unit) => unit.id),
        claims: scope.global
          ? []
          : [
              {
                id: "claim",
                claim: "Conditional proposed work",
                candidate_quote: scope.units[0].text,
                kind: "assumption",
                status: "supported",
                source_refs: [],
                finding: "Confirm proposed scope.",
              },
            ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [] as any[],
      };
      if (index === 0) {
        await store.action("result_put", {
          key: `invalid-${key}`,
          value: {
            result: report,
            code: "EVIDENCE_REFERENCE_INVALID",
            producer: { model: "older-fixture" },
          },
        });
        corrected = {
          ...report,
          claims:
            semanticDefect === "missing_support"
              ? [{ ...report.claims[0], kind: "company_fact" }]
              : report.claims,
          findings:
            semanticDefect === "missing_support"
              ? []
              : [
                  {
                    severity: semanticDefect ? "blocking" : "advisory",
                    code: "RETAINED_SCOPE_FINDING",
                    detail: "Retained corrective semantic finding.",
                    claim_ids: ["claim"],
                    requirement_ids: [],
                  },
                ],
        };
        await store.action("result_put", {
          key: `invalid-verification-repair-v3-${hash}-${scope.key}`,
          value: {
            result: corrected,
            code: "EVIDENCE_REFERENCE_INVALID",
            producer,
          },
        });
      } else
        await store.action("result_put", {
          key,
          value: { result: report, producer: null },
        });
    }
    // The fixture models an already exhausted original verifier round and its
    // one corrective candidate. Recovery must not create fresh allowances.
    for (const [unit, count] of [
      [`v3-${hash}-content-0`, 3],
      [`v3-${hash}-content-0-repair`, 1],
    ])
      await f.db.query(
        "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,$2,$3)",
        [thread.id, unit, count],
      );
    const budgets = async () =>
      (
        await f.db.query<any>(
          "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
          [thread.id],
        )
      ).rows;
    const before = await budgets();
    if (semanticDefect)
      await expect(
        executeGuardedModel({ ...options, job: current }),
      ).rejects.toBeInstanceOf(ModelDeferred);
    else
      expect(
        (await executeGuardedModel({ ...options, job: current })).result,
      ).toEqual(candidate);
    expect(posts).toBe(1);
    expect(await budgets()).toEqual(before);
    const saved = (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where thread_id=$1 and result_key=$2",
        [thread.id, `verification-v3-${hash}-content-0`],
      )
    ).rows[0].value;
    expect(saved).toEqual({ result: corrected, producer });
    const merged = (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where thread_id=$1 and result_key=$2",
        [
          thread.id,
          semanticDefect
            ? `verification-repair-only-v3-${hash}-content-0`
            : `verification-${hash}`,
        ],
      )
    ).rows[0].value.result;
    if (semanticDefect)
      expect(
        (
          await f.db.query<any>(
            "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key=$2",
            [thread.id, `verification-${hash}`],
          )
        ).rows[0].count,
      ).toBe(0);
    expect(merged.findings).toEqual(
      semanticDefect === "missing_support"
        ? []
        : [{ ...corrected.findings[0], claim_ids: ["b0-c0"] }],
    );
    if (semanticDefect === "missing_support") {
      const { groundingDefects } =
        await import("../../supabase/functions/_shared/modelGrounding");
      expect(groundingDefects(merged)).toEqual([
        expect.objectContaining({
          claim_id: "b0-c0",
          reason: "missing_supporting_evidence",
          status: "insufficient",
        }),
      ]);
    }
    const accepted = (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
        [thread.id],
      )
    ).rows[0].count;
    expect(accepted).toBe(semanticDefect ? 0 : 1);
  },
);

it.each([
  { batched: false, mode: "pending" },
  { batched: true, mode: "pending" },
  { batched: false, mode: "three-invalid" },
  { batched: true, mode: "three-invalid" },
  { batched: false, mode: "pending", retainedRecovery: true },
  { batched: true, mode: "pending", retainedRecovery: true },
])(
  "preserves the normal verifier round before correction: $mode, batched=$batched, retained=$retainedRecovery",
  async ({ batched, mode, retainedRecovery }) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { job, backend, envs, models, connection } = await configure(
      mode === "pending" ? "openai" : "groq_free",
    );
    if (mode === "three-invalid") {
      const third = await f.command("model.configuration.save", {
        connection_id: connection.id,
        label: "Third fixture",
        model: "fixture-model-c",
        enabled: true,
        capabilities: defaultCapabilities("groq_free"),
        expected_revision: 0,
      });
      await f.command("model.task_route.save", {
        task: "default",
        model_ids: [...models.map((m) => m.id), third.id],
        inherit_default: false,
        strategy: "priority",
        profile: null,
        expected_revision: 1,
      });
    }
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: Array.from({ length: batched ? 9 : 1 }, () => ({
        type: "paragraph",
        text: "Proposed approach requires buyer confirmation. ".repeat(
          batched ? 42 : 1,
        ),
      })),
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    let globalPasses = 0,
      writers = 0,
      firstRoundCalls = 0,
      corrections = 0,
      pendingGets = 0,
      serial = 0;
    const queued = new Map<string, any>();
    const openaiResult = (id: string, result: any) => ({
      id,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(result) }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "DELETE") return Response.json({ deleted: true });
      if (init?.method === "GET") {
        const id = String(url).split("/").pop()!;
        expect(queued.has(id)).toBe(true);
        pendingGets++;
        return Response.json(openaiResult(id, queued.get(id)));
      }
      const body = JSON.parse(String(init?.body));
      const prompt = JSON.parse(
        (body.input ?? body.messages[1].content).split("\nJSON schema: ")[0],
      );
      const id = `fixture-round-${++serial}`;
      let result: any;
      if (prompt.task === "draft_section") {
        writers++;
        result = candidate;
      } else {
        const c = prompt.untrusted_data,
          global = c.verification_scope === "requirements_only",
          first = !global && c.content_units[0].id === "content-0";
        if (global) globalPasses++;
        const correcting = Boolean(c.invalid_verification_result);
        if (correcting) corrections++;
        else if (first) firstRoundCalls++;
        const invalid =
          first &&
          !correcting &&
          (mode === "three-invalid" || firstRoundCalls === 1);
        result = {
          checked_candidate_hash: c.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: c.content_units.map((u: any) => u.id),
          claims: global
            ? []
            : [
                {
                  id: "claim",
                  claim: "Conditional proposal",
                  candidate_quote: c.content_units[0].text,
                  kind: "assumption",
                  status: "supported",
                  source_refs: invalid
                    ? [{ id: "missing-source", quote: "Fabricated citation" }]
                    : [],
                  finding: "Proposed work.",
                },
              ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        };
        if (mode === "pending" && first && !invalid && !correcting) {
          expect(firstRoundCalls).toBe(2);
          if (retainedRecovery) {
            // Restore a historical rejected report that current deterministic
            // guards accept. A newer accepted request must still be retrieved.
            const thread = (
              await f.db.query<any>(
                "select id from app_private.model_graph_threads where job_id=$1",
                [job.id],
              )
            ).rows[0];
            await rpc("model_graph_store", {
              job_id: job.id,
              lease: current.lease_token,
              thread_id: thread.id,
              action: "result_put",
              payload: {
                key: batched
                  ? `invalid-verification-repair-v3-${c.candidate_hash}-content-0`
                  : `invalid-verification-repair-${c.candidate_hash}`,
                value: {
                  result,
                  code: "EVIDENCE_REFERENCE_INVALID",
                  producer: null,
                },
              },
            });
          }
          queued.set(id, result);
          return Response.json({ id, status: "queued" });
        }
      }
      return Response.json(
        mode === "pending"
          ? openaiResult(id, result)
          : {
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: JSON.stringify(result) },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 8 },
            },
      );
    };
    let current = job,
      outcome;
    for (let i = 0; i < 24; i++) {
      try {
        outcome = await executeGuardedModel({
          backend,
          job: current,
          prefix: `step:${job.id}`,
          task: "draft_section",
          context: {},
          evidence: [],
          requiredIds: [],
          manifest: [],
          environments: envs,
          language: "en",
          repair: false,
          fetcher,
        });
        break;
      } catch (error) {
        if (!(error instanceof ModelDeferred)) throw error;
        await f.db.query(
          "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
          [job.id],
        );
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    expect(outcome?.result).toEqual(candidate);
    expect(writers).toBe(1);
    expect(globalPasses).toBe(batched ? 1 : 0);
    expect(firstRoundCalls).toBe(mode === "pending" ? 2 : 3);
    expect(corrections).toBe(mode === "pending" ? 0 : 1);
    expect(pendingGets).toBe(mode === "pending" ? 1 : 0);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from provider_usage where job_id=$1 and state='reserved'",
          [job.id],
        )
      ).rows[0].count,
    ).toBe(0);
    const markers = (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where result_key like 'verification-correction-ready-%'",
      )
    ).rows[0].count;
    expect(markers).toBe(mode === "pending" ? 0 : 1);
    const rejected = (
      await f.db.query<any>(
        `select result_key,value from app_private.model_graph_results
         where thread_id=(select id from app_private.model_graph_threads where job_id=$1)
         and result_key like 'invalid-report-%'`,
        [job.id],
      )
    ).rows;
    expect(rejected).toHaveLength(mode === "pending" ? 1 : 3);
    expect(
      new Set(rejected.map((row) => row.value.producer.modelId)).size,
    ).toBe(rejected.length);
    for (const row of rejected) {
      expect(row.result_key).toMatch(/^invalid-report-[a-f0-9]{64}$/);
      expect(row.value.code).toBe("EVIDENCE_REFERENCE_INVALID");
      const canonical = (
        await f.db.query<any>(
          `select value from app_private.model_graph_results
           where thread_id=(select id from app_private.model_graph_threads where job_id=$1)
           and result_key=$2`,
          [job.id, `invalid-${row.value.verification_key}`],
        )
      ).rows[0].value;
      expect(
        rejected.map(({ value }) => {
          const { verification_key: _verificationKey, ...snapshot } = value;
          return snapshot;
        }),
      ).toContainEqual(canonical);
    }
    const requestsBeforeReplay = serial;
    expect(
      (
        await executeGuardedModel({
          backend,
          job: current,
          prefix: `step:${job.id}`,
          task: "draft_section",
          context: {},
          evidence: [],
          requiredIds: [],
          manifest: [],
          environments: envs,
          language: "en",
          repair: false,
          fetcher,
        })
      ).result,
    ).toEqual(candidate);
    expect(serial).toBe(requestsBeforeReplay);
  },
);

it.each([false, true])(
  "repairs a blocking early batch without paying later batches and settles accepted work first (later pending: %s)",
  async (laterPending) => {
    const { executeGuardedModel } =
      await import("../../supabase/functions/_shared/modelGraph");
    const { verificationBatches } =
      await import("../../supabase/functions/_shared/modelVerification");
    const { job, backend, envs } = await configure("openai");
    const candidate = {
      key: "approach",
      title: "Approach",
      content_blocks: Array.from({ length: 6 }, (_, index) => ({
        type: "paragraph",
        text:
          (index === 0 ? "We have 50 certified engineers. " : "") +
          "Proposed scope requires buyer confirmation. ".repeat(45),
      })),
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    const fixed = {
      ...candidate,
      content_blocks: candidate.content_blocks.map((block) => ({
        ...block,
        text: block.text.replace(
          "We have 50 certified engineers.",
          "Proposed staffing requires confirmation.",
        ),
      })),
    };
    let initialHash = "",
      posts = 0,
      gets = 0,
      repairs = 0;
    const oldScopes: string[] = [],
      newScopes: string[] = [];
    let queued: any;
    const response = (id: string, result: any) =>
      Response.json({
        id,
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(result) }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    const fetcher: typeof fetch = async (_url, init) => {
      if (init?.method === "DELETE") return Response.json({ deleted: true });
      if (init?.method === "GET") {
        gets++;
        expect(repairs).toBe(0);
        return response("later-batch-remote", queued);
      }
      posts++;
      const prompt = JSON.parse(
        JSON.parse(String(init?.body)).input.split("\nJSON schema: ")[0],
      );
      if (prompt.task === "draft_section") return response("writer", candidate);
      if (prompt.task === "repair_result") {
        repairs++;
        expect(gets).toBe(laterPending ? 1 : 0);
        expect(prompt.untrusted_data.findings).toEqual([
          expect.objectContaining({
            reason: "missing_supporting_evidence",
            status: "insufficient",
          }),
        ]);
        return response("repair", {
          target_task: "draft_section",
          result: fixed,
          changes: ["Replace unsupported staffing with an explicit question."],
        });
      }
      const c = prompt.untrusted_data;
      initialHash ||= c.candidate_hash;
      const initial = c.candidate_hash === initialHash;
      const global = c.verification_scope === "requirements_only";
      const scopes = initial ? oldScopes : newScopes;
      scopes.push(global ? "global" : c.content_units[0].id);
      const quoted =
        c.content_units.find((u: any) => u.text.includes("engineers")) ??
        c.content_units[0];
      const report = {
        checked_candidate_hash: c.candidate_hash,
        reviewed_all_content: true,
        processed_content_ids: c.content_units.map((u: any) => u.id),
        claims: global
          ? []
          : [
              {
                id: "claim",
                claim: quoted.text,
                candidate_quote: quoted.text,
                kind: initial && !laterPending ? "company_fact" : "assumption",
                status: "supported",
                source_refs: [],
                finding: "Fixture evidence finding.",
              },
            ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [],
      };
      if (initial && laterPending && oldScopes.length === 2) {
        // Model a retained report newly classified as blocking by a guard fix
        // while the next batch already has an accepted remote operation.
        await f.db.query(
          `update app_private.model_graph_results set value=jsonb_set(value,'{result,claims,0,kind}','"company_fact"')
           where result_key=$1 and thread_id=(select id from app_private.model_graph_threads where job_id=$2)`,
          [`verification-v3-${initialHash}-content-0`, job.id],
        );
        queued = report;
        return Response.json({ id: "later-batch-remote", status: "queued" });
      }
      return response(`verification-${posts}`, report);
    };
    const options = {
      backend,
      job,
      prefix: `step:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: envs,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    let current = job,
      outcome;
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        outcome = await executeGuardedModel({ ...options, job: current });
        break;
      } catch (error) {
        if (!(error instanceof ModelDeferred)) throw error;
        await f.db.query(
          "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
          [job.id],
        );
        current = await rpc("claim_backend_job_v2");
        expect(current.id).toBe(job.id);
      }
    }
    expect(outcome?.result).toEqual(fixed);
    expect(repairs).toBe(1);
    expect(gets).toBe(laterPending ? 1 : 0);
    expect(oldScopes).toHaveLength(laterPending ? 2 : 1);
    expect(oldScopes).not.toContain("global");
    expect(newScopes).toHaveLength(verificationBatches(fixed).length + 1);
    expect(newScopes.at(-1)).toBe("global");
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from app_private.model_graph_results where result_key=$1",
          [`verification-${initialHash}`],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from app_private.model_graph_results where result_key like 'verification-repair-only-v3-%'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int count from public.provider_usage where job_id=$1 and state='reserved'",
          [job.id],
        )
      ).rows[0].count,
    ).toBe(0);
  },
);

it("recovers an unstarted false repair, reuses verified batches and completes full coverage without another writer POST", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { ModelGraphStore } =
    await import("../../supabase/functions/_shared/modelGraphStore");
  const { verificationBatches } =
    await import("../../supabase/functions/_shared/modelVerification");
  const { sha256 } = await import("../../supabase/functions/_shared/model");
  const { Annotation, StateGraph, START } =
    await import("@langchain/langgraph");
  const { job, backend, envs } = await configure("openai");
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: Array.from({ length: 8 }, () => ({
      type: "paragraph",
      text: "Proposed delivery needs buyer confirmation. ".repeat(40),
    })),
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  let hash = "";
  let scopes: ReturnType<typeof verificationBatches> = [];
  const reportFor = (units: any[], global = false) => ({
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((u) => u.id),
    claims: global
      ? []
      : [
          {
            id: "uncertainty",
            claim: "Buyer input needed",
            candidate_quote: units[0].text,
            kind: "assumption",
            status: "insufficient",
            source_refs: [],
            finding:
              "Explicit missing input, not a company capability assertion.",
          },
        ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  });
  let writers = 0,
    repairs = 0;
  const checked: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    expect(init?.method).toBe("POST");
    const prompt = JSON.parse(
      JSON.parse(String(init?.body)).input.split("\nJSON schema: ")[0],
    );
    let result: any;
    if (prompt.task === "draft_section") {
      writers++;
      result = candidate;
    } else if (prompt.task === "repair_result") {
      repairs++;
      throw Error("False repair must never be sent");
    } else {
      const c = prompt.untrusted_data;
      const global = c.verification_scope === "requirements_only";
      checked.push(global ? "global" : c.content_units[0].id);
      result = reportFor(c.content_units, global);
    }
    return Response.json({
      id: `fixture-${writers + checked.length}`,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(result) }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 8 },
    });
  };
  const options = {
    backend,
    job,
    prefix: `step:${job.id}`,
    task: "draft_section" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en" as const,
    repair: false,
    fetcher,
  };
  await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  let current = await rpc("claim_backend_job_v2");
  const thread = (
    await f.db.query<any>(
      "select id,candidate_count from app_private.model_graph_threads where job_id=$1",
      [job.id],
    )
  ).rows[0];
  expect(thread.candidate_count).toBe(1);
  const store = new ModelGraphStore(backend, current, thread.id);
  const saved = await store.action("result_get", { key: "candidate-0" });
  hash = await sha256(JSON.stringify(saved.value.result));
  scopes = verificationBatches(saved.value.result);
  const first = reportFor(scopes[0]);
  await store.action("result_put", {
    key: `verification-v3-${hash}-content-0`,
    value: { result: first, producer: null },
  });
  const retained = await store.action("result_put", {
    key: `verification-repair-only-v3-${hash}-content-0`,
    value: { result: first, coverage: "repair_only", producer: null },
  });
  const State = Annotation.Root({
    candidateRef: Annotation<string>(),
    reportRef: Annotation<string>(),
    repairCount: Annotation<number>({
      reducer: (_, next) => next,
      default: () => 0,
    }),
    defectHash: Annotation<string>(),
    decision: Annotation<"accept" | "repair" | "needs_review">(),
  });
  const checkpointGraph = new StateGraph(State)
    .addNode("produce", async () => ({}))
    .addNode("verify", async () => ({}))
    .addNode("decide", async () => ({}))
    .addEdge(START, "produce")
    .addEdge("produce", "verify")
    .addEdge("verify", "decide")
    .addConditionalEdges("decide", () => "produce", ["produce"])
    .compile({ checkpointer: store });
  const config = {
    configurable: { thread_id: thread.id },
    durability: "sync" as const,
  };
  // Recreate only the scheduling checkpoint made by the old semantic guard.
  // The received candidate and completed report remain the original records.
  await checkpointGraph.updateState(
    config,
    {
      candidateRef: saved.id,
      reportRef: retained.id,
      repairCount: 1,
      decision: "repair",
    },
    "decide",
  );
  let outcome;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      outcome = await executeGuardedModel({ ...options, job: current });
      break;
    } catch (error) {
      if (!(error instanceof ModelDeferred)) throw error;
      await f.db.query(
        "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
        [job.id],
      );
      current = await rpc("claim_backend_job_v2");
    }
  }
  expect(outcome?.result).toEqual(candidate);
  expect(writers).toBe(1);
  expect(repairs).toBe(0);
  expect(checked).toHaveLength(scopes.length);
  expect(checked).not.toContain(scopes[0][0].id);
  expect(checked.at(-1)).toBe("global");
  const final = (
    await f.db.query<any>(
      `select candidate_count,
    (select candidates from app_private.model_graph_budgets where thread_id=t.id and unit='writer') writer_count,
    (select count(*)::int from app_private.model_graph_results where thread_id=t.id and result_key like 'repair-schedule-recovery-%') recoveries
    from app_private.model_graph_threads t where id=$1`,
      [thread.id],
    )
  ).rows[0];
  expect(final).toEqual({ candidate_count: 1, writer_count: 1, recoveries: 1 });
  expect(
    (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where id=$1",
        [retained.id],
      )
    ).rows[0].value.result,
  ).toEqual(first);
});

it("cannot accept a partial report accidentally stored as complete verification", async () => {
  const { executeGuardedModel } =
    await import("../../supabase/functions/_shared/modelGraph");
  const { ModelGraphStore } =
    await import("../../supabase/functions/_shared/modelGraphStore");
  const { candidateContent } =
    await import("../../supabase/functions/_shared/modelGrounding");
  const { sha256 } = await import("../../supabase/functions/_shared/model");
  const { job, backend, envs } = await configure();
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: [
      { type: "paragraph", text: "Proposed work requires confirmation." },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  let posts = 0;
  const options = {
    backend,
    job,
    prefix: `step:${job.id}`,
    task: "draft_section" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    environments: envs,
    language: "en" as const,
    repair: false,
    fetcher: (async () => {
      posts++;
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(candidate) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    }) as typeof fetch,
  };
  await expect(executeGuardedModel(options)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  const current = await rpc("claim_backend_job_v2");
  const thread = (
    await f.db.query<any>(
      "select id from app_private.model_graph_threads where job_id=$1",
      [job.id],
    )
  ).rows[0];
  const store = new ModelGraphStore(backend, current, thread.id);
  const stored = (await store.action("result_get", { key: "candidate-0" }))
    .value.result;
  const hash = await sha256(JSON.stringify(stored));
  const units = candidateContent(stored);
  await store.action("result_put", {
    key: `verification-${hash}`,
    value: {
      result: {
        checked_candidate_hash: hash,
        reviewed_all_content: true,
        processed_content_ids: [units[0].id],
        claims: [
          {
            id: "claim",
            claim: units[0].text,
            candidate_quote: units[0].text,
            kind: "assumption",
            status: "supported",
            source_refs: [],
            finding: "Conditional proposal.",
          },
        ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [],
      },
      producer: null,
    },
  });
  await expect(
    executeGuardedModel({ ...options, job: current }),
  ).rejects.toMatchObject({ code: "MODEL_COVERAGE_INCOMPLETE" });
  expect(posts).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
        [thread.id],
      )
    ).rows[0].count,
  ).toBe(0);
});

it("lets legacy workers skip graph work and resumes it with a capable worker after rollback disables admission", async () => {
  const { job, ledger } = await configure();
  await ledger.preflight([], "connection_probe");
  await f.db.query(
    "update public.jobs set status='queued',lease_token=null,lease_until=null where id=$1",
    [job.id],
  );
  await f.command("model.execution.configure", {
    enabled: false,
    expected_revision: 1,
  });
  expect(await rpc("claim_backend_job")).toBeNull();
  expect((await rpc("claim_backend_job_v2")).id).toBe(job.id);
});

it("saves model routes through the same transactional batch RPC used by the browser, with idempotent replay", async () => {
  const { models } = await configure();
  const commands = JSON.stringify([
    {
      operation: "model.task_route.save",
      input: {
        task: "analyze_chunk",
        model_ids: models.map((m) => m.id),
        inherit_default: true,
        strategy: "priority",
        profile: null,
        expected_revision: 0,
      },
    },
  ]);
  const key = crypto.randomUUID();
  await f.db.exec("set local role authenticated");
  try {
    const first = await f.rpc("app_batch", [commands, key]);
    const replay = await f.rpc("app_batch", [commands, key]);
    expect(replay).toEqual(first);
    expect(first[0].model_ids).toEqual(models.map((m) => m.id));
  } finally {
    await f.db.exec("reset role");
  }
});
