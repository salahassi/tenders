/** PostgreSQL-engine regression for the bootstrap's non-superuser role graph.
 * Runs only in fresh in-memory PGlite instances; no network or live credentials.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const setup = await readFile(new URL('./setup.sql', import.meta.url), 'utf8');
const selfGrant = setup.match(/SELECT format\('(GRANT %I TO %I WITH [^']+)',\s*:'role_prefix' \|\| '_' \|\| suffix,\s*current_user\)/)?.[1];
const requestGrant = setup.match(/SELECT format\('(GRANT %I, %I, %I TO %I WITH [^']+)'/)?.[1];
const serviceGrant = setup.match(/SELECT format\('(GRANT %I, %I TO %I WITH [^']+)'/)?.[1];
const postMigrations = await readFile(new URL('./post-migrations.sql', import.meta.url), 'utf8');
const authCountQuery = postMigrations.match(/SELECT count\(\*\) AS auth_migrations FROM auth\.schema_migrations/)?.[0];
const storageCountQuery = postMigrations.match(/SELECT count\(\*\) AS storage_migrations FROM storage\.migrations/)?.[0];
assert.equal(selfGrant, 'GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', 'Use the reviewed self-grant without granting ADMIN back to its grantor');
assert.equal(requestGrant, 'GRANT %I, %I, %I TO %I WITH INHERIT FALSE, SET TRUE');
assert.equal(serviceGrant, 'GRANT %I, %I TO %I WITH INHERIT TRUE, SET TRUE');
assert.ok(authCountQuery && storageCountQuery, 'Metadata queries must remain present in the reviewed post-migration script');

async function executeFormat(db, format, ...identifiers) {
  const args = identifiers.map((_, index) => `$${index + 2}::text`).join(', ');
  const result = await db.query(`SELECT format($1::text, ${args}) AS statement`, [format, ...identifiers]);
  await db.exec(result.rows[0].statement);
}

async function instance(run) {
  const db = new PGlite();
  try {
    await db.waitReady;
    await db.exec('CREATE ROLE fixture_admin CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS; ALTER DATABASE postgres OWNER TO fixture_admin; SET SESSION AUTHORIZATION fixture_admin;');
    const identity = (await db.query('SELECT current_user, session_user')).rows[0];
    assert.equal(identity.current_user, 'fixture_admin');
    assert.equal(identity.session_user, 'fixture_admin');
    await run(db);
  } finally {
    await db.close();
  }
}

await instance(async (db) => {
  await db.exec('CREATE ROLE fixture_old_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;');
  await assert.rejects(
    db.exec('GRANT fixture_old_owner TO fixture_admin WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;'),
    (error) => error.code === '0LP01',
    'PostgreSQL must reject granting ADMIN back to the original grantor',
  );
});

await instance(async (db) => {
  const prefix = 'fixture_new';
  const names = Object.fromEntries(['owner', 'authadmin', 'storageadmin', 'authenticator', 'anon', 'authenticated', 'service'].map((suffix) => [suffix, `${prefix}_${suffix}`]));
  for (const [suffix, name] of Object.entries(names)) {
    const login = ['authadmin', 'storageadmin', 'authenticator'].includes(suffix) ? 'LOGIN' : 'NOLOGIN';
    const inherit = ['owner', 'service'].includes(suffix) ? 'INHERIT' : 'NOINHERIT';
    await db.exec(`CREATE ROLE ${name} ${login} ${inherit} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
  }
  for (const suffix of ['owner', 'authadmin', 'storageadmin']) {
    await executeFormat(db, selfGrant, names[suffix], 'fixture_admin');
    await db.exec(`SET ROLE ${names[suffix]};`);
    assert.equal((await db.query('SELECT current_user')).rows[0].current_user, names[suffix]);
    await db.exec('RESET ROLE;');
  }
  await executeFormat(db, requestGrant, names.anon, names.authenticated, names.service, names.authenticator);
  await executeFormat(db, serviceGrant, names.owner, names.storageadmin, names.service);
  const memberships = (await db.query(`SELECT
    pg_has_role($1::name, $2::name, 'SET') AS can_select_user,
    pg_has_role($1::name, $3::name, 'SET') AS can_select_service,
    pg_has_role($1::name, $4::name, 'USAGE') AS authenticator_inherits_owner,
    pg_has_role($2::name, $4::name, 'USAGE') AS user_inherits_owner,
    pg_has_role($3::name, $4::name, 'USAGE') AS service_inherits_owner`,
    [names.authenticator, names.authenticated, names.service, names.owner])).rows[0];
  assert.deepEqual(memberships, {can_select_user: true, can_select_service: true,
    authenticator_inherits_owner: false, user_inherits_owner: false, service_inherits_owner: true});
  const attributes = (await db.query('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE $1', [prefix + '_%'])).rows;
  assert.equal(attributes.length, 7);
  assert.ok(attributes.every((role) => Object.values(role).every((flag) => flag === false)), 'No runtime role gains superuser, BYPASSRLS or role/database creation');

});

await instance(async (db) => {
  for (const [role, schema, table, rows] of [
    ['fixture_auth', 'auth', 'schema_migrations', '(1), (2)'],
    ['fixture_storage', 'storage', 'migrations', '(1), (2), (3)'],
  ]) {
    await db.exec(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);
    await executeFormat(db, selfGrant, role, 'fixture_admin');
    await db.exec(`GRANT CREATE ON DATABASE postgres TO ${role};
      CREATE SCHEMA ${schema} AUTHORIZATION ${role}; SET ROLE ${role};
      REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
      CREATE TABLE ${schema}.${table}(version integer PRIMARY KEY);
      INSERT INTO ${schema}.${table} VALUES ${rows}; RESET ROLE;`);
  }
  // Database ownership and ADMIN/SET membership do not grant table reads when
  // membership has INHERIT FALSE. This reproduces the live reporting failure.
  for (const query of [authCountQuery, storageCountQuery]) {
    await assert.rejects(db.query(query), (error) => error.code === '42501');
  }
  await db.exec('BEGIN; SET LOCAL ROLE fixture_auth;');
  const authCount = Number((await db.query(authCountQuery)).rows[0].auth_migrations);
  await db.exec('RESET ROLE; SET LOCAL ROLE fixture_storage;');
  const storageCount = Number((await db.query(storageCountQuery)).rows[0].storage_migrations);
  await db.exec('RESET ROLE; COMMIT;');
  const summary = (await db.query(`SELECT jsonb_build_object(
    'auth_migrations', $1::integer, 'storage_migrations', $2::integer,
    'auth_table_exists', EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname='schema_migrations')) AS summary`, [authCount, storageCount])).rows[0].summary;
  assert.deepEqual(summary, {auth_migrations: 2, storage_migrations: 3, auth_table_exists: true});
  assert.equal((await db.query('SELECT current_user')).rows[0].current_user, 'fixture_admin');
  for (const query of [authCountQuery, storageCountQuery]) {
    await assert.rejects(db.query(query), (error) => error.code === '42501', 'Owner-scoped reporting must not widen the administrator role');
  }
});

console.log('PostgreSQL role regression passed: ADMIN self-grant rejection, setup role graph, and owner-scoped migration metadata reads verified.');
