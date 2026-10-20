// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { workflowFixture } from "./workflowFixture";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";

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
async function setup() {
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
