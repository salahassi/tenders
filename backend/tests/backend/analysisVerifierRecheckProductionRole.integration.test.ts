// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";

it("checks, activates and replays the generated ops transaction as the production application owner without superuser or RLS bypass", async () => {
  const f = await workflowFixture();
  try {
    await f.db.exec("begin");
    const s = await createRecheckFixture(f);
    const selected = {
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
    // Synthetic witness only: record the effective role inside the canonical
    // operation, including whether that role has either privileged attribute.
    await f.db.exec(`
      create table app_private.synthetic_recheck_execution_role (
        role_name text, is_superuser boolean, bypasses_rls boolean
      );
      create function app_private.synthetic_witness_recheck_role() returns trigger language plpgsql as $$
      begin
        insert into app_private.synthetic_recheck_execution_role
          select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user;
        return new;
      end $$;
      create trigger synthetic_witness_recheck_role
        after insert on app_private.analysis_verifier_rechecks
        for each row execute function app_private.synthetic_witness_recheck_role();
      create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
      alter schema public owner to tdp_app_owner;
      alter schema app_private owner to tdp_app_owner;
      grant usage on schema auth to tdp_app_owner;
      grant select,references on auth.users,auth.identities to tdp_app_owner;
      do $ownership$ declare rec record; begin
        for rec in select n.nspname,c.relname,c.relkind from pg_class c
          join pg_namespace n on n.oid=c.relnamespace
          where n.nspname in ('public','app_private') and c.relkind in ('r','p','v','m') loop
          execute format('alter %s %I.%I owner to tdp_app_owner',
            case when rec.relkind='v' then 'view' when rec.relkind='m' then 'materialized view' else 'table' end,
            rec.nspname,rec.relname);
        end loop;
        for rec in select p.oid::regprocedure signature from pg_proc p
          join pg_namespace n on n.oid=p.pronamespace
          where n.nspname in ('public','app_private') and p.prokind='f' loop
          execute format('alter function %s owner to tdp_app_owner',rec.signature);
        end loop;
      end $ownership$;
      commit;
    `);
    expect(
      (
        await f.db.query(
          "select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname='tdp_app_owner'",
        )
      ).rows,
    ).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      },
    ]);
    expect(
      (
        await f.db.query(
          "select pg_get_userbyid(proowner) owner from pg_proc where oid='app_private.recheck_analysis_verifier(jsonb,text)'::regprocedure",
        )
      ).rows,
    ).toEqual([{ owner: "tdp_app_owner" }]);

    function compile(activate?: true) {
      const sql = execFileSync(
        "python3",
        [
          "-c",
          `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('production_role_recheck',sys.argv[1])
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
      expect(sql).toContain("SET LOCAL ROLE tdp_app_owner;");
      expect(sql).not.toContain("SET LOCAL ROLE postgres");
      expect(sql).toMatch(/COMMIT;\s*$/);
      // PGlite's database is named postgres. The production role, transaction
      // framing, SQL guards and complete command body remain untouched.
      return sql.replaceAll(
        "current_database()<>'tenderdesk_app'",
        "current_database()<>'postgres'",
      );
    }
    async function run(activate?: true) {
      const rows = (await f.db.exec(compile(activate))).flatMap(
        (entry) => entry.rows,
      ) as Array<{ current_setting?: string }>;
      const receipts = rows.filter(
        (row) => typeof row.current_setting === "string",
      );
      expect(receipts).toHaveLength(1);
      return JSON.parse(receipts[0].current_setting!);
    }
    const before = await s.snapshot();
    const siblingBefore = await s.row("public.jobs", s.sibling.id);
    const siblingStepBefore = (
      await f.db.query(
        "select * from public.generation_steps where job_id=$1",
        [s.sibling.id],
      )
    ).rows;
    expect(siblingBefore.status).toBe("succeeded");
    expect(siblingStepBefore).toHaveLength(1);
    expect(siblingStepBefore[0]).toMatchObject({ status: "completed" });
    expect(await run()).toMatchObject({
      status: "checked",
      count: 0,
      writer_allowance: 0,
    });
    expect(await s.snapshot()).toEqual(before);
    expect(
      (
        await f.db.query(
          "select * from app_private.synthetic_recheck_execution_role",
        )
      ).rows,
    ).toEqual([]);

    const activated = await run(true);
    expect(activated).toMatchObject({
      status: "started",
      count: 1,
      parent_job_id: s.parent.id,
      verifier_allowance: 3,
      verifier_correction_allowance: 1,
    });
    expect(activated.retained_history_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await f.db.query(
          "select * from app_private.synthetic_recheck_execution_role",
        )
      ).rows,
    ).toEqual([
      { role_name: "tdp_app_owner", is_superuser: false, bypasses_rls: false },
    ]);
    expect(await s.row("public.jobs", s.sibling.id)).toEqual(siblingBefore);
    expect(
      (
        await f.db.query(
          "select * from public.generation_steps where job_id=$1",
          [s.sibling.id],
        )
      ).rows,
    ).toEqual(siblingStepBefore);
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
    for (const event of before["public.audit_events"])
      expect(after["public.audit_events"]).toContain(event);
    for (const table of [
      "public.jobs",
      "public.generation_steps",
      "public.audit_events",
      "app_private.analysis_verifier_rechecks",
    ])
      expect(after[table].length - before[table].length, table).toBe(1);
    for (const activate of [true, undefined] as const) {
      expect(await run(activate)).toMatchObject({
        status: "already_started",
        count: 0,
        child_job_id: activated.child_job_id,
        child_step_id: activated.child_step_id,
      });
      expect(await s.snapshot()).toEqual(after);
      expect(
        (
          await f.db.query(
            "select count(*)::int count from app_private.synthetic_recheck_execution_role",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    }
  } finally {
    await f.db.close();
  }
}, 30000);
