// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { workflowFixture } from "./workflowFixture";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { retainInvalidVerification } from "../../supabase/functions/_shared/modelGraph";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint graph_rpc;set local role service_role");
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
    await f.db.exec("rollback to savepoint graph_rpc");
    throw error;
  } finally {
    await f.db.exec("reset role;release savepoint graph_rpc");
  }
}
async function setup(budget_version = 1) {
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  await f.command("model.probe", {});
  const job = await rpc("claim_backend_job_v2");
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||'{\"model_executor\":2}'::jsonb where id=$1",
    [job.id],
  );
  const store = new ModelGraphStore({ internal: rpc }, job, "a".repeat(64));
  await store.action("init", {
    input_hash: "b".repeat(64),
    task: "connection_probe",
    graph_version: 1,
    budget_version,
  });
  const config = {
    configurable: { thread_id: store.thread },
    durability: "sync" as const,
  };
  return { job, store, config };
}
it("persists LangGraph state and pending writes and resumes under a new lease without repeating an accepted side effect", async () => {
  const { job, store, config } = await setup();
  const State = Annotation.Root({
    resultRef: Annotation<string>(),
    completed: Annotation<boolean>(),
  });
  let submissions = 0;
  const compile = (saver: ModelGraphStore) =>
    new StateGraph(State)
      .addNode("submit", async () => {
        const existing = await saver.action("result_get", {
          key: "provider-candidate",
        });
        if (existing) return { resultRef: existing.id };
        submissions++;
        const saved = await saver.action("result_put", {
          key: "provider-candidate",
          value: { status: "ready" },
        });
        return { resultRef: saved.id };
      })
      .addNode("validate", async (state) => {
        expect(
          (await saver.action("result_get", { id: state.resultRef })).value,
        ).toEqual({ status: "ready" });
        return { completed: true };
      })
      .addEdge(START, "submit")
      .addEdge("submit", "validate")
      .addEdge("validate", END)
      .compile({ checkpointer: saver, interruptAfter: ["submit"] });
  await compile(store).invoke({}, config);
  const persisted = await store.getTuple(config);
  expect(persisted?.checkpoint.channel_values.resultRef).toBeTruthy();
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_writes",
      )
    ).rows[0].count,
  ).toBeGreaterThan(0);
  await store.action("yield");
  const resumed = await rpc("claim_backend_job_v2");
  expect(resumed.id).toBe(job.id);
  const newProcess = new ModelGraphStore(
    { internal: rpc },
    resumed,
    store.thread,
  );
  expect((await compile(newProcess).invoke(null, config)).completed).toBe(true);
  expect(submissions).toBe(1);
  await expect(store.action("put", { checkpoint_id: "stale" })).rejects.toThrow(
    "STALE_LEASE",
  );
});
it("replays cached candidate data after a crash before the node checkpoint is committed", async () => {
  const { store, config } = await setup();
  const State = Annotation.Root({ resultRef: Annotation<string>() });
  let sends = 0,
    crash = true;
  const compile = () =>
    new StateGraph(State)
      .addNode("invoke", async () => {
        let result = await store.action("result_get", { key: "candidate-0" });
        if (!result) {
          sends++;
          result = await store.action("result_put", {
            key: "candidate-0",
            value: { status: "ready" },
          });
          if (crash) {
            crash = false;
            throw new Error("Fixture process exit after result save");
          }
        }
        return { resultRef: result.id };
      })
      .addEdge(START, "invoke")
      .addEdge("invoke", END)
      .compile({ checkpointer: store });
  await expect(compile().invoke({}, config)).rejects.toThrow(
    "Fixture process exit",
  );
  expect((await compile().invoke(null, config)).resultRef).toBeTruthy();
  expect(sends).toBe(1);
});
it("preserves pending-write order and upstream replay semantics, plus list filtering and thread isolation", async () => {
  const { store, config } = await setup();
  const checkpoint = emptyCheckpoint();
  const saved = await store.put(
    config,
    checkpoint,
    { source: "loop", step: 1, parents: {} },
    {},
  );
  await store.putWrites(saved, [["value", "first"]], "task-one", "b");
  await store.putWrites(
    saved,
    [["value", "must-not-overwrite"]],
    "task-one",
    "b",
  );
  await store.putWrites(saved, [["value", "second"]], "task-two", "a");
  expect((await store.getTuple(saved))?.pendingWrites).toEqual([
    ["task-two", "value", "second"],
    ["task-one", "value", "first"],
  ]);
  const matches = [];
  for await (const tuple of store.list(config, {
    filter: { step: 1 },
    limit: 1,
  }))
    matches.push(tuple);
  expect(matches).toHaveLength(1);
  const other = { configurable: { thread_id: "c".repeat(64) } };
  await expect(store.getTuple(other)).rejects.toThrow("GRAPH_THREAD_MISMATCH");
  await expect(store.deleteThread("c".repeat(64))).rejects.toThrow(
    "GRAPH_THREAD_MISMATCH",
  );
  await store.deleteThread(store.thread);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int count from app_private.model_graph_writes",
      )
    ).rows[0].count,
  ).toBe(0);
});
it("does not commit an unaccepted graph result or expose checkpoint tables through browser roles", async () => {
  const { job, store } = await setup();
  await expect(
    rpc("complete_generation_graph", {
      job_id: job.id,
      lease: job.lease_token,
      thread_id: store.thread,
      result: { status: "ready" },
    }),
  ).rejects.toThrow("GRAPH_RESULT_NOT_ACCEPTED");
  const permissions = (
    await f.db.query<any>(`select relname,relrowsecurity,
    has_table_privilege('authenticated',oid,'select') browser_read,
    has_table_privilege('anon',oid,'select') anon_read
    from pg_class where relnamespace='app_private'::regnamespace and relname like 'model_graph_%' and relkind='r'`)
  ).rows;
  expect(permissions).toHaveLength(5);
  for (const p of permissions)
    expect(p).toMatchObject({
      relrowsecurity: true,
      browser_read: false,
      anon_read: false,
    });
});
it("retains distinct verifier rejections by producer and code without replacing the first corrective input on replay", async () => {
  const { store } = await setup();
  const key = `verification-${"d".repeat(64)}`;
  const report = {
    claims: [
      { id: "fixture-claim", candidate_quote: "Synthetic rejected text" },
    ],
  };
  const first = { provider: "gemini_free", modelId: "fixture-a" };
  const second = { provider: "openai", modelId: "fixture-b" };
  await retainInvalidVerification(
    store,
    key,
    report,
    "EVIDENCE_REFERENCE_INVALID",
    first,
  );
  const canonical = await store.action("result_get", { key: `invalid-${key}` });
  await retainInvalidVerification(
    store,
    key,
    report,
    "EVIDENCE_REFERENCE_INVALID",
    second,
  );
  await retainInvalidVerification(
    store,
    key,
    report,
    "MODEL_COVERAGE_INCOMPLETE",
    second,
  );
  // Replaying either provider's same rejection must not create another record.
  await retainInvalidVerification(
    store,
    key,
    report,
    "EVIDENCE_REFERENCE_INVALID",
    first,
  );
  await retainInvalidVerification(
    store,
    key,
    report,
    "EVIDENCE_REFERENCE_INVALID",
    second,
  );
  const archived = (
    await f.db.query<any>(
      "select result_key,value from app_private.model_graph_results where thread_id=$1 and result_key like 'invalid-report-%' order by created_at,id",
      [store.thread],
    )
  ).rows;
  expect(archived).toHaveLength(3);
  for (const row of archived) {
    expect(row.result_key).toMatch(/^invalid-report-[a-f0-9]{64}$/);
    expect(row.value).toMatchObject({ verification_key: key, result: report });
  }
  expect(
    archived.map((row) => [row.value.producer.modelId, row.value.code]),
  ).toEqual(
    expect.arrayContaining([
      ["fixture-a", "EVIDENCE_REFERENCE_INVALID"],
      ["fixture-b", "EVIDENCE_REFERENCE_INVALID"],
      ["fixture-b", "MODEL_COVERAGE_INCOMPLETE"],
    ]),
  );
  expect(await store.action("result_get", { key: `invalid-${key}` })).toEqual(
    canonical,
  );
  expect(canonical.value).toEqual({
    result: report,
    code: "EVIDENCE_REFERENCE_INVALID",
    producer: first,
  });
});

async function blockedPaidWriter() {
  const { job, store } = await setup();
  const usage = crypto.randomUUID();
  const input = "d".repeat(64);
  const prefix = "draft:candidate-0";
  await f.db.query(
    "update app_private.model_graph_threads set task='draft_section',candidate_count=3 where id=$1",
    [store.thread],
  );
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',3)",
    [store.thread],
  );
  await f.db.query(
    `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,graph_candidate_recorded,execution_metadata,created_by)
    values($1,$2,$3,$4,$5,'openai','fixture-model',$6,current_date,1,100,100,'settled',true,$7,$8)`,
    [
      usage,
      f.w,
      job.id,
      job.lease_token,
      `${prefix}:${input.slice(0, 16)}:1:${crypto.randomUUID()}`,
      input,
      { input_hash: input, graph_thread: store.thread },
      f.owner,
    ],
  );
  await f.db.query(
    `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,usage_id)
    values($1,$2,$3,'openai','fixture-model','draft_section',1,1,'failed','UNSUPPORTED_COMPANY_CLAIM',$4)`,
    [f.w, job.id, job.lease_token, usage],
  );
  await store.action("needs_review");
  return { job, store, usage, input, prefix };
}

it("reserves correction capacity independently after three generation receipts, with idempotency and an aggregate ceiling", async () => {
  const { job, store } = await setup(2);
  const receive = async (unit: string) => {
    await store.action("candidate_budget", { unit });
    const id = crypto.randomUUID();
    await f.db.query(
      `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
      values($1::uuid,$2,$3,$4,$1::text,'openai','synthetic-model',$5,current_date,1,100,40000,'settled',$6)`,
      [id, f.w, job.id, job.lease_token, "d".repeat(64), f.owner],
    );
    const result = await store.action("candidate_received", {
      unit,
      usage_id: id,
    });
    expect(
      await store.action("candidate_received", { unit, usage_id: id }),
    ).toEqual(result);
    return id;
  };
  for (let i = 0; i < 3; i++) await receive("writer");
  await expect(
    store.action("candidate_budget", { unit: "writer" }),
  ).rejects.toThrow("MODEL_GENERATION_ATTEMPTS_EXHAUSTED");
  expect(
    (await store.action("candidate_budget", { unit: "writer-repair" })).count,
  ).toBe(0);
  await receive("writer-repair");
  await receive("writer-repair");
  await expect(
    store.action("candidate_budget", { unit: "writer-repair" }),
  ).rejects.toThrow("MODEL_OPERATION_BUDGET_EXHAUSTED");
  expect(
    (
      await f.db.query<any>(
        "select candidate_count from app_private.model_graph_threads where id=$1",
        [store.thread],
      )
    ).rows[0].candidate_count,
  ).toBe(3);
});

it("never upgrades a previously created graph budget when a new worker resumes it", async () => {
  const { store } = await setup(1);
  const row = await store.action("init", {
    input_hash: "b".repeat(64),
    task: "connection_probe",
    graph_version: 1,
    budget_version: 2,
  });
  expect(row.budget_version).toBe(1);
});

it("reopens only an exact counted paid writer candidate without changing allowance or accepting its content", async () => {
  const { store, usage, input, prefix } = await blockedPaidWriter();
  const identity = { input_hash: input, request_prefix: prefix };
  const candidates = await store.action("writer_recovery_candidates", identity);
  expect(candidates.map((u: any) => u.id)).toEqual([usage]);
  await f.db.query(
    "update public.provider_usage set execution_metadata=null where id=$1",
    [usage],
  );
  await f.db.query(
    "update public.model_attempts set sent=true,execution_metadata=$2 where usage_id=$1",
    [
      usage,
      {
        input_hash: input,
        graph_thread: store.thread,
        prompt_version: "fixture-pinned-prompt",
      },
    ],
  );
  expect(
    (await store.action("writer_recovery_candidates", identity))[0]
      .execution_metadata,
  ).toEqual({
    input_hash: input,
    graph_thread: store.thread,
    prompt_version: "fixture-pinned-prompt",
  });
  expect(
    await store.action("writer_recovery_candidates", {
      ...identity,
      input_hash: "e".repeat(64),
    }),
  ).toEqual([]);
  const result = {
    content_blocks: [{ type: "paragraph", text: "Synthetic writer fixture" }],
  };
  const retained = await store.action("result_put", {
    key: `invalid-writer-${usage}`,
    value: {
      usage_id: usage,
      task: "draft_section",
      request_input_hash: input,
      request_prefix: prefix,
      result,
      code: "UNSUPPORTED_COMPANY_CLAIM",
    },
  });
  const candidate = await store.action("result_put", {
    key: "candidate-0",
    value: { result, recovery_usage_id: usage },
  });
  const markerKey = `writer-recovery-${usage}`;
  const payload = {
    ...identity,
    usage_id: usage,
    candidate_id: candidate.id,
    marker_key: markerKey,
  };
  expect(await store.action("writer_recovery_resume", payload)).toBe(false);
  await store.action("result_put", {
    key: markerKey,
    value: {
      candidate_ref: candidate.id,
      usage_id: usage,
      request_input_hash: input,
      request_prefix: prefix,
      retained_ref: retained.id,
      independent_verification_required: true,
      new_generation_requests: 0,
      received_candidate_budgets_unchanged: true,
    },
  });
  expect(await store.action("writer_recovery_resume", payload)).toBe(true);
  const thread = (
    await f.db.query<any>(
      "select status,candidate_count,result_id from app_private.model_graph_threads where id=$1",
      [store.thread],
    )
  ).rows[0];
  expect(thread).toEqual({
    status: "running",
    candidate_count: 3,
    result_id: null,
  });
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
        [store.thread],
      )
    ).rows[0].candidates,
  ).toBe(3);
  expect(
    (
      await f.db.query<any>(
        "select state,graph_candidate_recorded from public.provider_usage where id=$1",
        [usage],
      )
    ).rows[0],
  ).toEqual({ state: "settled", graph_candidate_recorded: true });
  expect(await store.action("result_get", { key: "accepted" })).toBeNull();
});

it("does not authorize writer recovery for unresolved usage, other phases, uncounted results or wrong rejection", async () => {
  const { store, usage, input, prefix } = await blockedPaidWriter();
  const payload = { input_hash: input, request_prefix: prefix };
  await f.db.query(
    "update public.provider_usage set execution_metadata=$2 where id=$1",
    [usage, { input_hash: input, graph_thread: "f".repeat(64) }],
  );
  expect(await store.action("writer_recovery_candidates", payload)).toEqual([]);
  await f.db.query(
    "update public.provider_usage set execution_metadata=$2 where id=$1",
    [usage, { input_hash: input, graph_thread: store.thread }],
  );
  expect(
    await store.action("writer_recovery_candidates", {
      ...payload,
      request_prefix: "other:candidate-0",
    }),
  ).toEqual([]);
  for (const update of ["state='unknown'", "graph_candidate_recorded=false"]) {
    await f.db.query(`update public.provider_usage set ${update} where id=$1`, [
      usage,
    ]);
    expect(await store.action("writer_recovery_candidates", payload)).toEqual(
      [],
    );
    await f.db.query(
      "update public.provider_usage set state='settled',graph_candidate_recorded=true where id=$1",
      [usage],
    );
  }
  await f.db.query(
    "update public.model_attempts set result_code='MODEL_OUTPUT_TRUNCATED' where usage_id=$1",
    [usage],
  );
  expect(await store.action("writer_recovery_candidates", payload)).toEqual([]);
});
