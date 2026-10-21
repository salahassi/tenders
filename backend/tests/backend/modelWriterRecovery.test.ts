// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  recoverBlockedWriter,
  retainInvalidWriter,
} from "../../supabase/functions/_shared/modelWriterRecovery";
import {
  ModelDeferred,
  modelPrompt,
  sha256,
} from "../../supabase/functions/_shared/model";
import { workflowFixture } from "./workflowFixture";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { modelLedger } from "../../supabase/functions/_shared/modelLedger";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";

async function fixture() {
  const evidence = [
    {
      id: "company",
      kind: "company" as const,
      verified: true,
      text: "Our team delivers custom software and integration services.",
    },
  ];
  const candidate = {
    key: "experience",
    title: "Experience",
    content_blocks: [
      {
        type: "paragraph",
        text: "We provide software engineering and system integration.",
      },
    ],
    requirement_ids: ["r1"],
    evidence_refs: [{ id: "company", quote: evidence[0].text }],
    company_claims: [
      {
        claim: "Software and integration capability",
        source_id: "company",
        quote: evidence[0].text,
      },
    ],
    assumptions: [],
    questions: [],
  };
  const context = { key: "experience" };
  const inputHash = await sha256(
    modelPrompt("draft_section", context, evidence, ["r1"], "en", false),
  );
  const config = {
    provider: "openai",
    model: "fixture-model",
    project_ref: "fixture-project",
    connection_id: "fixture-connection",
    model_config_id: "fixture-configuration",
  };
  const usage = {
    id: "usage-paid",
    ...config,
    remote_project_ref: config.project_ref,
    state: "settled",
    graph_candidate_recorded: true,
    input_hash: inputHash,
    execution_metadata: {
      input_hash: inputHash,
      graph_thread: "fixture-thread",
    },
    remote_request_id: "resp_fixture",
  };
  const rows = new Map<string, any>();
  const action = vi.fn(async (name: string, payload?: any): Promise<any> => {
    if (name === "recovery_ready") return true;
    if (name === "writer_recovery_candidates")
      return payload.input_hash === usage.input_hash &&
        payload.request_prefix === "draft:candidate-0"
        ? [usage]
        : [];
    if (name === "writer_recovery_resume") return true;
    if (name === "result_get") return rows.get(payload.key) ?? null;
    if (name === "result_put") {
      const previous = rows.get(payload.key);
      if (
        previous &&
        JSON.stringify(previous.value) !== JSON.stringify(payload.value)
      )
        throw Error("IDEMPOTENCY_CONFLICT");
      const row = previous ?? { id: payload.key, value: payload.value };
      rows.set(payload.key, row);
      return row;
    }
    throw Error(`Forbidden recovery action: ${name}`);
  });
  const response: any = {
    id: usage.remote_request_id,
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(candidate) }],
      },
    ],
    usage: { input_tokens: 110, output_tokens: 90 },
  };
  const fetcher = vi.fn(async (_url: any, init: any) => {
    expect(init.method).toBe("GET");
    return Response.json(response);
  });
  const internal = vi.fn(
    async (_name: string, _args?: Record<string, unknown>) => ({
      providers: [config],
    }),
  );
  const validate = vi.fn();
  const o = {
    backend: {
      internal,
      resolveModelEnvironment: () => ({
        provider: "openai",
        model: config.model,
        projectRef: config.project_ref,
        key: "synthetic-key",
      }),
    },
    store: { action },
    job: { id: "job", lease_token: "lease" },
    threadId: "fixture-thread",
    prefix: "draft",
    task: "draft_section",
    context,
    evidence,
    requiredIds: ["r1"],
    manifest: [],
    language: "en" as const,
    repair: false,
    fetcher: fetcher as typeof fetch,
    state: {
      next: ["produce"],
      values: { repairCount: 0 } as Record<string, any>,
    },
    validate,
  };
  return {
    o,
    usage,
    config,
    candidate,
    rows,
    response,
    action,
    fetcher,
    internal,
    validate,
    inputHash,
  };
}

it("recovers an already-paid paraphrase via exact GET and only reopens normal independent verification", async () => {
  const f = await fixture();
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(String(f.fetcher.mock.calls[0][0])).toBe(
    "https://api.openai.com/v1/responses/resp_fixture",
  );
  expect(f.validate).toHaveBeenCalledWith(f.candidate, {
    independentGrounding: true,
  });
  expect(f.rows.get("candidate-0").value).toMatchObject({
    result: f.candidate,
    recovery_usage_id: f.usage.id,
  });
  expect(f.rows.get(`writer-recovery-${f.usage.id}`).value).toMatchObject({
    independent_verification_required: true,
    received_candidate_budgets_unchanged: true,
    new_generation_requests: 0,
  });
  expect(f.action.mock.calls.map(([name]) => name)).not.toEqual(
    expect.arrayContaining([
      "candidate_received",
      "candidate_budget",
      "accept",
      "delete",
    ]),
  );
  expect(f.internal.mock.calls).toHaveLength(1);
  expect(f.internal.mock.calls[0][0]).toBe("task_model_preflight");
  // Crash/replay after artifact/cache persistence does not retrieve or regenerate.
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("matches the paid initial request after the legacy step sets repair=true", async () => {
  const f = await fixture();
  f.o.repair = true;
  const currentHash = await sha256(
    modelPrompt("draft_section", f.o.context, f.o.evidence, ["r1"], "en", true),
  );
  expect(currentHash).not.toBe(f.inputHash);
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(
    f.action.mock.calls
      .filter(([name]) => name === "writer_recovery_candidates")
      .map(([, payload]) => payload.input_hash),
  ).toEqual([currentHash, f.inputHash]);
  expect(f.rows.get(`writer-recovery-${f.usage.id}`).value).toMatchObject({
    request_input_hash: f.inputHash,
    received_candidate_budgets_unchanged: true,
    new_generation_requests: 0,
    independent_verification_required: true,
  });
  expect(f.o.repair).toBe(true);
  expect(f.o.state.values.repairCount).toBe(0);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("still matches a paid initial candidate whose original request already included repair guidance", async () => {
  const f = await fixture();
  f.o.repair = true;
  f.usage.input_hash = await sha256(
    modelPrompt("draft_section", f.o.context, f.o.evidence, ["r1"], "en", true),
  );
  f.usage.execution_metadata.input_hash = f.usage.input_hash;
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(
    f.rows.get(`writer-recovery-${f.usage.id}`).value.request_input_hash,
  ).toBe(f.usage.input_hash);
});

it.each(["context", "evidence", "required IDs"])(
  "never uses the original repair=false hash after changing %s",
  async (change) => {
    const f = await fixture();
    f.o.repair = true;
    if (change === "context") f.o.context.key = "changed-section";
    if (change === "evidence") f.o.evidence[0].text += " Changed evidence.";
    if (change === "required IDs") f.o.requiredIds = ["other-requirement"];
    expect(await recoverBlockedWriter(f.o)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
    expect(
      f.action.mock.calls.some(([name]) => name === "writer_recovery_resume"),
    ).toBe(false);
  },
);

it.each([
  "wrong-task",
  "wrong-node",
  "repair",
  "candidate-ref",
  "pending",
  "no-paid-result",
  "wrong-input",
  "uncounted",
  "unsettled",
  "wrong-config",
  "wrong-metadata",
  "wrong-graph",
  "remote-mismatch",
  "remote-incomplete",
  "remote-refused",
  "remote-error",
  "missing-source",
  "wrong-source",
  "unverified-source",
  "coverage",
  "domain-validation",
  "cache-conflict",
])("fails closed: %s", async (kind) => {
  const f = await fixture();
  const implementation = f.action.getMockImplementation()!;
  if (kind === "wrong-task") f.o.task = "analyze_chunk";
  if (kind === "wrong-node") f.o.state.next = ["verify"];
  if (kind === "repair") f.o.state.values.repairCount = 1;
  if (kind === "candidate-ref") f.o.state.values.candidateRef = "other";
  if (kind === "pending")
    f.action.mockImplementation((name, payload) =>
      name === "recovery_ready"
        ? Promise.resolve(false)
        : implementation(name, payload),
    );
  if (kind === "no-paid-result")
    f.action.mockImplementation((name, payload) =>
      name === "writer_recovery_candidates"
        ? Promise.resolve([])
        : implementation(name, payload),
    );
  if (kind === "wrong-input") f.usage.input_hash = "x";
  if (kind === "wrong-metadata") f.usage.execution_metadata.input_hash = "x";
  if (kind === "wrong-graph") f.usage.execution_metadata.graph_thread = "other";
  if (kind === "uncounted") f.usage.graph_candidate_recorded = false;
  if (kind === "unsettled") f.usage.state = "unknown";
  if (kind === "wrong-config") f.usage.model_config_id = "other";
  if (kind === "remote-mismatch") f.response.id = "resp_other";
  if (kind === "remote-incomplete") f.response.status = "in_progress";
  if (kind === "remote-refused")
    f.response.output[0].content = [{ type: "refusal", refusal: "no" }];
  if (kind === "remote-error")
    f.fetcher.mockImplementation(async () =>
      Response.json({}, { status: 500 }),
    );
  if (kind === "missing-source")
    f.candidate.company_claims[0].source_id = "missing";
  if (kind === "wrong-source")
    f.candidate.company_claims[0].quote = "Invented certification";
  if (kind === "unverified-source") {
    f.o.evidence[0].verified = false;
    f.usage.input_hash = await sha256(
      modelPrompt(
        "draft_section",
        f.o.context,
        f.o.evidence,
        ["r1"],
        "en",
        false,
      ),
    );
    f.usage.execution_metadata.input_hash = f.usage.input_hash;
  }
  if (kind === "coverage") f.candidate.requirement_ids = [];
  if (kind === "domain-validation")
    f.validate.mockImplementation(() => {
      throw Error("invalid business context");
    });
  if (kind === "cache-conflict")
    f.rows.set("candidate-0", {
      id: "other",
      value: { result: f.candidate, recovery_usage_id: "other" },
    });
  if (["missing-source", "wrong-source", "coverage"].includes(kind))
    f.response.output[0].content[0].text = JSON.stringify(f.candidate);
  expect(await recoverBlockedWriter(f.o)).toBe(false);
  expect(
    f.action.mock.calls.some(([name]) => name === "writer_recovery_resume"),
  ).toBe(false);
  expect(f.action.mock.calls.some(([name]) => name === "accept")).toBe(false);
});

it("retains all distinct counted writer candidates without replacing an earlier paid result", async () => {
  const f = await fixture();
  for (const id of ["one", "two", "three", "one"])
    await retainInvalidWriter(f.o.store, {
      usage_id: id,
      request_prefix: "draft:candidate-0",
      request_input_hash: f.inputHash,
      task: "draft_section",
      result: f.candidate,
      code: "UNSUPPORTED_COMPANY_CLAIM",
      producer: f.config,
    });
  expect(f.rows.size).toBe(3);
});

describe("paid initial writer recovery through the real graph and SQL store", () => {
  let db: Awaited<ReturnType<typeof workflowFixture>>;
  beforeAll(async () => {
    db = await workflowFixture();
  }, 30000);
  afterAll(async () => db?.db.close());

  it("keeps the legacy repair flag and exhausted writer budget while verifying and accepting the paid original", async () => {
    await db.db.exec("begin");
    const rpc = async (name: string, args: Record<string, unknown> = {}) => {
      const entries = Object.entries(args);
      await db.db.exec("savepoint recovery_rpc;set local role service_role");
      try {
        return (
          await db.db.query<any>(
            `select public.${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(",")}) value`,
            entries.map(([, value]) =>
              value && typeof value === "object"
                ? JSON.stringify(value)
                : value,
            ),
          )
        ).rows[0]?.value;
      } catch (error) {
        await db.db.exec("rollback to savepoint recovery_rpc");
        throw databaseError(error as Error);
      } finally {
        await db.db.exec("reset role;release savepoint recovery_rpc");
      }
    };
    try {
      await db.command("model.routing", {
        enabled: true,
        expected_revision: 0,
      });
      const connection = await db.command("model.connection.save", {
        provider: "openai",
        label: "Synthetic recovery account",
        credential_alias: "APP_MODEL_OPENAI_KEY",
        project_ref: "fixture-project",
        enabled: true,
        expected_revision: 0,
      });
      const model = await db.command("model.configuration.save", {
        connection_id: connection.id,
        label: "Synthetic recovery model",
        model: "fixture-model",
        enabled: true,
        capabilities: defaultCapabilities("openai"),
        expected_revision: 0,
      });
      await db.command("model.task_route.save", {
        task: "default",
        model_ids: [model.id],
        inherit_default: false,
        strategy: "priority",
        profile: null,
        expected_revision: 0,
      });
      await db.command("model.execution.configure", {
        enabled: true,
        expected_revision: 0,
      });
      await db.command("model.probe", {});
      let job = await rpc("claim_backend_job_v2");
      const environments = modelEnvironments((name) =>
        name === "APP_MODEL_OPENAI_KEY" ? "synthetic-key" : undefined,
      );
      const backend = {
        internal: rpc,
        resolveModelEnvironment: (config: any) => ({
          ...environments.openai,
          model: config.model,
          projectRef: config.project_ref,
        }),
      } as unknown as Backend;
      const prefix = `step:${job.id}`;
      await modelLedger(backend, job, prefix, environments).preflight(
        [],
        "draft_section",
      );
      job = (
        await db.db.query<any>("select * from public.jobs where id=$1", [
          job.id,
        ])
      ).rows[0];
      const candidate = {
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
      const originalHash = await sha256(
        modelPrompt("draft_section", {}, [], [], "en", false),
      );
      const graphInputHash = await sha256(
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
      const threadId = await sha256(`${job.id}:${prefix}:${graphInputHash}`);
      let store = new ModelGraphStore(backend, job, threadId);
      await store.action("init", {
        input_hash: graphInputHash,
        task: "draft_section",
        graph_version: 1,
      });
      await db.db.query(
        "update app_private.model_graph_threads set candidate_count=3 where id=$1",
        [threadId],
      );
      await db.db.query(
        "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',3)",
        [threadId],
      );
      let gets = 0,
        verifierPosts = 0;
      const response = (id: string, result: unknown) =>
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
            input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        });
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (init?.method === "DELETE") return Response.json({ deleted: true });
        if (init?.method === "GET") {
          gets++;
          return response(String(url).split("/").pop()!, candidate);
        }
        const prompt = JSON.parse(
          JSON.parse(String(init?.body)).input.split("\nJSON schema: ")[0],
        );
        expect(prompt.task).toBe("verify_grounding");
        verifierPosts++;
        const context = prompt.untrusted_data;
        return response(`resp_verifier_${verifierPosts}`, {
          checked_candidate_hash: context.candidate_hash,
          reviewed_all_content: true,
          processed_content_ids: context.content_units.map(
            (unit: any) => unit.id,
          ),
          claims:
            context.verification_scope === "requirements_only"
              ? []
              : [
                  {
                    id: "claim",
                    claim: "Conditional proposal",
                    candidate_quote: context.content_units[0].text,
                    kind: "assumption",
                    status: "supported",
                    source_refs: [],
                    finding: "Proposed work.",
                  },
                ],
          processed_requirement_ids: [],
          requirement_checks: [],
          findings: [],
        });
      });
      const options = {
        backend,
        job,
        prefix,
        task: "draft_section" as const,
        context: {},
        evidence: [],
        requiredIds: [],
        manifest: [],
        environments,
        language: "en" as const,
        repair: true,
        fetcher,
      };
      // Save the real initial-produce checkpoint. The exhausted allowance must
      // prevent any request while the already-paid original is not yet present.
      await expect(executeGuardedModel(options)).rejects.toMatchObject({
        code: "MODEL_CORRECTION_EXHAUSTED",
      });
      expect(fetcher).not.toHaveBeenCalled();
      const paidIds: string[] = [];
      for (let index = 0; index < 3; index++) {
        const id = crypto.randomUUID();
        const originalLease = crypto.randomUUID();
        paidIds.push(id);
        await db.db.query(
          `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,state,graph_candidate_recorded,connection_id,model_config_id,remote_project_ref,remote_request_id,remote_deadline,created_by)
           values($1,$2,$3,$4,$5,'openai','fixture-model',$6,current_date,1,100,50,100,50,0,'settled',true,$7,$8,'fixture-project',$9,now()+interval '1 hour',$10)`,
          [
            id,
            db.w,
            job.id,
            originalLease,
            `${prefix}:candidate-0:${originalHash.slice(0, 16)}:${index + 1}:${model.id}`,
            originalHash,
            connection.id,
            model.id,
            `resp_paid_${index}`,
            db.owner,
          ],
        );
        await db.db.query(
          `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,usage_id,sent,execution_metadata)
           values($1,$2,$3,'openai','fixture-model','draft_section',1,1,'failed','UNSUPPORTED_COMPANY_CLAIM',$4,true,$5)`,
          [
            db.w,
            job.id,
            originalLease,
            id,
            { input_hash: originalHash, graph_thread: threadId },
          ],
        );
      }
      const paidBefore = (
        await db.db.query<any>(
          "select * from public.provider_usage where id=any($1::uuid[]) order by id",
          [paidIds],
        )
      ).rows;
      let accepted: any;
      for (let attempt = 0; attempt < 6 && !accepted; attempt++) {
        try {
          accepted = await executeGuardedModel({ ...options, job });
        } catch (error) {
          expect(error).toBeInstanceOf(ModelDeferred);
          job = await rpc("claim_backend_job_v2");
          expect(job.id).toBe(options.job.id);
          store = new ModelGraphStore(backend, job, threadId);
        }
      }
      expect(accepted?.result).toEqual(candidate);
      expect(gets).toBe(1);
      expect(verifierPosts).toBe(1);
      expect(options.repair).toBe(true);
      expect(
        (
          await db.db.query<any>(
            "select status,candidate_count from app_private.model_graph_threads where id=$1",
            [threadId],
          )
        ).rows[0],
      ).toEqual({ status: "accepted", candidate_count: 3 });
      expect(
        (
          await db.db.query<any>(
            "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
            [threadId],
          )
        ).rows[0].candidates,
      ).toBe(3);
      expect(
        (
          await db.db.query<any>(
            "select * from public.provider_usage where id=any($1::uuid[]) order by id",
            [paidIds],
          )
        ).rows,
      ).toEqual(paidBefore);
      expect(
        (await store.action("result_get", { key: "candidate-0" })).value.result,
      ).toEqual(candidate);
    } finally {
      await db.db.exec("rollback");
    }
  }, 30000);
});
