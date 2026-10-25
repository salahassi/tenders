/** Execute the generated catalog DDL in PostgreSQL 18 with non-superuser roles.
 * The private catalog is an explicit local input; no production rows are read.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.on('uncaughtException', error => {
  console.error(JSON.stringify({status:'failed',code:error.code,message:error.message,where:error.where,position:error.position,query_prefix:error.query?.slice(0,180)}));
  process.exit(1);
});

const catalog = process.argv[2];
assert.ok(catalog, 'Pass the private captured catalog directory');
const build = new URL('./build_schema.py', import.meta.url);
const result = spawnSync('python3', ['-c', `import importlib.util,json,sys,pathlib,hashlib
s=importlib.util.spec_from_file_location('builder',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=m.read_catalog(pathlib.Path(sys.argv[2]));sql,manifest=m.build_schema(c,'tdp_app','postgres')
d=importlib.util.spec_from_file_location('deployment',pathlib.Path(sys.argv[1]).parents[1]/'digitalocean-deploy.py');deployment=importlib.util.module_from_spec(d);d.loader.exec_module(deployment)
seed=pathlib.Path(sys.argv[3]).read_text() if len(sys.argv)>3 else 'BEGIN; COMMIT;'
hashes={'schema.sql':hashlib.sha256(sql.encode()).hexdigest(),'seed.sql':hashlib.sha256(seed.encode()).hexdigest()}
def table(schema,name):
 rows=sorted([x for x in c['columns'] if x['schema']==schema and x['relname']==name],key=lambda x:x['attnum'])
 return 'CREATE TABLE '+schema+'.'+name+'('+','.join(m.identifier(x['attname'])+' '+x['data_type'] for x in rows)+');'
print(json.dumps({'sql':deployment.with_restore_checkpoint(sql,'schema',{'sha256':hashes}),'seed':deployment.with_restore_checkpoint(seed,'seed',{'sha256':hashes}),'hashes':hashes,'manifest':manifest,'upstream': '\\n'.join(table(*x) for x in [('auth','users'),('auth','identities'),('storage','buckets'),('storage','objects')])}))`, build.pathname, catalog, ...process.argv.slice(3,4)], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
assert.equal(result.status, 0, result.stderr);
const {sql, seed, hashes, manifest, upstream} = JSON.parse(result.stdout);
const db = new PGlite();
try {
  await db.waitReady;
  await db.exec(`CREATE ROLE deployment_admin CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS;
    ALTER DATABASE postgres OWNER TO deployment_admin;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE SCHEMA extensions;
    CREATE TYPE storage.buckettype AS ENUM ('STANDARD','ANALYTICS','VECTOR');
    ${upstream}
    ALTER TABLE auth.users ADD PRIMARY KEY (id);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
  for (const suffix of ['owner','authadmin','storageadmin','authenticator','anon','authenticated','service']) {
    await db.exec(`CREATE ROLE tdp_app_${suffix} NOLOGIN ${suffix === 'service' || suffix === 'owner' ? 'INHERIT' : 'NOINHERIT'} NOSUPERUSER NOBYPASSRLS;
      GRANT tdp_app_${suffix} TO deployment_admin WITH INHERIT FALSE, SET TRUE;`);
  }
  for (const statement of `GRANT CREATE ON DATABASE postgres TO tdp_app_owner;
    GRANT tdp_app_owner,tdp_app_storageadmin TO tdp_app_service WITH INHERIT TRUE, SET TRUE;
    ALTER SCHEMA public OWNER TO tdp_app_owner;
    ALTER SCHEMA auth OWNER TO tdp_app_authadmin;
    ALTER SCHEMA storage OWNER TO tdp_app_storageadmin;
    ALTER TABLE auth.users OWNER TO tdp_app_authadmin;
    ALTER TABLE auth.identities OWNER TO tdp_app_authadmin;
    ALTER TABLE storage.objects OWNER TO tdp_app_storageadmin;
    ALTER TABLE storage.buckets OWNER TO tdp_app_storageadmin;
    GRANT USAGE ON SCHEMA auth,storage,extensions TO tdp_app_owner,tdp_app_authenticated,tdp_app_anon,tdp_app_service,tdp_app_storageadmin;
    GRANT USAGE ON SCHEMA public TO tdp_app_authenticated,tdp_app_anon,tdp_app_service,tdp_app_storageadmin;
    GRANT INSERT,SELECT ON storage.objects TO tdp_app_authenticated;
    SET SESSION AUTHORIZATION deployment_admin;`.split(";").map(value=>value.trim()).filter(Boolean)) await db.exec(statement+";");
  await db.exec(sql);
  const tables = (await db.query(`SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private') AND c.relkind='r'`)).rows[0].count;
  assert.equal(tables, manifest.tables + 1); // deployment ledger is private runtime state
  await db.exec('SET ROLE tdp_app_owner;');
  assert.deepEqual((await db.query('SELECT stage,schema_sha256,seed_sha256 FROM app_private.deployment_restore_state')).rows[0],{stage:'schema',schema_sha256:hashes['schema.sql'],seed_sha256:hashes['seed.sql']});
  assert.equal((await db.query("SELECT obj_description('app_private.deployment_restore_state'::regclass,'pg_class') AS marker")).rows[0].marker,'tenderdesk-managed-kubernetes:restore-ledger:v1');
  await db.exec('RESET ROLE; SET ROLE tdp_app_authenticated;');
  await assert.rejects(db.query('SELECT * FROM app_private.deployment_restore_state'),error=>error.code==='42501');
  await db.exec('RESET ROLE; SET ROLE tdp_app_anon;');
  await assert.rejects(db.query('SELECT * FROM app_private.deployment_restore_state'),error=>error.code==='42501');
  await db.exec('RESET ROLE;');
  assert.equal((await db.query(`SELECT count(*)::integer AS count FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private','storage')`)).rows[0].count, manifest.policies);
  const vulnerable = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity`)).rows;
  assert.deepEqual(vulnerable, []);
  if (process.argv[3]) {
    // Explicit private local rehearsal. No row values are printed or persisted;
    // an outer transaction rolls back the complete seed before fixture tests.
    const privateSeed = seed
      .replace('BEGIN; SET LOCAL search_path', 'SET LOCAL search_path')
      .replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
      .replace(/\bCOMMIT;\s*$/, '');
    await db.exec('BEGIN;');
    await db.exec(privateSeed);
    await db.exec('SET LOCAL ROLE tdp_app_authadmin;');
    assert.deepEqual((await db.query(`SELECT count(*)::integer AS users,bool_and(role='tdp_app_authenticated') AS role_mapped,bool_and(encrypted_password LIKE '$2%') AS password_preserved FROM auth.users`)).rows[0],{users:1,role_mapped:true,password_preserved:true});
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM auth.identities')).rows[0].n,1);
    await db.exec('RESET ROLE; SET LOCAL ROLE tdp_app_owner;');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.memberships')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.workspaces')).rows[0].n,1);
    for (const table of ['documents','opportunities','proposals','jobs']) assert.equal((await db.query(`SELECT count(*)::integer AS n FROM public.${table}`)).rows[0].n,0);
    assert.deepEqual((await db.query('SELECT scheduler_enabled,email_transport_ready FROM public.operations')).rows[0],{scheduler_enabled:false,email_transport_ready:false});
    assert.deepEqual((await db.query('SELECT enabled FROM public.model_execution_settings')).rows[0],{enabled:false});
    assert.deepEqual((await db.query('SELECT stage,schema_sha256,seed_sha256 FROM app_private.deployment_restore_state')).rows[0],{stage:'seed',schema_sha256:hashes['schema.sql'],seed_sha256:hashes['seed.sql']});
    await db.exec('RESET ROLE; ROLLBACK;');
    await db.exec('SET ROLE tdp_app_owner;');
    assert.equal((await db.query('SELECT stage FROM app_private.deployment_restore_state')).rows[0].stage,'schema');
    await db.exec('RESET ROLE;');
  }
  const user = '00000000-0000-4000-8000-000000000001';
  await db.exec(`SET ROLE tdp_app_authadmin;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('${user}','owner@schema-test.invalid',now());
    INSERT INTO auth.identities(user_id,provider,identity_data) VALUES ('${user}','email','{"sub":"fixture-owner"}');
    RESET ROLE; SET ROLE tdp_app_owner;`);
  const workspace = (await db.query('SELECT public.bootstrap_workspace($1,$2) AS id',[user,'Automated catalog restore fixture'])).rows[0].id;
  await db.exec('RESET ROLE; SET ROLE tdp_app_authenticated;');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]);
  assert.equal((await db.query('SELECT id FROM public.workspaces')).rows[0].id,workspace);
  const created = (await db.query(`SELECT public.app_command('source.create',$1::jsonb,$2) AS data`,[JSON.stringify({name:'Automated manual source',kind:'manual'}),'00000000-0000-4000-8000-000000000010'])).rows[0].data;
  assert.equal(created.workspace_id,workspace);
  await assert.rejects(db.query('UPDATE public.sources SET approval=\'approved\''), error => error.code === '42501');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",['00000000-0000-4000-8000-000000000002']);
  assert.deepEqual((await db.query('SELECT id FROM public.workspaces')).rows,[]);
  await assert.rejects(db.query(`SELECT public.app_command('source.create',$1::jsonb,$2)`,[JSON.stringify({name:'Denied',kind:'manual'}),'00000000-0000-4000-8000-000000000011']), /ACCESS_PENDING/);
  await db.exec('RESET ROLE; SET ROLE tdp_app_service;');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.sources')).rows[0].n,1);
  await assert.rejects(db.exec(sql), /APPLICATION_SCHEMA_NOT_EMPTY/);
  console.log(JSON.stringify({status:'passed',engine:'PostgreSQL18',schema:manifest,private_seed_rehearsed:Boolean(process.argv[3]),checks:['full_catalog_restore','prefixed_ownership_no_bypassrls','transactional_restore_ledger_and_hashes','ledger_user_and_anon_denials','seed_checkpoint_rollback','owner_bootstrap','user_membership_read','transactional_command','direct_write_denial','outsider_denial','service_owner_read','nonempty_restore_refusal']}));
} finally {
  await db.close();
}
