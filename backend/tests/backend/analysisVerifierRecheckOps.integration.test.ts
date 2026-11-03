// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

type Fixture = Awaited<ReturnType<typeof createRecheckFixture>>;
function selection(s: Fixture) {
  return {
    version: 1,
    workspace_id: f.w,
    opportunity_id: s.opportunity.id,
    plan_id: s.plan.id,
    proposal_id: s.plan.proposal_id,
    expected_runtime_image:
      "registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:" +
      "e".repeat(64),
    payload: {
      ...s.payload,
      reason:
        "Owner requested fresh verification of the retained settled analysis writer under the corrected source-block verification contract.",
    },
  };
}

/** Only database name, local role and outer transaction framing change. The
 * Python selection validation, canonical command, guards, history SQL and
 * default rollback exception execute exactly as shipped to the ops runner. */
function compiledSql(selected: ReturnType<typeof selection>, activate?: true) {
  const sql = execFileSync(
    "python3",
    [
      "-c",
      `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('tested_compiled_recheck',sys.argv[1])
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
selected=json.load(sys.stdin)
module.r.access.WORKSPACE=selected['workspace_id']
kwargs={'activate':True} if sys.argv[2]=='activate' else {}
sys.stdout.write(module.recovery_sql(selected,**kwargs))`,
      fileURLToPath(
        new URL(
          "../../scripts/ops/proposal-verifier-recheck.py",
          import.meta.url,
        ),
      ),
      activate ? "activate" : "default",
    ],
    { input: JSON.stringify(selected), encoding: "utf8", timeout: 10000 },
  );
  expect(sql).toMatch(/^BEGIN ISOLATION LEVEL SERIALIZABLE;/);
  expect(sql).toMatch(/COMMIT;\s*$/);
  expect(sql).not.toContain("__HISTORY__");
  return sql
    .replace(
      /^BEGIN ISOLATION LEVEL SERIALIZABLE;/,
      "SAVEPOINT compiled_recheck;",
    )
    .replaceAll("SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres")
    .replaceAll(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    )
    .replace(/COMMIT;\s*$/, "RESET ROLE; RELEASE SAVEPOINT compiled_recheck;");
}
async function execute(
  selected: ReturnType<typeof selection>,
  activate?: true,
) {
  const rows = (await f.db.exec(compiledSql(selected, activate))).flatMap(
    (result) => result.rows,
  ) as Array<{ current_setting?: string }>;
  const receipts = rows.filter(
    (row) => typeof row.current_setting === "string",
  );
  expect(receipts).toHaveLength(1);
  return JSON.parse(receipts[0].current_setting!);
}

it("executes default Python check mode against full schema and rolls every business change back", async () => {
  const s = await createRecheckFixture(f);
  const before = await s.snapshot();
  const receipt = await execute(selection(s));
  expect(receipt).toMatchObject({
    status: "checked",
    count: 0,
    plan_id: s.plan.id,
    parent_job_id: s.parent.id,
    verification_revision: 4,
    writer_allowance: 0,
    verifier_allowance: 3,
    verifier_correction_allowance: 1,
  });
  expect(receipt).not.toHaveProperty("child_job_id");
  expect(await s.snapshot()).toEqual(before);
});

it("activates one canonical child, preserves historical data and makes repeated activation idempotent", async () => {
  const s = await createRecheckFixture(f);
  const selected = selection(s);
  const before = await s.snapshot();
  const receipt = await execute(selected, true);
  expect(receipt).toMatchObject({
    status: "started",
    count: 1,
    plan_id: s.plan.id,
    parent_job_id: s.parent.id,
    verification_revision: 4,
    writer_allowance: 0,
    verifier_allowance: 3,
    verifier_correction_allowance: 1,
  });
  expect(receipt.retained_history_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await s.row("public.jobs", receipt.child_job_id)).toMatchObject({
    type: "analyze_chunk",
    status: "queued",
    entity_id: s.plan.id,
    created_by: f.owner,
  });
  expect(
    await s.row("public.generation_steps", receipt.child_step_id),
  ).toMatchObject({
    task: "analyze_chunk",
    status: "queued",
    plan_id: s.plan.id,
    job_id: receipt.child_job_id,
  });
  expect(await s.row("public.jobs", s.parent.id)).toMatchObject({
    status: "canceled",
    cancel_requested: true,
  });
  expect(await s.row("public.generation_steps", s.step.id)).toMatchObject({
    status: "split",
  });
  const after = await s.snapshot();
  const changed = new Set([
    "public.generation_plans",
    "public.generation_steps",
    "public.jobs",
    "public.audit_events",
    "app_private.analysis_verifier_rechecks",
  ]);
  for (const [table, contents] of Object.entries(before))
    if (!changed.has(table)) expect(after[table], table).toEqual(contents);
  for (const table of [
    "public.jobs",
    "public.generation_steps",
    "public.audit_events",
    "app_private.analysis_verifier_rechecks",
  ])
    expect(after[table].length - before[table].length, table).toBe(1);
  for (const activate of [true, undefined] as const) {
    expect(await execute(selected, activate)).toMatchObject({
      status: "already_started",
      count: 0,
      child_job_id: receipt.child_job_id,
      child_step_id: receipt.child_step_id,
    });
    expect(await s.snapshot()).toEqual(after);
  }
});

it("returns a bounded refusal and no changes for stale selected revisions even with explicit activation", async () => {
  const s = await createRecheckFixture(f);
  const selected = selection(s);
  selected.payload.expected_revision += 1;
  const before = await s.snapshot();
  expect(await execute(selected, true)).toEqual({
    status: "refused",
    count: 0,
    stage: "canonical_recheck",
    code: "REVISION_CONFLICT",
  });
  expect(await s.snapshot()).toEqual(before);
});

it("detects silent sibling history corruption inside the canonical call and rolls back the whole activation", async () => {
  const s = await createRecheckFixture(f);
  expect(
    (
      await f.db.query<{ count: number }>(
        "select count(*)::int count from public.generation_steps where plan_id=$1 and status='completed'",
        [s.plan.id],
      )
    ).rows[0].count,
  ).toBe(1);
  await f.db.exec(`
    create function app_private.synthetic_corrupt_completed_sibling() returns trigger language plpgsql as $$
    begin
      update public.generation_steps set output=jsonb_build_object('synthetic_history_mutation',true)
      where plan_id=new.plan_id and status='completed';
      return new;
    end $$;
    create trigger synthetic_corrupt_completed_sibling
    after insert on app_private.analysis_verifier_rechecks
    for each row execute function app_private.synthetic_corrupt_completed_sibling();
  `);
  const before = await s.snapshot();
  expect(await execute(selection(s), true)).toEqual({
    status: "refused",
    count: 0,
    stage: "postconditions",
    code: "PROPOSAL_RECHECK_HISTORY_CHANGED",
  });
  expect(await s.snapshot()).toEqual(before);
});
