import { expect, it, vi } from "vitest";
// @ts-expect-error Release utility is intentionally plain Node.js.
import { applyModelRelease } from "../../scripts/backend/apply-model-release.mjs";

const names = [
  "model_catalog_and_task_routes",
  "model_target_identity_and_execution",
  "durable_model_graph",
  "model_graph_recovery_and_retention",
  "automatic_model_transport",
];
function fixture(history: any[], fail = false) {
  const queries: any[] = [];
  const log = vi.fn();
  const fetcher = vi.fn(async (_url, input) => {
    queries.push(JSON.parse(input.body));
    if (queries.length === 1) return Response.json(history);
    if (fail) return new Response("", { status: 503 });
    return Response.json([]);
  });
  return { queries, log, fetcher, token: "isolated-fixture" };
}
it("applies only the five reviewed migrations with transactional history", async () => {
  const f = fixture([]);
  await applyModelRelease(f);
  expect(f.queries).toHaveLength(6);
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
  expect(f.queries).toHaveLength(4);
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
  const f = fixture([], true);
  await expect(applyModelRelease(f)).rejects.toThrow("HTTP 503");
  expect(f.queries).toHaveLength(2);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(f.token);
});
