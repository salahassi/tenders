// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";

const actualWriterVersion =
  "tenderdesk-v3.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1";
let f: Awaited<ReturnType<typeof workflowFixture>>;
let correction: string;
beforeAll(async () => {
  f = await workflowFixture(
    undefined,
    "20261103022500_analysis_verifier_recheck.sql",
  );
  correction = await readFile(
    new URL(
      "../../supabase/migrations/20261103031500_analysis_recheck_prompt_identity.sql",
      import.meta.url,
    ),
    "utf8",
  );
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function allApplicationTables() {
  const tables = (
    await f.db.query<{ schema: string; name: string }>(
      "select n.nspname schema,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private','auth','storage') and c.relkind in ('r','p') order by n.nspname,c.relname",
    )
  ).rows;
  const snapshots: Record<string, unknown> = {};
  const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  for (const table of tables) {
    const qualified = `${quoted(table.schema)}.${quoted(table.name)}`;
    snapshots[qualified] = (
      await f.db.query(
        `select count(*)::int count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') hash from ${qualified} t`,
      )
    ).rows;
  }
  return snapshots;
}
async function securityState() {
  return {
    functions: (
      await f.db.query(
        "select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private','auth','storage') order by signature",
      )
    ).rows,
    relations: (
      await f.db.query(
        "select n.nspname,c.relname,pg_get_userbyid(c.relowner) owner,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private','auth','storage') and c.relkind in ('r','p','v','m','S') order by n.nspname,c.relname",
      )
    ).rows,
    schemas: (
      await f.db.query(
        "select nspname,pg_get_userbyid(nspowner) owner,nspacl::text acl from pg_namespace where nspname in ('public','app_private','auth','storage') order by nspname",
      )
    ).rows,
  };
}

it("reproduces the production prompt refusal at migration 225 and repairs only the guard at migration 315", async () => {
  const s = await createRecheckFixture(f);
  expect(s.writerPromptVersion).toBe(actualWriterVersion);
  const candidateBefore = await s.row(
    "app_private.model_graph_results",
    s.candidate.id,
  );
  const before = await allApplicationTables();
  const security = await securityState();
  await expect(s.createChild()).rejects.toThrow(
    "MODEL_RECHECK_IDENTITY_CHANGED",
  );
  expect(await allApplicationTables()).toEqual(before);
  expect(await securityState()).toEqual(security);
  await f.db.exec(correction);
  expect(await allApplicationTables()).toEqual(before);
  expect(await securityState()).toEqual(security);
  expect(await s.createChild()).toMatchObject({
    parent_job_id: s.parent.id,
    plan_id: s.plan.id,
  });
  expect(
    (
      await f.db.query(
        "select count(*)::int count from app_private.analysis_verifier_rechecks where parent_job_id=$1",
        [s.parent.id],
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
  expect(await s.row("public.provider_usage", s.usage.id)).toEqual(s.usage);
  expect(
    await s.row("app_private.model_graph_results", s.candidate.id),
  ).toEqual(candidateBefore);
});

it.each([
  [
    "fabricated task-name prefix",
    "analyze_chunk.v1.analysis-evidence-v1.tenderdesk-semantic-fidelity-v1",
  ],
  ["legacy registry identity", "tenderdesk-v3"],
  [
    "another task identity",
    "tenderdesk-repair-v1.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1",
  ],
  [
    "wrong semantic revision",
    "tenderdesk-v3.tenderdesk-semantic-fidelity-v1.economy-v1",
  ],
  ["unreviewed identity suffix", actualWriterVersion + ".unreviewed"],
])("atomically rejects %s", async (_reason, version) => {
  await f.db.exec(correction);
  const s = await createRecheckFixture(f);
  await f.db.query(
    "update public.model_attempts set execution_metadata=jsonb_set(execution_metadata,'{prompt_version}',to_jsonb($2::text)) where usage_id=$1 and operation='analyze_chunk'",
    [s.usage.id, version],
  );
  const before = await s.snapshot();
  await expect(s.createChild()).rejects.toThrow(
    "MODEL_RECHECK_IDENTITY_CHANGED",
  );
  expect(await s.snapshot()).toEqual(before);
});

it.each([
  "missing-writer-pin",
  "wrong-pin-phase",
  "wrong-pin-revision",
  "string-pin-revision",
  "wrong-pin-content-hash",
  "tampered-pin-content",
  "malformed-legacy-hash",
  "missing-instructions",
  "wrong-paid-request-hash",
])(
  "atomically rejects %s with the correct runtime prompt identity",
  async (reason) => {
    await f.db.exec(correction);
    const s = await createRecheckFixture(f);
    expect(s.writerPromptVersion).toBe(actualWriterVersion);
    if (reason === "missing-writer-pin")
      await f.db.query(
        "delete from app_private.model_graph_results where id=$1",
        [s.writerPin.id],
      );
    if (reason === "wrong-pin-phase")
      await f.db.query(
        "update app_private.model_graph_results set result_key=$2 where id=$1",
        [s.writerPin.id, "semantic-instructions-" + "f".repeat(64)],
      );
    if (reason === "wrong-pin-content-hash")
      await f.db.query(
        "update app_private.model_graph_results set content_hash=repeat('f',64) where id=$1",
        [s.writerPin.id],
      );
    if (reason === "tampered-pin-content")
      await f.db.query(
        "update app_private.model_graph_results set value=jsonb_set(value,'{instructions}','\"Different instructions.\"') where id=$1",
        [s.writerPin.id],
      );
    const changed = structuredClone(s.writerPin.value);
    if (reason === "wrong-pin-revision") changed.version = 2;
    if (reason === "string-pin-revision") changed.version = "4";
    if (reason === "malformed-legacy-hash")
      changed.legacy_input_hash = "not-a-digest";
    if (reason === "missing-instructions") delete changed.instructions;
    if (
      [
        "wrong-pin-revision",
        "string-pin-revision",
        "malformed-legacy-hash",
        "missing-instructions",
      ].includes(reason)
    )
      await f.db.query(
        "update app_private.model_graph_results set value=$2::jsonb,content_hash=encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex') where id=$1",
        [s.writerPin.id, JSON.stringify(changed)],
      );
    if (reason === "wrong-paid-request-hash")
      await f.db.query(
        "update public.model_attempts set execution_metadata=jsonb_set(execution_metadata,'{input_hash}',to_jsonb(repeat('f',64))) where usage_id=$1 and operation='analyze_chunk'",
        [s.usage.id],
      );
    const before = await s.snapshot();
    await expect(s.createChild()).rejects.toThrow(
      "MODEL_RECHECK_IDENTITY_CHANGED",
    );
    expect(await s.snapshot()).toEqual(before);
  },
);
