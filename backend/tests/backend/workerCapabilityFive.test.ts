// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture(undefined, "20261104212818_bounded_command_batch_results.sql");
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function migrate() {
  await f.db.exec(await readFile(new URL("../../supabase/migrations/20261105120100_worker_capability_five.sql", import.meta.url), "utf8"));
}
async function enqueue(type = "analyze_chunk", checkpoint: unknown = {}) {
  return (await f.db.query<any>("insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values($1,$2,gen_random_uuid(),'synthetic-capability','queued',$3,$4::jsonb) returning *", [f.w,type,f.owner,JSON.stringify(checkpoint)])).rows[0];
}
it("preserves exact old rows across migration while fencing every fresh job from workers1–4", async () => {
  const old = await enqueue("analyze_chunk", {model_executor:2, minimum_worker_executor:4, retained_unknown_usage:true});
  await migrate();
  expect((await f.db.query<any>("select * from public.jobs where id=$1",[old.id])).rows[0]).toEqual(old);
  await f.db.query("update public.jobs set status='canceled' where id=$1",[old.id]);
  const current = await enqueue();
  expect(current.checkpoint).toEqual({minimum_worker_executor:5});
  for (const name of ["claim_backend_job","claim_backend_job_v2","claim_backend_job_v3","claim_backend_job_v4"])
    expect(await f.rpc(name)).toBeNull();
  const before=(await f.db.query<any>("select * from public.jobs where id=$1",[current.id])).rows[0];
  expect(before).toEqual(current);
  expect(await f.rpc("claim_backend_job_v5")).toMatchObject({id:current.id,attempts:1});
});
it.each(["analyze_chunk","consolidate_requirements","advance_plan","draft_section","prepare_generated_delivery","render_delivery","render_export"])("pins %s and preserves independent protocol and higher future floor", async type => {
  await migrate();
  const j=await enqueue(type,{model_executor:2,minimum_worker_executor:1,immutable:"retained"});
  expect(j.checkpoint).toEqual({model_executor:2,minimum_worker_executor:5,immutable:"retained"});
  await f.db.query("update public.jobs set checkpoint=checkpoint||'{\"minimum_worker_executor\":1}'::jsonb where id=$1",[j.id]);
  expect((await f.db.query<any>("select checkpoint from public.jobs where id=$1",[j.id])).rows[0].checkpoint).toEqual(j.checkpoint);
  const future=await enqueue(type,{model_executor:2,minimum_worker_executor:6});
  expect(future.checkpoint.minimum_worker_executor).toBe(6);
});
it("restores caller settings and local-only scope after no-work and successful claims",async()=>{
  await migrate();
  await f.db.exec("select set_config('app.worker_executor','2',true);select set_config('app.queue_local_only','false',true)");
  expect(await f.rpc("claim_backend_local_job_v5")).toBeNull();
  const j=await enqueue("advance_plan");
  expect(await f.rpc("claim_backend_local_job_v5")).toMatchObject({id:j.id});
  expect((await f.db.query<any>("select current_setting('app.worker_executor') executor,current_setting('app.queue_local_only') local_only")).rows[0]).toEqual({executor:"2",local_only:"false"});
});
it("keeps all new claim and wake functions service-only",async()=>{
  await migrate();
  for(const name of ["claim_backend_job_v5()","claim_backend_local_job_v5()","wake_backend_queue_status_v5(uuid,uuid)","wake_backend_queue_revision_v5(uuid,uuid,bigint)"]){
    const row=(await f.db.query<any>("select has_function_privilege('anon',$1,'EXECUTE') anonymous,has_function_privilege('authenticated',$1,'EXECUTE') member,has_function_privilege('service_role',$1,'EXECUTE') service",['public.'+name])).rows[0];
    expect(row).toEqual({anonymous:false,member:false,service:true});
  }
});
