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

it.each(["corrected", "unchanged", "evolving"])(
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
              status: corrected ? "supported" : "insufficient",
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
    ).toBe(mode === "evolving" ? 3 : 2);
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
