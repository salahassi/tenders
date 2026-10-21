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
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import {
  FreeModelProvider,
  ModelDeferred,
  sha256,
} from "../../supabase/functions/_shared/model";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
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
  vi.restoreAllMocks();
  await f.db.exec("rollback");
});

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint writer_handoff_rpc;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) value`,
        entries.map(([, value]) =>
          value && typeof value === "object" ? JSON.stringify(value) : value,
        ),
      )
    ).rows[0]?.value;
  } catch (error) {
    await f.db.exec("rollback to savepoint writer_handoff_rpc");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role;release savepoint writer_handoff_rpc");
  }
}

async function configure(
  task: "draft_section" | "repair_result",
  alternate = false,
) {
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await f.command("model.connection.save", {
    provider: "openai",
    label: "Synthetic validation account",
    credential_alias: "APP_MODEL_OPENAI_KEY",
    project_ref: "fixture-project",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic validation model",
    model: "fixture-model",
    enabled: true,
    capabilities: { ...defaultCapabilities("openai"), background: false },
    expected_revision: 0,
  });
  const second = alternate
    ? await f.command("model.configuration.save", {
        connection_id: connection.id,
        label: "Synthetic alternate model",
        model: "fixture-model-b",
        enabled: true,
        capabilities: { ...defaultCapabilities("openai"), background: false },
        expected_revision: 0,
      })
    : undefined;
  await f.command("model.task_route.save", {
    task: "default",
    model_ids: [model.id, ...(second ? [second.id] : [])],
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
  });
  await f.command("model.probe", {});
  const job = await rpc("claim_backend_job_v2");
  await rpc("prepare_task_model_route", {
    job_id: job.id,
    lease: job.lease_token,
    task_name: task,
    default_profile: taskRegistry[task].profile,
  });
  return { job, connection, model };
}

async function setup(
  attemptStatus: "failed" | "running" | "waiting" = "failed",
  candidateKey = "candidate-0",
) {
  const task =
    candidateKey === "candidate-0" ? "draft_section" : "repair_result";
  const { job, connection, model } = await configure(task);
  const thread = await sha256("synthetic writer validation " + job.id);
  const store = new ModelGraphStore({ internal: rpc }, job, thread);
  await store.action("init", {
    input_hash: await sha256("synthetic original graph input"),
    task: "draft_section",
    graph_version: 1,
  });
  const input = await sha256("synthetic pinned writer request " + candidateKey);
  const prefix = `draft:${job.id}:${candidateKey}`;
  const code = "EVIDENCE_REFERENCE_INVALID";
  const metadata = {
    input_hash: input,
    graph_thread: thread,
    prompt_version: `${task}.v1.tenderdesk-semantic-fidelity-v1`,
  };
  const producer = {
    provider: "openai",
    model: "fixture-model",
    project: "fixture-project",
    connectionId: connection.id,
    modelId: model.id,
  };
  const candidate = {
    key: "approach",
    title: "Approach",
    content_blocks: [{ type: "paragraph", text: "Synthetic proposed work." }],
    requirement_ids: [],
    evidence_refs: [{ id: "notice", quote: "Synthetic unmatched quotation." }],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  const result =
    candidateKey === "candidate-0" ? candidate : { result: candidate };
  const usage = (
    await f.db.query<any>(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
       application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,
       state,graph_candidate_recorded,connection_id,model_config_id,execution_metadata,created_by)
       values($1,$2,$3,$4,'openai','fixture-model',$5,current_date,1,100,50,80,40,5,
       'settled',true,$6,$7,$8,$9) returning *`,
      [
        f.w,
        job.id,
        job.lease_token,
        `${prefix}:${input.slice(0, 16)}:1:${model.id}`,
        input,
        connection.id,
        model.id,
        metadata,
        f.owner,
      ],
    )
  ).rows[0];
  const attempt = (
    await f.db.query<any>(
      `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,
       round_number,worker_attempt,status,result_code,usage_id,sent,execution_metadata,connection_id,model_config_id,
       finished_at,http_status,request_id,response_id,reported_model,finish_reason,request_phase,
       provider_error_code,provider_error_type,provider_error_reason)
       values($1,$2,$3,'openai','fixture-model','fixture-project',$4,1,1,$5,$6,$7,true,$8,$9,$10,
       case when $5='failed' then now()-interval '1 second' else null end,200,'fixture-request','fixture-response',
       'fixture-reported-model','stop','poll','fixture-provider-code','fixture-provider-type',$11) returning *`,
      [
        f.w,
        job.id,
        job.lease_token,
        task,
        attemptStatus,
        attemptStatus === "failed"
          ? code
          : attemptStatus === "waiting"
            ? "MODEL_IN_PROGRESS"
            : null,
        attemptStatus === "running" ? null : usage.id,
        metadata,
        connection.id,
        model.id,
        attemptStatus === "failed" ? "response_evidence_invalid" : null,
      ],
    )
  ).rows[0];
  const count = Number(candidateKey.at(-1)) + 1;
  await f.db.query(
    "update app_private.model_graph_threads set candidate_count=$2 where id=$1",
    [thread, count],
  );
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',$2),($1,'existing-verifier',2)",
    [thread, count],
  );
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_round',jsonb_build_object('input_hash',$2::text,'remaining','[]'::jsonb,'output_error',$3::text)) where id=$1",
    [job.id, input, code],
  );
  const retained = await store.action("result_put", {
    key: `invalid-writer-${usage.id}`,
    value: {
      usage_id: usage.id,
      request_prefix: prefix,
      request_input_hash: input,
      task,
      result,
      code,
      producer,
    },
  });
  const saved = await store.action("result_put", {
    key: candidateKey,
    value: {
      result,
      producer,
      local_validation: {
        version: 1,
        task,
        code,
        diagnostics: [
          {
            code,
            reason: "source_quote_mismatch",
            paths: ["$.evidence_refs[0].quote"],
            evidence_ids: ["notice"],
          },
        ],
        usage_id: usage.id,
        attempt_id: String(attempt.id),
        request_prefix: prefix,
        request_input_hash: input,
      },
    },
  });
  const payload = {
    candidate_id: saved.id,
    candidate_key: candidateKey,
    manifest: [],
  };
  return {
    job,
    store,
    thread,
    input,
    prefix,
    code,
    candidateKey,
    task,
    usage,
    attempt,
    saved,
    retained,
    payload,
  };
}

async function snapshot(s: Awaited<ReturnType<typeof setup>>) {
  return {
    usage: (
      await f.db.query(
        "select * from public.provider_usage where job_id=$1 order by id",
        [s.job.id],
      )
    ).rows,
    budgets: (
      await f.db.query(
        "select * from app_private.model_graph_budgets where thread_id=$1 order by unit",
        [s.thread],
      )
    ).rows,
    thread: (
      await f.db.query(
        "select status,candidate_count,result_id from app_private.model_graph_threads where id=$1",
        [s.thread],
      )
    ).rows[0],
  };
}

it.each(["candidate-0", "candidate-1", "candidate-2"])(
  "hands off exactly %s without resetting budgets, paying again, or accepting content",
  async (key) => {
    const s = await setup("failed", key);
    const before = await snapshot(s);
    const checkpoint = (
      await f.db.query<any>("select checkpoint from public.jobs where id=$1", [
        s.job.id,
      ])
    ).rows[0].checkpoint;
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      true,
    );
    expect(await snapshot(s)).toEqual(before);
    const after = (
      await f.db.query<any>("select * from public.model_attempts where id=$1", [
        s.attempt.id,
      ])
    ).rows[0];
    expect(after).toEqual(s.attempt);
    const { model_round: _completedRound, ...rest } = checkpoint;
    expect(
      (
        await f.db.query<any>(
          "select checkpoint from public.jobs where id=$1",
          [s.job.id],
        )
      ).rows[0].checkpoint,
    ).toEqual(rest);
    expect(await s.store.action("result_get", { key: "accepted" })).toBeNull();
    expect(await s.store.action("result_get", { id: s.retained.id })).toEqual(
      s.retained,
    );
    expect(await s.store.action("result_get", { id: s.saved.id })).toEqual(
      s.saved,
    );
    const marker = await s.store.action("result_get", {
      key: `writer-validation-handoff-${s.usage.id}`,
    });
    expect(marker.value).toMatchObject({
      candidate_id: s.saved.id,
      usage_id: s.usage.id,
      attempt_id: s.attempt.id,
      request_input_hash: s.input,
      code: s.code,
      received_candidate_budgets_unchanged: true,
    });
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      true,
    );
    expect(await snapshot(s)).toEqual(before);
    expect(await s.store.action("result_get", { id: marker.id })).toEqual(
      marker,
    );
  },
);

it.each(["running", "waiting"] as const)(
  "finishes a crash-retained %s attempt using the same usage and original telemetry",
  async (status) => {
    const s = await setup(status);
    const before = await snapshot(s);
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      true,
    );
    const after = (
      await f.db.query<any>("select * from public.model_attempts where id=$1", [
        s.attempt.id,
      ])
    ).rows[0];
    expect(after).toEqual({
      ...s.attempt,
      status: "failed",
      result_code: s.code,
      usage_id: s.usage.id,
      finished_at: after.finished_at,
      provider_error_reason: "response_evidence_invalid",
    });
    expect(after.finished_at).toBeTruthy();
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      true,
    );
    expect(
      (
        await f.db.query<any>(
          "select * from public.model_attempts where id=$1",
          [s.attempt.id],
        )
      ).rows[0],
    ).toEqual(after);
    expect(await snapshot(s)).toEqual(before);
  },
);

it.each([false, true])(
  "runs the real graph from invalid writer through a changed repair prompt and independent verification, crash=%s",
  async (crash) => {
    const configured = await configure("draft_section", true);
    let job = configured.job;
    const environments = modelEnvironments((name) =>
      name === "APP_MODEL_OPENAI_KEY" ? "synthetic-key" : undefined,
    );
    let crashed = false;
    const backend = {
      internal: async (name: string, args: any) => {
        if (
          crash &&
          !crashed &&
          name === "model_graph_store" &&
          args.action === "writer_validation_handoff"
        ) {
          crashed = true;
          throw new Error("Synthetic process exit before durable handoff");
        }
        return rpc(name, args);
      },
      resolveModelEnvironment: (config: any) => ({
        ...environments.openai,
        model: config.model,
        projectRef: config.project_ref,
      }),
    } as unknown as Backend;
    const corrected = {
      key: "approach",
      title: "Approach",
      content_blocks: [
        {
          type: "paragraph",
          text: "Proposed work requires buyer confirmation.",
        },
      ],
      requirement_ids: [],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    const invalid = {
      ...corrected,
      evidence_refs: [
        { id: "notice", quote: "Synthetic unmatched quotation." },
      ],
    };
    const requests: { task: string; prompt: any; input: string }[] = [];
    vi.spyOn(FreeModelProvider.prototype, "generate").mockImplementation(
      async function (this: FreeModelProvider, task, prompt) {
        this.generationSent = true;
        this.telemetry = {
          http_status: 200,
          request_id: `synthetic-request-${requests.length}`,
          response_id: `synthetic-response-${requests.length}`,
          reported_model: "fixture-model",
          finish_reason: "stop",
          request_phase: "generate",
        };
        const parsed = JSON.parse(prompt);
        requests.push({ task, prompt: parsed, input: prompt });
        const context = parsed.untrusted_data;
        let result: unknown;
        if (task === "draft_section") result = invalid;
        else if (task === "repair_result") {
          expect(context.candidate).toEqual(invalid);
          expect(context.validation_diagnostics).toEqual([
            {
              code: "EVIDENCE_REFERENCE_INVALID",
              reason: "source_quote_mismatch",
              paths: ["$.evidence_refs[0].quote"],
              evidence_ids: ["notice"],
            },
          ]);
          expect(context.findings).toMatchObject([
            { code: "UNRESOLVED_VALIDATION" },
          ]);
          expect(context.validation_instruction).toContain(
            "untrusted verifier hints",
          );
          result = {
            target_task: "draft_section",
            result: corrected,
            changes: ["Removed an unsupported quotation."],
          };
        } else {
          expect(task).toBe("verify_grounding");
          result = {
            checked_candidate_hash: context.candidate_hash,
            reviewed_all_content: true,
            processed_content_ids: context.content_units.map(
              (unit: any) => unit.id,
            ),
            claims: [
              {
                id: "claim",
                claim: "Conditional proposal",
                candidate_quote: corrected.content_blocks[0].text,
                kind: "assumption",
                status: "supported",
                source_refs: [],
                finding: "Proposed work remains conditional.",
              },
            ],
            processed_requirement_ids: [],
            requirement_checks: [],
            findings: [],
          };
        }
        return {
          text: JSON.stringify(result),
          usage: { input: 80, output: 40, thinking: 5 },
          complete: true,
        };
      },
    );
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected external request in synthetic fixture");
    });
    const options = {
      backend,
      job,
      prefix: `step:${job.id}`,
      task: "draft_section" as const,
      context: {},
      evidence: [
        {
          id: "notice",
          kind: "notice" as const,
          verified: false,
          text: "Synthetic source text.",
        },
      ],
      requiredIds: [],
      manifest: [],
      environments,
      language: "en" as const,
      repair: false,
      fetcher,
    };
    let accepted: Awaited<ReturnType<typeof executeGuardedModel>> | undefined;
    for (let iteration = 0; iteration < 8 && !accepted; iteration++) {
      try {
        accepted = await executeGuardedModel({ ...options, job });
      } catch (error) {
        if (
          (error as Error).message ===
          "Synthetic process exit before durable handoff"
        )
          continue;
        expect(error).toBeInstanceOf(ModelDeferred);
        job = await rpc("claim_backend_job_v2");
        expect(job.id).toBe(options.job.id);
      }
    }
    expect(accepted?.result).toEqual(corrected);
    expect(crashed).toBe(crash);
    expect(requests.map((request) => request.task)).toEqual([
      "draft_section",
      "repair_result",
      "verify_grounding",
    ]);
    expect(requests[1].input).not.toBe(requests[0].input);
    expect(fetcher).not.toHaveBeenCalled();
    const store = new ModelGraphStore(backend, job, accepted!.threadId!);
    const original = await store.action("result_get", { key: "candidate-0" });
    expect(original.value.result).toEqual(invalid);
    expect(
      (await store.action("result_get", { key: "candidate-1" })).value.result
        .result,
    ).toEqual(corrected);
    expect(
      (await store.action("result_get", { key: "accepted" })).value,
    ).toEqual(corrected);
    const usage = (
      await f.db.query<any>(
        "select * from public.provider_usage where job_id=$1 order by created_at,id",
        [job.id],
      )
    ).rows;
    expect(usage).toHaveLength(3);
    expect(
      usage.every(
        (row) => row.state === "settled" && row.graph_candidate_recorded,
      ),
    ).toBe(true);
    const originalUsage = usage.find(
      (row) => row.id === original.value.local_validation.usage_id,
    );
    expect(originalUsage).toMatchObject({
      actual_input: 80,
      actual_output: 40,
      thinking_tokens: 5,
    });
    const failed = (
      await f.db.query<any>("select * from public.model_attempts where id=$1", [
        original.value.local_validation.attempt_id,
      ])
    ).rows[0];
    expect(failed).toMatchObject({
      status: "failed",
      result_code: "EVIDENCE_REFERENCE_INVALID",
      usage_id: originalUsage.id,
      sent: true,
      request_id: "synthetic-request-0",
      response_id: "synthetic-response-0",
      provider_error_reason: "response_evidence_invalid",
    });
    expect(
      (
        await f.db.query<any>(
          "select status,candidate_count from app_private.model_graph_threads where id=$1",
          [accepted!.threadId],
        )
      ).rows[0],
    ).toEqual({ status: "accepted", candidate_count: 2 });
    expect(
      (
        await f.db.query<any>(
          "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
          [accepted!.threadId],
        )
      ).rows[0].candidates,
    ).toBe(2);
  },
  30000,
);

it.each([
  "wrong-candidate",
  "wrong-key",
  "wrong-result",
  "wrong-producer",
  "wrong-attempt-operation",
  "wrong-attempt-thread",
  "wrong-attempt-hash",
  "wrong-attempt-lease",
  "legacy-prompt",
  "wrong-usage-thread",
  "wrong-usage-prompt",
  "wrong-call-prefix",
  "wrong-usage-hash",
  "usage-not-counted",
  "usage-reserved",
  "usage-unknown",
  "attempt-succeeded",
  "different-failure",
  "different-round",
  "empty-diagnostics",
  "unknown-code",
  "missing-retained",
  "pending-reserved",
  "pending-unknown",
])(
  "rejects %s without changing the request, telemetry, or allowance",
  async (reason) => {
    const s = await setup();
    if (reason === "wrong-candidate")
      s.payload.candidate_id = crypto.randomUUID();
    if (reason === "wrong-key") s.payload.candidate_key = "candidate-1";
    const candidatePatch =
      reason === "wrong-result"
        ? { result: { synthetic: "different candidate" } }
        : reason === "wrong-producer"
          ? { producer: null }
          : reason === "empty-diagnostics"
            ? {
                local_validation: {
                  ...s.saved.value.local_validation,
                  diagnostics: [],
                },
              }
            : reason === "unknown-code"
              ? {
                  local_validation: {
                    ...s.saved.value.local_validation,
                    code: "DATA_POLICY_BLOCKED",
                  },
                }
              : null;
    if (candidatePatch)
      await f.db.query(
        "update app_private.model_graph_results set value=value||$2::jsonb where id=$1",
        [s.saved.id, candidatePatch],
      );
    if (reason === "wrong-attempt-operation")
      await f.db.query(
        "update public.model_attempts set operation='verify_grounding' where id=$1",
        [s.attempt.id],
      );
    if (
      reason === "wrong-attempt-thread" ||
      reason === "wrong-attempt-hash" ||
      reason === "legacy-prompt"
    )
      await f.db.query(
        "update public.model_attempts set execution_metadata=jsonb_set(execution_metadata,$2::text[],$3::jsonb) where id=$1",
        [
          s.attempt.id,
          [
            reason === "wrong-attempt-thread"
              ? "graph_thread"
              : reason === "wrong-attempt-hash"
                ? "input_hash"
                : "prompt_version",
          ],
          JSON.stringify(
            reason === "legacy-prompt" ? "draft_section.v1" : "f".repeat(64),
          ),
        ],
      );
    if (reason === "wrong-attempt-lease")
      await f.db.query(
        "update public.model_attempts set lease_token=$2 where id=$1",
        [s.attempt.id, crypto.randomUUID()],
      );
    if (reason === "wrong-usage-thread" || reason === "wrong-usage-prompt")
      await f.db.query(
        "update public.provider_usage set execution_metadata=jsonb_set(execution_metadata,$2::text[],$3::jsonb) where id=$1",
        [
          s.usage.id,
          [reason === "wrong-usage-thread" ? "graph_thread" : "prompt_version"],
          JSON.stringify("f".repeat(64)),
        ],
      );
    if (reason === "wrong-call-prefix")
      await f.db.query(
        "update public.provider_usage set call_key='different-phase:synthetic' where id=$1",
        [s.usage.id],
      );
    if (reason === "wrong-usage-hash")
      await f.db.query(
        "update public.provider_usage set input_hash=$2 where id=$1",
        [s.usage.id, "f".repeat(64)],
      );
    if (reason === "usage-not-counted")
      await f.db.query(
        "update public.provider_usage set graph_candidate_recorded=false where id=$1",
        [s.usage.id],
      );
    if (reason === "usage-reserved" || reason === "usage-unknown")
      await f.db.query(
        "update public.provider_usage set state=$2 where id=$1",
        [s.usage.id, reason.slice(6)],
      );
    if (reason === "attempt-succeeded")
      await f.db.query(
        "update public.model_attempts set status='succeeded',result_code='SUCCEEDED' where id=$1",
        [s.attempt.id],
      );
    if (reason === "different-failure")
      await f.db.query(
        "update public.model_attempts set result_code='MODEL_COVERAGE_INCOMPLETE' where id=$1",
        [s.attempt.id],
      );
    if (reason === "different-round")
      await f.db.query(
        "update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_round,input_hash}',$2::jsonb) where id=$1",
        [s.job.id, JSON.stringify("f".repeat(64))],
      );
    if (reason === "missing-retained")
      await f.db.query(
        "delete from app_private.model_graph_results where id=$1",
        [s.retained.id],
      );
    if (reason === "pending-reserved" || reason === "pending-unknown")
      await f.db.query(
        `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
       application_day,settings_revision,reserved_input,reserved_output,state,created_by)
       values($1,$2,$3,$4,'openai','fixture-model',$5,current_date,1,100,50,$6,$7)`,
        [
          f.w,
          s.job.id,
          s.job.lease_token,
          `${s.prefix}:synthetic-pending`,
          s.input,
          reason.slice(8),
          f.owner,
        ],
      );
    const before = await snapshot(s);
    const attempts = (
      await f.db.query("select * from public.model_attempts where job_id=$1", [
        s.job.id,
      ])
    ).rows;
    const checkpoint = (
      await f.db.query("select checkpoint from public.jobs where id=$1", [
        s.job.id,
      ])
    ).rows;
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      false,
    );
    expect(await snapshot(s)).toEqual(before);
    expect(
      (
        await f.db.query(
          "select * from public.model_attempts where job_id=$1",
          [s.job.id],
        )
      ).rows,
    ).toEqual(attempts);
    expect(
      (
        await f.db.query("select checkpoint from public.jobs where id=$1", [
          s.job.id,
        ])
      ).rows,
    ).toEqual(checkpoint);
    expect(
      await s.store.action("result_get", {
        key: `writer-validation-handoff-${s.usage.id}`,
      }),
    ).toBeNull();
  },
);

it("does not expose the private handoff directly to clients or the service role", async () => {
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','app_private.writer_validation_handoff(uuid,uuid,text,jsonb)','execute') auth,has_function_privilege('service_role','app_private.writer_validation_handoff(uuid,uuid,text,jsonb)','execute') service",
      )
    ).rows[0],
  ).toEqual({ auth: false, service: false });
});

it.each(["reserved", "unknown", "revoked-permission"])(
  "rechecks %s after an idempotent handoff marker already exists",
  async (reason) => {
    const s = await setup();
    let authorization: any;
    if (reason === "revoked-permission") {
      const item = await f.command("knowledge.save", {
        title: "Synthetic proposal evidence",
        content: "Builds approval software.",
        category: "company",
        enabled: true,
        evidence: "Synthetic fixture only",
      });
      const ref = (await f.rpc("eligibility_candidates")).items.find(
        (itemRef: any) => itemRef.entity_id === item.id,
      );
      const manifest = {
        entity_kind: ref.entity_kind,
        entity_id: ref.entity_id,
        content_hash: ref.content_hash,
      };
      (s.payload.manifest as any[]).push(manifest);
      authorization = await f.command("content.authorize", {
        ...manifest,
        provider: "openai",
        attestation: "nonconfidential_nonpersonal",
      });
      await f.db.query(
        "update public.jobs set type='draft_section' where id=$1",
        [s.job.id],
      );
    }
    expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
      true,
    );
    const marker = await s.store.action("result_get", {
      key: `writer-validation-handoff-${s.usage.id}`,
    });
    if (authorization)
      await f.command("content.revoke", {
        id: authorization.id,
        expected_revision: authorization.revision,
      });
    else
      await f.db.query(
        `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
        application_day,settings_revision,reserved_input,reserved_output,state,created_by)
        values($1,$2,$3,$4,'openai','fixture-model',$5,current_date,1,100,50,$6,$7)`,
        [
          f.w,
          s.job.id,
          s.job.lease_token,
          `${s.prefix}:synthetic-pending-replay`,
          s.input,
          reason,
          f.owner,
        ],
      );
    const before = await snapshot(s);
    if (authorization)
      await expect(
        s.store.action("writer_validation_handoff", s.payload),
      ).rejects.toThrow("data authorization required");
    else
      expect(await s.store.action("writer_validation_handoff", s.payload)).toBe(
        false,
      );
    expect(await snapshot(s)).toEqual(before);
    expect(await s.store.action("result_get", { id: marker.id })).toEqual(
      marker,
    );
  },
);

it.each(["cancelled", "stale-lease", "missing-evidence"])(
  "still applies current server guards for %s",
  async (reason) => {
    const s = await setup();
    if (reason === "cancelled")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [s.job.id],
      );
    if (reason === "stale-lease") s.job.lease_token = crypto.randomUUID();
    if (reason === "missing-evidence")
      (s.payload.manifest as any[]).push({
        entity_kind: "document",
        entity_id: crypto.randomUUID(),
        content_hash: "a".repeat(64),
      });
    const before = await snapshot(s);
    await expect(
      s.store.action("writer_validation_handoff", s.payload),
    ).rejects.toThrow();
    expect(await snapshot(s)).toEqual(before);
  },
);
