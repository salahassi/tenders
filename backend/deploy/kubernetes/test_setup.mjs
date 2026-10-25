/** Real PostgreSQL regression for permanent-role ownership and safe reruns. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const source = await readFile(new URL("./setup.sql", import.meta.url), "utf8");
const block = source.match(/DO \$setup\$[\s\S]+?\$setup\$;/)?.[0];
assert.ok(block, "The role creation/ownership guard must exist");
// PGlite has one logical database. Only this fixture connection-name differs.
const sql = block.replace("current_database() <> 'defaultdb'", "current_database() <> 'postgres'");
const fixture = new PGlite();
try {
  await fixture.waitReady;
  await fixture.exec("CREATE ROLE fixture_admin CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS; SET SESSION AUTHORIZATION fixture_admin;");
  await fixture.query("SELECT set_config('td_setup.database', 'tenderdesk_app', false), set_config('td_setup.prefix', 'tdp_app', false), set_config('td_setup.auth_password', $1, false), set_config('td_setup.storage_password', $2, false), set_config('td_setup.rest_password', $3, false)", ["auth-fixture-".repeat(4), "storage-fixture-".repeat(4), "rest-fixture-".repeat(4)]);
  await fixture.exec(sql);
  const roles = (await fixture.query("SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname LIKE 'tdp_app_%' ORDER BY rolname")).rows;
  assert.equal(roles.length, 7);
  assert.ok(roles.every((role) => !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb));
  assert.ok(roles.every((role) => role.marker === "tenderdesk-managed-kubernetes:tenderdesk_app:tdp_app"));
  assert.deepEqual(roles.filter((role) => role.rolcanlogin).map((role) => role.rolname), ["tdp_app_authadmin", "tdp_app_authenticator", "tdp_app_storageadmin"]);
  await fixture.exec("SET SESSION AUTHORIZATION postgres;");
  const before = (await fixture.query("SELECT rolname, rolpassword FROM pg_authid WHERE rolname LIKE 'tdp_app_%' ORDER BY rolname")).rows;
  await fixture.exec("SET SESSION AUTHORIZATION fixture_admin;");
  await fixture.query("SELECT set_config('td_setup.auth_password', $1, false)", ["different-fixture-password-".repeat(3)]);
  await fixture.exec(sql);
  await fixture.exec("SET SESSION AUTHORIZATION postgres;");
  assert.deepEqual((await fixture.query("SELECT rolname, rolpassword FROM pg_authid WHERE rolname LIKE 'tdp_app_%' ORDER BY rolname")).rows, before, "Safe rerun must preserve existing password hashes");
  await fixture.exec("SET SESSION AUTHORIZATION fixture_admin; COMMENT ON ROLE tdp_app_storageadmin IS 'unrelated-object';");
  await assert.rejects(fixture.exec(sql), (error) => error.message.includes("SETUP_FOREIGN_ROLE_REJECTED"));
  await fixture.exec("COMMENT ON ROLE tdp_app_storageadmin IS 'tenderdesk-managed-kubernetes:tenderdesk_app:tdp_app';");
  await fixture.exec("SET SESSION AUTHORIZATION postgres; ALTER ROLE tdp_app_anon BYPASSRLS; SET SESSION AUTHORIZATION fixture_admin;");
  await assert.rejects(fixture.exec(sql), (error) => error.message.includes("SETUP_FOREIGN_ROLE_REJECTED"));
  console.log("Permanent setup passed: scoped roles, preserved passwords on rerun, foreign-marker and elevated-role refusal.");
} finally {
  await fixture.close();
}
