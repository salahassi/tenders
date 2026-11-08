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
  const configured = await claim();
  assert.equal(configured.generation, 4);
  await finish(configured);

  const finishV2 = (q, success, more, delay = null) => scalar(`select public.k8s_finish_dispatch_v2('${q.lease}',${q.generation},${success},${more},${delay ?? 'null'})`);
  const timers = async () => (await db.query("select dispatch_lease::text,due_at::text from app_private.k8s_dispatch_timers order by due_at,dispatch_lease")).rows;
  for (const signature of ['public.k8s_finish_dispatch_v2(uuid,bigint,boolean,boolean,integer)',
    'public.k8s_claim_maintenance()', 'public.k8s_finish_maintenance(uuid,bigint,boolean)']) {
    assert.equal(await scalar(`select has_function_privilege('fixture_service','${signature}','execute')`), true);
    assert.equal(await scalar(`select has_function_privilege('fixture_authenticated','${signature}','execute')`), false);
  }
  assert.equal(await scalar("select has_table_privilege('fixture_authenticated','app_private.k8s_dispatch_timers','select,insert,update,delete')"),false);
  assert.equal(await scalar("select relrowsecurity from pg_class where oid='app_private.k8s_dispatch_timers'::regclass"),true);
  await db.exec('select app_private.dispatch_backend()');
  const work = await claim();
  for (const [success, more, delay] of [[true,true,0],[true,true,60001],[false,true,null],[false,false,30000]])
    assert.equal(await finishV2(work,success,more,delay),false,'invalid receipt must not consume a live lease');
  assert.equal(await finishV2(work,true,true,30000),true);
  const firstTimers = await timers();
  assert.equal(firstTimers.length,1);
  assert.equal(firstTimers[0].dispatch_lease,work.lease);
  assert.equal(await scalar("select due_at>clock_timestamp()+interval '29 seconds' from app_private.k8s_dispatch_timers"),true);
  const continuation = await claim();
  assert.ok(continuation,'free capacity gets an immediate continuation, before the poll timer');
  assert.equal(await finishV2(continuation,true,false),true);
  assert.deepEqual(await timers(),firstTimers,'empty follow-up preserves the future accepted poll');
  assert.equal(await claim(),null,'waiting for a future poll must not busy-loop');
  await db.exec(sql);
  assert.deepEqual(await timers(),firstTimers,'runtime installation/restart preserves durable timer');
  await db.exec('select app_private.dispatch_backend()');
  const later = await claim();
  await finishV2(later,true,false,45000);
  const twoTimers = await timers();
  assert.equal(twoTimers.length,2,'separate pending model polls retain independent deadlines');
  assert.deepEqual(twoTimers[0],firstTimers[0],'a later timer cannot postpone the earliest wake');
  // Advance only the first synthetic deadline, without wall-clock sleeps. The
  // first poll completes and its immediate follow-up finds no work; neither may
  // discard the second remote request's still-future deadline.
  await db.exec(`update app_private.k8s_dispatch_timers set due_at=clock_timestamp()-interval '1 second' where dispatch_lease='${work.lease}'`);
  const timed = await claim();
  assert.ok(timed,'a due timer creates its own durable generation');
  assert.deepEqual(await timers(),[twoTimers[1]],'consuming the first deadline retains the later remote poll');
  await finishV2(timed,true,true);
  const emptyAfterFirstPoll = await claim();
  assert.ok(emptyAfterFirstPoll);
  await finishV2(emptyAfterFirstPoll,true,false);
  assert.equal(await claim(),null,'empty follow-up does not busy-loop while the second poll is in the future');
  assert.deepEqual(await timers(),[twoTimers[1]]);
  await db.exec(sql);
  assert.deepEqual(await timers(),[twoTimers[1]],'restart after the first poll preserves the second deadline');
  await db.exec(`update app_private.k8s_dispatch_timers set due_at=clock_timestamp()-interval '1 second' where dispatch_lease='${later.lease}'`);
  const secondPoll = await claim();
  assert.ok(secondPoll,'the later deadline wakes independently without waiting for periodic recovery');
  assert.deepEqual(await timers(),[]);
  await db.exec('select app_private.dispatch_backend()');
  assert.equal(await finishV2(secondPoll,true,false),true);
  const simultaneous = await claim();
  assert.ok(simultaneous,'a new wake during timed dispatch survives acknowledgement');
  assert.equal(await finishV2(timed,true,true,1000),false,'stale timer callbacks cannot schedule new work');
  assert.deepEqual(await timers(),[]);
  await finishV2(simultaneous,true,false);
  await db.exec('select app_private.dispatch_backend()');
  const newTimer = await claim();
  await finishV2(newTimer,true,true,30000);
  const activeWhenDue = await claim();
  await db.exec("update app_private.k8s_dispatch_timers set due_at=clock_timestamp()-interval '1 second'");
  assert.equal(await claim(),null,'a due timer cannot break another live lease');
  assert.deepEqual(await timers(),[]);
  await finishV2(activeWhenDue,true,false);
  const retainedDue = await claim();
  assert.ok(retainedDue,'timer generation survives acknowledgement of the preceding live lease');
  await finishV2(retainedDue,true,false);

  const maintenanceClaim = () => scalar('select public.k8s_claim_maintenance()');
  const maintenanceFinish = (q, succeeded) => scalar(`select public.k8s_finish_maintenance('${q.lease}',${q.generation},${succeeded})`);
  const maintenance = await maintenanceClaim();
  assert.ok(maintenance);
  assert.equal(await maintenanceClaim(),null,'one maintenance lease excludes overlap');
  await db.exec('select app_private.dispatch_backend()');
  const duringMaintenance = await claim();
  assert.ok(duringMaintenance,'maintenance lease cannot occupy foreground dispatch');
  await finishV2(duringMaintenance,true,false);
  await db.exec("update app_private.k8s_maintenance_queue set lease_until=clock_timestamp()-interval '1 second'");
  assert.equal(await maintenanceFinish(maintenance,true),false,'expired maintenance cannot acknowledge');
  const recoveredMaintenance = await maintenanceClaim();
  assert.notEqual(recoveredMaintenance.lease,maintenance.lease,'crashed housekeeping is recoverable with new ownership');
  assert.equal(await maintenanceFinish(maintenance,true),false);
  assert.equal(await maintenanceFinish(recoveredMaintenance,false),true);
  assert.equal(await maintenanceClaim(),null,'maintenance failures retain bounded backoff');
  await db.exec("update app_private.k8s_maintenance_queue set next_attempt_at='-infinity'");
  assert.equal(await maintenanceFinish(await maintenanceClaim(),true),true);
  assert.equal(await scalar("select next_attempt_at>clock_timestamp()+interval '59 seconds' from app_private.k8s_maintenance_queue"),true);
  assert.equal(await maintenanceClaim(),null);
  await db.exec("update app_private.dispatcher_settings set enabled=false;update app_private.k8s_maintenance_queue set next_attempt_at='-infinity'");
  assert.equal(await maintenanceClaim(),null,'paused dispatcher also pauses maintenance');
  console.log(JSON.stringify({ component: "kubernetes_dispatch_outbox", status: "passed", postgres: await scalar("select current_setting('server_version')") }));
} finally { await db.close(); }
