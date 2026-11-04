// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

it("applies the complete delivery migration batch with managed roles only and retains private service authority", async () => {
  const f = await workflowFixture(
    undefined,
    "20261103032000_model_admission_fairness.sql",
  );
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  try {
    await f.db.exec("begin");
    const source = await f.command("source.create", {
      name: "Synthetic managed source",
      kind: "manual",
    });
    const opportunity = await f.command("opportunity.create", {
      source_id: source.id,
      title: "Synthetic managed proposal",
      reference: "SYNTHETIC",
      description: "Deliver a documented approval workflow.",
      language: "en",
      decision: "shortlisted",
    });
    const oldJob = (
      await f.db.query<any>(
        `insert into public.jobs(workspace_id,type,entity_id,input_hash,status,attempts,failure_count,checkpoint,created_by)
      values($1,'analyze_chunk',gen_random_uuid(),repeat('a',64),'blocked',4,2,'{"model_executor":2,"retained_unknown_usage":true,"writer_budget":1}',$2) returning *`,
        [f.w, f.owner],
      )
    ).rows[0];
    await f.db
      .exec(`create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
      alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
      grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
      DO $ownership$ DECLARE r record;BEGIN
      FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
       EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);END LOOP;
      END $ownership$;
      ALTER ROLE anon RENAME TO tdp_app_anon;ALTER ROLE authenticated RENAME TO tdp_app_authenticated;
      ALTER ROLE service_role RENAME TO tdp_app_service;ALTER ROLE tdp_app_service NOBYPASSRLS;
      GRANT tdp_app_owner TO tdp_app_service;
      SET ROLE tdp_app_owner;`);
    const names = (await readdir(directory))
      .filter((n) => /^202611041[0-2]\d+_.+\.sql$/.test(n))
      .sort();
    expect(names).toHaveLength(6);
    for (const name of names)
      await f.db.exec(await readFile(new URL(name, directory), "utf8"));
    await f.db.exec("reset role");
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from pg_roles where rolname in ('anon','authenticated','service_role')",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await f.db.query<any>(
          "select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname='tdp_app_owner'",
        )
      ).rows[0],
    ).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    expect(
      (
        await f.db.query<any>("select * from public.jobs where id=$1", [
          oldJob.id,
        ])
      ).rows[0],
    ).toEqual(oldJob);
    for (const signature of [
      "public.delivery_export_context(uuid,uuid)",
      "public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint)",
      "public.claim_backend_job_v3()",
      "public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb)",
    ]) {
      expect(
        (
          await f.db.query<any>(
            "select has_function_privilege('tdp_app_authenticated',$1,'EXECUTE') allowed",
            [signature],
          )
        ).rows[0].allowed,
      ).toBe(false);
      expect(
        (
          await f.db.query<any>(
            "select has_function_privilege('tdp_app_service',$1,'EXECUTE') allowed",
            [signature],
          )
        ).rows[0].allowed,
      ).toBe(true);
    }
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      f.owner,
    ]);
    await f.db.exec("set role tdp_app_authenticated");
    const snapshot = await f.rpc("app_command", [
      "delivery.snapshot.prepare",
      JSON.stringify({
        opportunity_id: opportunity.id,
        expected_revision: opportunity.revision,
      }),
      crypto.randomUUID(),
    ]);
    expect(
      (await f.rpc("delivery_context", [snapshot.id])).payload.approval_state,
    ).toBe("draft");
    expect((await f.rpc("delivery_package", [snapshot.id])).status).toBe(
      "preparing",
    );
    await f.db.exec("savepoint private_payload");
    await expect(
      f.db.query("select payload from public.proposal_delivery_snapshots"),
    ).rejects.toThrow("permission denied");
    await f.db.exec(
      "rollback to savepoint private_payload;release savepoint private_payload;reset role;set role tdp_app_service",
    );
    const job = await f.rpc("claim_backend_job_v3");
    expect(job.entity_id).toBe(snapshot.id);
    expect(
      (await f.rpc("delivery_export_context", [job.id, job.lease_token]))
        .artifacts,
    ).toHaveLength(1);
    await f.db.exec("reset role;rollback");
  } finally {
    await f.db.close();
  }
}, 30000);
