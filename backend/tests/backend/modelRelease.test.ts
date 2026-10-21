import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
// @ts-expect-error Release utility is intentionally plain Node.js.
import { applyModelRelease } from "../../scripts/backend/apply-model-release.mjs";

const names = [
  "model_catalog_and_task_routes",
  "model_target_identity_and_execution",
  "durable_model_graph",
  "model_graph_recovery_and_retention",
  "automatic_model_transport",
  "scope_model_resume_to_phase",
  "reconcile_orphaned_model_reservations",
  "scope_unknown_task_reservations_to_phase",
  "healthy_model_poll_eligibility",
  "model_continuation_queue_fairness",
  "complete_draft_export_context",
  "immutable_model_phase_prompt_pin",
  "bounded_queue_wakeup",
  "retained_verification_recovery_guard",
  "generation_plan_blocked_status",
];
const versions = [
  "20261020141244",
  "20261020141542",
  "20261020143042",
  "20261020150037",
  "20261020195225",
  "20261021002125",
  "20261021003448",
  "20261021005033",
  "20261021010317",
  "20261021071021",
  "20261021071753",
  "20261021073417",
  "20261021085510",
  "20261021091037",
  "20261021092435",
];
function fixture(history: any[], failMutation?: number) {
  const queries: any[] = [];
  const log = vi.fn();
  const fetcher = vi.fn(async (_url, input) => {
    queries.push(JSON.parse(input.body));
    if (queries.length === 1) return Response.json(history);
    if (queries.length - 1 === failMutation)
      return new Response("", { status: 503 });
    return Response.json([]);
  });
  return { queries, log, fetcher, token: "isolated-fixture" };
}
it("applies only the reviewed migrations in chronological transactions with atomic history", async () => {
  const f = fixture([]);
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(names.length + 1);
  expect(f.queries[0].read_only).toBe(true);
  expect(
    f.queries
      .slice(1)
      .every(
        (q) =>
          q.query.startsWith("begin;") &&
          q.query.endsWith("commit;") &&
          q.query.includes("insert into supabase_migrations.schema_migrations"),
      ),
  ).toBe(true);
  expect(versions).toEqual([...versions].sort());
  f.queries.slice(1).forEach((q, index) => {
    expect(q.read_only).toBe(false);
    expect(q.query).toContain(
      ` values('${versions[index]}','${names[index]}',array[`,
    );
    expect(q.query).toContain("set local lock_timeout='10s';");
    expect(q.query.match(/^begin;$/gm)).toHaveLength(1);
    expect(q.query.match(/^commit;$/gm)).toHaveLength(1);
    // Every patch has its own transaction and only its own history row, so an
    // error cannot commit a patch without recording it or roll back prior ones.
    expect(
      q.query.match(/insert into supabase_migrations\.schema_migrations/g),
    ).toHaveLength(1);
  });
});
it("skips already-applied migrations regardless of connector-assigned timestamp", async () => {
  const f = fixture(
    names.map((name) => ({ name, version: "connector-version" })),
  );
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(1);
});
it("resumes after graph storage without recreating its tables", async () => {
  const f = fixture(
    [...names.slice(0, 2), "durable_model_graph_storage"].map((name) => ({
      name,
    })),
  );
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(names.length - 1);
  const executable = f.queries[1].query.split(
    "insert into supabase_migrations.schema_migrations",
  )[0];
  expect(executable).toContain("create function public.model_graph_store(");
  expect(executable).not.toContain(
    "create table app_private.model_graph_threads",
  );
});
it("resumes after the graph store RPC without creating it again", async () => {
  const f = fixture(
    [
      ...names.slice(0, 2),
      "durable_model_graph_storage",
      "durable_model_graph_store_rpc",
    ].map((name) => ({ name })),
  );
  await applyModelRelease(f);
  const executable = f.queries[1].query.split(
    "insert into supabase_migrations.schema_migrations",
  )[0];
  expect(executable).toContain(
    "create function public.complete_generation_graph(",
  );
  expect(executable).not.toContain("create function public.model_graph_store(");
});
it("fails closed on a history collision", async () => {
  const f = fixture([{ name: "unrelated", version: "20261020141244" }]);
  await expect(applyModelRelease(f)).rejects.toThrow("version collision");
  expect(f.queries).toHaveLength(1);
});
it("does not replay the fully completed three-part connector migration", async () => {
  const f = fixture(
    [
      ...names.filter((name) => name !== "durable_model_graph"),
      "durable_model_graph_storage",
      "durable_model_graph_store_rpc",
      "durable_model_graph_domain_commits",
    ].map((name) => ({ name, version: "connector-version" })),
  );
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(1);
});
it("rejects out-of-order partial graph history before issuing DDL", async () => {
  const f = fixture(
    [...names.slice(0, 2), "durable_model_graph_domain_commits"].map(
      (name) => ({ name }),
    ),
  );
  await expect(applyModelRelease(f)).rejects.toThrow(
    "Incomplete graph migration history",
  );
  expect(f.queries).toHaveLength(1);
});
it("stops on an unknown mutation outcome without replaying or leaking credentials", async () => {
  const f = fixture([], 1);
  await expect(applyModelRelease(f)).rejects.toThrow("HTTP 503");
  expect(f.queries).toHaveLength(2);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(f.token);
});

it("adds only the recovery and draft export patches to an existing October 20 release", async () => {
  const f = fixture(
    names.slice(0, 5).map((name) => ({ name, version: "connector-version" })),
  );
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(names.length - 4);
  expect(f.log.mock.calls.slice(5).map(([message]) => message)).toEqual(
    names.slice(5).map((name) => `Applied: ${name}`),
  );
  expect(f.queries[1].query).toContain(
    "create function public.resume_task_model_request_phase(",
  );
  expect(f.queries[4].query).toContain(
    "create function public.defer_pending_model_request(",
  );
  expect(f.queries[5].query).toContain("pending.remote_request_id is not null");
  expect(f.queries[6].query).toContain("'commercial_draft',v.commercial_draft");
});

it("stops at a failed recovery transaction and resumes from confirmed history without replaying prior patches", async () => {
  const first = fixture(
    names.slice(0, 5).map((name) => ({ name })),
    3,
  );
  await expect(applyModelRelease(first)).rejects.toThrow("HTTP 503");
  expect(first.queries).toHaveLength(4);
  expect(first.log.mock.calls.map(([message]) => message)).not.toContain(
    `Applied: ${names[7]}`,
  );
  expect(first.queries[3].query).toContain(names[7]);
  expect(
    first.queries.some((q) =>
      q.query.includes("create function public.defer_pending_model_request("),
    ),
  ).toBe(false);

  // The server history is authoritative on a fresh invocation. It confirms the
  // first two patches; only the failed transaction and remaining patches run.
  const resumed = fixture(names.slice(0, 7).map((name) => ({ name })));
  await applyModelRelease(resumed);
  expect(resumed.queries).toHaveLength(names.length - 6);
  expect(resumed.queries[1].query).toContain(`'${names[7]}'`);
  expect(resumed.queries[2].query).toContain(`'${names[8]}'`);
  expect(resumed.queries[3].query).toContain(`'${names[9]}'`);
  expect(resumed.queries[4].query).toContain(`'${names[10]}'`);
  expect(resumed.queries[5].query).toContain(`'${names[11]}'`);
  expect(
    resumed.queries
      .slice(1)
      .some((q) =>
        q.query.includes(
          "create function public.resume_task_model_request_phase(",
        ),
      ),
  ).toBe(false);
});

it("does not replay an ambiguous recovery call that the server history confirms committed", async () => {
  const interrupted = fixture(
    names.slice(0, 7).map((name) => ({ name })),
    1,
  );
  await expect(applyModelRelease(interrupted)).rejects.toThrow("HTTP 503");
  expect(interrupted.queries).toHaveLength(2);
  const resumed = fixture(
    names.slice(0, 8).map((name) => ({ name, version: "connector-version" })),
  );
  await applyModelRelease(resumed);
  expect(resumed.queries).toHaveLength(names.length - 7);
  expect(resumed.queries[1].query).toContain(`'${names[8]}'`);
  expect(resumed.queries[2].query).toContain(`'${names[9]}'`);
  expect(resumed.queries[3].query).toContain(`'${names[10]}'`);
  expect(resumed.queries[4].query).toContain(`'${names[11]}'`);
});

it("rejects a recovery version collision before reading or submitting that migration", async () => {
  const f = fixture([
    ...names.slice(0, 5).map((name) => ({ name })),
    { version: versions[5], name: "unrelated" },
  ]);
  const readMigration = vi.fn();
  await expect(applyModelRelease({ ...f, readMigration })).rejects.toThrow(
    `Migration version collision: ${versions[5]}`,
  );
  expect(readMigration).not.toHaveBeenCalled();
  expect(f.queries).toHaveLength(1);
});

it("requires both recovery RPC signatures before the workflow can deploy new worker code", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/deploy-api.yml", import.meta.url),
    "utf8",
  );
  const gate = workflow.slice(
    workflow.indexOf("- name: Verify compatible database migrations"),
    workflow.indexOf("- name: Deploy canonical API and worker files"),
  );
  expect(gate).toContain(
    "to_regprocedure('public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)') is not null",
  );
  expect(gate).toContain(
    "to_regprocedure('public.defer_pending_model_request(uuid,uuid,uuid)') is not null",
  );
  expect(gate).toContain('rows[0].get("compatible") is not True');
  expect(gate).toContain("raise SystemExit");
  expect(
    workflow.indexOf("- name: Apply reviewed model release migrations"),
  ).toBeLessThan(
    workflow.indexOf("- name: Verify compatible database migrations"),
  );
});
