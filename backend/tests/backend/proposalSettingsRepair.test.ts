// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { workflowFixture } from "./workflowFixture";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => { f = await workflowFixture(); }, 30000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.db.exec("begin"); });
afterEach(async () => { await f.db.exec("rollback"); });

async function setup() {
  const connection = await f.command("model.connection.save", { provider: "openai", label: "Synthetic repair account",
    credential_alias: "APP_MODEL_OPENAI_KEY", project_ref: "synthetic-repair", enabled: true, expected_revision: 0 });
  const models = [];
  for (const model of ["gpt-6.1-sol", "gpt-6-luna"]) models.push(await f.command("model.configuration.save", {
    connection_id: connection.id, label: model, model, enabled: true,
    capabilities: defaultCapabilities("openai"), expected_revision: 0 }));
  const defaults = await f.command("model.task_route.save", { task: "default", model_ids: models.map(m => m.id),
    inherit_default: false, strategy: "round_robin", profile: null, expected_revision: 0 });
  const route = await f.command("model.task_route.save", { task: "verify_grounding", model_ids: [models[1].id],
    inherit_default: true, strategy: "priority", profile: null, expected_revision: 0 });
  const settings = await f.command("model.execution.configure", { enabled: true, max_parallel_requests: 2, expected_revision: 0 });
  // Generate the actual operational queries/body from the Python helper. The
  // synthetic proof is a test input; authority is exercised again by SQL.
  const generated = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,sys
from pathlib import Path
p=Path('scripts/ops/test_proposal_settings_repair.py')
s=importlib.util.spec_from_file_location('fixture',p);t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
x=json.load(sys.stdin);m=t.m;m.request.auth.access.WORKSPACE=x['workspace'];v=t.fixture()
v['selection']['workspace_id']=x['workspace'];v['actor_id']=x['actor'];v['route']=x['route'];v['default_route']=x['defaults'];v['settings']=x['settings']
v['target']={k:x['model'][k] for k in ['id','connection_id','model','revision','enabled','capabilities']}
v['target'].update(connection_enabled=True,connection_revision=x['connection']['revision'],provider='openai')
v['anchor']['model_config_id']=x['model']['id'];v['anchor']['model']=x['model']['model']
p=m.prepare(v,'a'*64)
print(json.dumps({'prepared':p,'inspection':m.inspection_sql(v['selection'],v['anchor']),'acceptance':m.acceptance_sql(p)}))
`], { input: JSON.stringify({ workspace: f.w, actor: f.owner, route, defaults, settings, connection, model: models[0] }), encoding: "utf8" }));
  return { generated, route, settings, models };
}

async function batch(commands: unknown, key: string) {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.owner]);
  await f.db.exec("set role authenticated;savepoint repair_batch");
  try { return (await f.db.query("select public.app_batch_prepare($1::jsonb,$2) value", [JSON.stringify(commands), key])).rows[0]; }
  catch (error) { await f.db.exec("rollback to savepoint repair_batch"); throw error; }
  finally { await f.db.exec("release savepoint repair_batch;reset role"); }
}
async function read(sql: string) {
  const query = sql.replace("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;", "")
    .replace("SET LOCAL ROLE tdp_app_owner;", "").replace("ROLLBACK;", "");
  const results = await f.db.exec(query);
  return results.flatMap(r => r.rows).find((r: any) => r.jsonb_build_object)?.jsonb_build_object as any;
}

it("executes the generated read-only queries and preserves admission, providers and allowances through one replay-safe Owner batch", async () => {
  const { generated, route, settings, models } = await setup();
  const before = await read(generated.inspection);
  expect(before.route.id).toBe(route.id);
  expect(before.guards.successful_verifier).toBe(false); // No paid call exists in this fixture.
  const request = generated.prepared;
  await batch(request.body.commands, request.idempotency_key);
  const after = await read(generated.inspection);
  expect(after.protected).toEqual(before.protected);
  expect(after.route).toEqual({ ...before.route, model_ids: [models[0].id], inherit_default: false,
    next_position: 0, revision: route.revision + 1, updated_at: after.route.updated_at });
  expect(after.settings).toEqual({ ...before.settings, max_parallel_requests: 4,
    revision: settings.revision + 1, updated_at: after.settings.updated_at });
  expect(after.settings.admitted_after).toBe(settings.admitted_after);
  expect(await read(generated.acceptance)).toMatchObject({ count: 2, batch: true, results: [after.route, after.settings] });
  await batch(request.body.commands, request.idempotency_key);
  expect(await read(generated.inspection)).toEqual(after);
});

it("rolls back the first route command, audit and receipts when the second expected revision is stale", async () => {
  const { generated } = await setup();
  const before = await read(generated.inspection);
  const commands = structuredClone(generated.prepared.body.commands);
  commands[1].input.expected_revision += 1;
  await expect(batch(commands, generated.prepared.idempotency_key)).rejects.toThrow("REVISION_CONFLICT");
  expect(await read(generated.inspection)).toEqual(before);
  expect(await read(generated.acceptance)).toEqual({ count: 0, batch: false, results: [] });
});
