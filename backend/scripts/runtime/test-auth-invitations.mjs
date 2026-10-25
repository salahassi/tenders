// Real PostgreSQL execution of the Auth hook. Synthetic automated fixtures only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
try {
  await db.exec(`
    create role fixture_owner;
    create role fixture_authadmin;
    create role fixture_anon;
    create role fixture_authenticated;
    create schema app_private authorization fixture_owner;
    create table public.workspace_invitations(workspace_id uuid,email text,status text,
      expires_at timestamptz,created_by uuid);
    create table public.memberships(workspace_id uuid,user_id uuid,active boolean,role text);
    create table public.identity_allowlist(workspace_id uuid,user_id uuid,status text);
    alter table public.workspace_invitations owner to fixture_owner;
    alter table public.memberships owner to fixture_owner;
    alter table public.identity_allowlist owner to fixture_owner;
    alter table public.workspace_invitations enable row level security;
    alter table public.memberships enable row level security;
    alter table public.identity_allowlist enable row level security;
    insert into public.memberships values('00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',true,'Owner');
    insert into public.identity_allowlist values('00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002','active');
    insert into public.workspace_invitations values('00000000-0000-4000-8000-000000000001',
      'invited@example.invalid','pending',now()+interval '1 day','00000000-0000-4000-8000-000000000002');
    set role fixture_owner;
  `);
  const sql = (await readFile(new URL("./auth-invitations.sql", import.meta.url), "utf8"))
    .replaceAll(':"auth_role"','"fixture_authadmin"');
  await db.exec(sql);
  await db.exec("reset role");
  const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0];
  const payload = (email, extra = {}) => ({ user: { email, phone: "", is_anonymous: false,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, ...extra } });
  const hook = async (input) => {
    await db.exec("set role fixture_authadmin");
    try { return await scalar(`select app_private.before_user_created('${JSON.stringify(input).replaceAll("'", "''")}')`); }
    finally { await db.exec("reset role"); }
  };
  const denied = async (input) => assert.equal((await hook(input)).error.http_code,403);
  await denied(payload("stranger@example.invalid"));
  assert.deepEqual(await hook(payload("INVITED@example.invalid")),{});
  await denied(payload("invited@example.invalid",{ is_anonymous: true }));
  await denied(payload("invited@example.invalid",{ phone: "+10000000000" }));
  await denied(payload("invited@example.invalid",{ app_metadata: { provider: "github" } }));
  await denied(payload("stranger@example.invalid",{ user_metadata: { role: "Owner", approved: true,
    workspace_id: "00000000-0000-4000-8000-000000000001", invited: true } }));
  await denied({ user: {} });
  await denied({});
  for (const state of ["revoked","accepted","expired"]) {
    await db.exec(`update public.workspace_invitations set status='${state}'`);
    await denied(payload("invited@example.invalid"));
  }
  await db.exec("update public.workspace_invitations set status='pending',expires_at=now()-interval '1 second'");
  await denied(payload("invited@example.invalid"));
  await db.exec("update public.workspace_invitations set expires_at=now()+interval '1 day'");
  await db.exec("update public.memberships set active=false");
  await denied(payload("invited@example.invalid"));
  await db.exec("update public.memberships set active=true,role='Editor'");
  await denied(payload("invited@example.invalid"));
  await db.exec("update public.memberships set role='Owner'");
  await db.exec("update public.identity_allowlist set status='inactive'");
  await denied(payload("invited@example.invalid"));
  await db.exec("update public.identity_allowlist set status='active'");
  assert.deepEqual(await hook(payload("invited@example.invalid")),{});
  for (const role of ["fixture_anon","fixture_authenticated"]) {
    assert.equal(await scalar(`select has_function_privilege('${role}',
      'app_private.before_user_created(jsonb)','execute')`),false);
  }
  assert.equal(await scalar("select has_table_privilege('fixture_authadmin','public.workspace_invitations','select')"),false,
    "Auth admin can invoke the bounded hook without direct invitation-table access");
  assert.equal(await scalar("select count(*) from public.memberships"),1,
    "The admission hook cannot grant a workspace membership");
  console.log(JSON.stringify({ component: "invitation_only_auth_hook", status: "passed",
    postgres: await scalar("select current_setting('server_version')") }));
} finally { await db.close(); }
