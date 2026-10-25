// Real PostgreSQL execution of the production outbox SQL. Automated fixture only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
try {
  await db.exec(`
    create role fixture_service;
    create role fixture_authenticated;
    create schema app_private;
    create table app_private.dispatcher_settings(singleton boolean primary key,
      project_url text,secret_hash text,collection_hosts text[],enabled boolean,last_dispatch_at timestamptz);
    insert into app_private.dispatcher_settings values(true,'https://app.example.invalid',repeat('f',64),'{}',true,null);
    create table public.operations(scheduler_enabled boolean);
    insert into public.operations values(false);
  `);
  const sql = (await readFile(new URL("./dispatcher.sql", import.meta.url), "utf8"))
    .replaceAll(':"service_role"', '"fixture_service"');
  await db.exec(sql);
  const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0];
  const claim = () => scalar("select public.k8s_claim_dispatch()");
  const finish = (q, succeeded = true) => scalar(`select public.k8s_finish_dispatch('${q.lease}',${q.generation},${succeeded})`);
  assert.equal(await scalar("select has_function_privilege('fixture_service','public.k8s_claim_dispatch()','execute')"), true);
  assert.equal(await scalar("select has_function_privilege('fixture_authenticated','public.k8s_claim_dispatch()','execute')"), false);
  assert.equal(await scalar("select has_function_privilege('fixture_authenticated','public.configure_dispatcher(text,text[])','execute')"), false);
  const first = await claim();
  assert.equal(first.generation, 1, "periodic recovery creates a durable wake");
  assert.equal(await claim(), null, "a live dispatch lease excludes a second relay");
  await db.exec("select app_private.dispatch_backend()");
  assert.equal(await finish(first), true);
  const second = await claim();
  assert.equal(second.generation, 2, "a new wake during a lease survives its older acknowledgement");
  assert.equal(await finish(first), false, "an older receipt cannot acknowledge a new lease");
  assert.equal(await finish(second, false), true);
  assert.equal(await claim(), null, "failed dispatch waits for its backoff");
  await db.exec("update app_private.k8s_dispatch_queue set next_attempt_at='-infinity'");
  const retry = await claim();
  assert.equal(retry.generation, second.generation, "a failed dispatch retains its durable generation");
  await db.exec("update app_private.k8s_dispatch_queue set lease_until=now()-interval '1 second'");
  assert.equal(await finish(retry), false, "expired callbacks cannot commit");
  const recovered = await claim();
  assert.notEqual(recovered.lease, retry.lease, "a process crash gets a fresh lease");
  assert.equal(await finish(recovered), true);
  assert.equal(await claim(), null);
  await db.exec("update app_private.k8s_dispatch_queue set last_periodic_at=now()-interval '61 seconds'");
  const periodic = await claim();
  assert.equal(periodic.generation, 3, "periodic recovery does not depend on immediate notifications");
  await finish(periodic);
  await db.exec("update app_private.dispatcher_settings set enabled=false");
  await db.exec("select app_private.dispatch_backend()");
  assert.equal(await claim(), null, "paused dispatcher cannot acquire or enqueue a wake");
  assert.equal(await scalar("select generation from app_private.k8s_dispatch_queue"), 3);
  await db.exec("select public.configure_dispatcher('https://new.example.invalid','{official.example.invalid}')");
  assert.equal(await scalar("select enabled from app_private.dispatcher_settings"), true);
  assert.equal(await scalar("select scheduler_enabled from public.operations"), true);
  assert.equal((await claim()).generation, 4);
  console.log(JSON.stringify({ component: "kubernetes_dispatch_outbox", status: "passed", postgres: await scalar("select current_setting('server_version')") }));
} finally { await db.close(); }
