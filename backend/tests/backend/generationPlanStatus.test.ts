// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function planRow(id: string) {
  return (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      id,
    ])
  ).rows[0];
}
async function jobRow(id: string) {
  return (await f.db.query<any>("select * from public.jobs where id=$1", [id]))
    .rows[0];
}
async function startWithSiblings() {
  const source = await f.command("source.create", {
    name: "Synthetic plan status source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic independent work",
    description: "Implement an approval workflow.",
    decision: "shortlisted",
    language: "en",
  });
  const text = "Implement an approval workflow with traceable decisions.";
  const upload = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: text.length,
    hash: "a".repeat(64),
  });
  const document = await f.rpc("accept_uploaded_document", [
    upload.id,
    f.owner,
    "a".repeat(64),
    text.length,
    text,
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: document.id,
    expected_revision: document.revision,
  });
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  // Use the real enqueue function and the current frozen task input for a
  // second independent step; no provider or external storage calls are made.
  await f.db.query(
    "select app_private.enqueue_generation(p,s.task,s.input) from public.generation_plans p join public.generation_steps s on s.plan_id=p.id where p.id=$1 order by s.ordinal limit 1",
    [plan.id],
  );
  const blocked = await f.rpc("claim_backend_job");
  await f.rpc("fail_generation", [
    blocked.id,
    blocked.lease_token,
    "MODEL_CORRECTION_EXHAUSTED",
    null,
    null,
  ]);
  expect(await planRow(plan.id)).toMatchObject({
    status: "blocked",
    error_code: "MODEL_CORRECTION_EXHAUSTED",
  });
  const sibling = await f.rpc("claim_backend_job");
  expect(sibling.id).not.toBe(blocked.id);
  expect(sibling.entity_id).toBe(plan.id);
  return { plan, blocked, sibling };
}

it("keeps the blocked child visible when an independent sibling completes", async () => {
  const { plan, blocked, sibling } = await startWithSiblings();
  const before = await jobRow(blocked.id);
  const context = await f.rpc("generation_context", [
    sibling.id,
    sibling.lease_token,
  ]);
  expect(context.plan.status).toBe("blocked");
  await f.rpc("complete_generation_step", [
    sibling.id,
    sibling.lease_token,
    JSON.stringify({ summary: "Synthetic independently completed analysis" }),
  ]);
  expect(await planRow(plan.id)).toMatchObject({
    status: "blocked",
    error_code: "MODEL_CORRECTION_EXHAUSTED",
  });
  expect(await jobRow(blocked.id)).toEqual(before);
  expect(await jobRow(sibling.id)).toMatchObject({
    status: "succeeded",
    lease_token: null,
    lease_until: null,
  });
  expect(
    (
      await f.db.query(
        "select id from public.generation_steps where plan_id=$1 and task='advance_plan'",
        [plan.id],
      )
    ).rows,
  ).toHaveLength(0);
});

it.each(["MODEL_RATE_WAIT", "MODEL_IN_PROGRESS"])(
  "retains the actual blocker when a sibling yields with %s",
  async (code) => {
    const { plan, blocked, sibling } = await startWithSiblings();
    const before = await jobRow(blocked.id);
    if (code === "MODEL_IN_PROGRESS") {
      // A healthy graph continuation releases through graph_store; sending
      // MODEL_IN_PROGRESS to fail_generation would block this child as well.
      await f.db.query(
        "update public.jobs set checkpoint=checkpoint||'{\"model_executor\":2}'::jsonb where id=$1",
        [sibling.id],
      );
      const graph = (action: string, payload = {}) =>
        f.rpc("model_graph_store", [
          sibling.id,
          sibling.lease_token,
          "c".repeat(64),
          action,
          JSON.stringify(payload),
        ]);
      await graph("init", {
        input_hash: "d".repeat(64),
        task: "analyze_chunk",
        graph_version: 1,
      });
      await graph("yield");
    } else
      await f.rpc("fail_generation", [
        sibling.id,
        sibling.lease_token,
        code,
        null,
        null,
      ]);
    expect(await planRow(plan.id)).toMatchObject({
      status: "blocked",
      error_code: "MODEL_CORRECTION_EXHAUSTED",
    });
    expect(await jobRow(blocked.id)).toEqual(before);
    expect(await jobRow(sibling.id)).toMatchObject({
      status: "retry_wait",
      error_code: code,
      lease_token: null,
      lease_until: null,
    });
  },
);

it("keeps a deterministic current-step blocker when two children are blocked", async () => {
  const { plan, sibling } = await startWithSiblings();
  await f.rpc("fail_generation", [
    sibling.id,
    sibling.lease_token,
    "DATA_AUTHORIZATION_REQUIRED",
    null,
    null,
  ]);
  const blockers = (
    await f.db.query<any>(
      "select s.ordinal,j.id,j.error_code,j.status from public.generation_steps s join public.jobs j on j.id=s.job_id where s.plan_id=$1 order by s.ordinal",
      [plan.id],
    )
  ).rows;
  expect(blockers).toHaveLength(2);
  expect(blockers.every((j) => j.status === "blocked")).toBe(true);
  expect(new Set(blockers.map((j) => j.error_code))).toEqual(
    new Set(["MODEL_CORRECTION_EXHAUSTED", "DATA_AUTHORIZATION_REQUIRED"]),
  );
  // Queue tie-breaking is by job UUID, not step ordinal. Either child may
  // have been claimed first; the aggregate error is always the first step's.
  expect(await planRow(plan.id)).toMatchObject({
    status: "blocked",
    error_code: blockers[0].error_code,
  });
  for (const error of blockers.map((j) => j.error_code)) {
    await f.db.query(
      "update public.generation_plans set status='running',error_code=$2 where id=$1",
      [plan.id, error],
    );
    expect(await planRow(plan.id)).toMatchObject({
      status: "blocked",
      error_code: blockers[0].error_code,
    });
  }
});

it("ordinary generation retry clears the blocked aggregate and preserves completed steps and saved work", async () => {
  const { plan, blocked, sibling } = await startWithSiblings();
  await f.rpc("complete_generation_step", [
    sibling.id,
    sibling.lease_token,
    JSON.stringify({ summary: "Synthetic saved sibling" }),
  ]);
  await f.db.query("update public.jobs set checkpoint=$2::jsonb where id=$1", [
    blocked.id,
    JSON.stringify({ graph_thread: "synthetic-saved-graph", repair_count: 2 }),
  ]);
  const before = await jobRow(blocked.id);
  const completed = await jobRow(sibling.id);
  const current = await planRow(plan.id);
  const resumed = await f.command("generation.retry", {
    id: current.id,
    expected_revision: current.revision,
    reason: "Synthetic retry after reviewing the blocker",
  });
  expect(resumed).toMatchObject({ status: "queued", error_code: null });
  const after = await jobRow(blocked.id);
  expect(after).toMatchObject({
    status: "queued",
    error_code: null,
    attempts: before.attempts,
    checkpoint: before.checkpoint,
    input_hash: before.input_hash,
  });
  expect(await jobRow(sibling.id)).toEqual(completed);
  const lease = await f.rpc("claim_backend_job");
  expect(lease.id).toBe(blocked.id);
  expect(lease.attempts).toBe(before.attempts + 1);
  expect(lease.checkpoint).toEqual(before.checkpoint);
});

it("ordinary cancellation remains canceled even with a blocked child", async () => {
  const { plan, blocked, sibling } = await startWithSiblings();
  const current = await planRow(plan.id);
  const canceled = await f.command("generation.cancel", {
    id: plan.id,
    expected_revision: current.revision,
    reason: "Synthetic cancellation",
  });
  expect(canceled.status).toBe("canceled");
  expect(await jobRow(blocked.id)).toMatchObject({
    status: "canceled",
    cancel_requested: true,
  });
  await f.rpc("fail_generation", [
    sibling.id,
    sibling.lease_token,
    "MODEL_IN_PROGRESS",
    null,
    null,
  ]);
  expect((await planRow(plan.id)).status).toBe("canceled");
});

it.each(["completed", "failed"])(
  "does not override the terminal %s status",
  async (status) => {
    const { plan } = await startWithSiblings();
    await f.db.query(
      "update public.generation_plans set status=$2,error_code=null where id=$1",
      [plan.id, status],
    );
    expect(await planRow(plan.id)).toMatchObject({ status, error_code: null });
  },
);

it.each(["old_stage", "completed", "split", "cancel_requested"])(
  "ignores a historical or canceled blocker: %s",
  async (condition) => {
    const { plan, blocked, sibling } = await startWithSiblings();
    if (condition === "old_stage")
      await f.db.query(
        "update public.generation_steps set stage='assessment' where job_id=$1",
        [blocked.id],
      );
    else if (condition === "cancel_requested")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [blocked.id],
      );
    else
      await f.db.query(
        "update public.generation_steps set status=$2 where job_id=$1",
        [blocked.id, condition],
      );
    await f.rpc("complete_generation_step", [
      sibling.id,
      sibling.lease_token,
      JSON.stringify({ summary: "Synthetic completed sibling" }),
    ]);
    expect(await planRow(plan.id)).toMatchObject({
      status: "running",
      error_code: null,
    });
  },
);

it("repairs a previously masked plan once with an audit and no job-state mutations", async () => {
  const { plan, sibling } = await startWithSiblings();
  await f.rpc("complete_generation_step", [
    sibling.id,
    sibling.lease_token,
    JSON.stringify({ summary: "Synthetic saved sibling" }),
  ]);
  // Recreate the previously shipped bug so the migration's repair is tested
  // against actual canonical job/step records rather than handcrafted states.
  await f.db.exec(
    "alter table public.generation_plans disable trigger preserve_generation_plan_blocker",
  );
  await f.db.query(
    "update public.generation_plans set status='running',error_code=null where id=$1",
    [plan.id],
  );
  await f.db.exec(
    "alter table public.generation_plans enable trigger preserve_generation_plan_blocker",
  );
  const before = await planRow(plan.id);
  const jobs = (
    await f.db.query(
      "select * from public.jobs where entity_id=$1 order by id",
      [plan.id],
    )
  ).rows;
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20261021092435_generation_plan_blocked_status.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const repair = migration.match(/do \$repair\$[\s\S]*?end \$repair\$;/)![0];
  await f.db.exec(repair);
  const repaired = await planRow(plan.id);
  expect(repaired).toMatchObject({
    status: "blocked",
    error_code: "MODEL_CORRECTION_EXHAUSTED",
    revision: before.revision + 1,
    input_hash: before.input_hash,
    frozen_context: before.frozen_context,
  });
  await f.db.exec(repair);
  expect(await planRow(plan.id)).toEqual(repaired);
  expect(
    (
      await f.db.query(
        "select * from public.jobs where entity_id=$1 order by id",
        [plan.id],
      )
    ).rows,
  ).toEqual(jobs);
  expect(
    (
      await f.db.query(
        "select action,actor_id,entity_id from public.audit_events where action='generation.status_reconciled'",
      )
    ).rows,
  ).toEqual([
    {
      action: "generation.status_reconciled",
      actor_id: f.owner,
      entity_id: plan.id,
    },
  ]);
});

it("does not expose the private trigger as an executable application operation", async () => {
  expect(
    (
      await f.db.query(
        "select has_function_privilege('anon','app_private.preserve_generation_plan_blocker()','EXECUTE') anon,has_function_privilege('authenticated','app_private.preserve_generation_plan_blocker()','EXECUTE') authenticated,has_function_privilege('service_role','app_private.preserve_generation_plan_blocker()','EXECUTE') service_role",
      )
    ).rows,
  ).toEqual([{ anon: false, authenticated: false, service_role: false }]);
});
