// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.query(
    `insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by,max_parallel_requests)
    values($1,true,now(),$2,2) on conflict(workspace_id) do update set max_parallel_requests=2`,
    [f.w, f.owner],
  );
  await f.db.query(
    "insert into app_private.queue_dispatch_state(workspace_id,cursor) values($1,5)",
    [f.w],
  );
  await f.db.query(
    "insert into app_private.queue_model_admission_state(workspace_id,next_class) values($1,'background')",
    [f.w],
  );
});
afterEach(async () => f.db.exec("rollback"));

async function enqueue(type: string, entity = crypto.randomUUID()) {
  return (
    await f.db.query<any>(
      `insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status,checkpoint)
    values($1,$2,$3,'synthetic-admission',$4,'queued','{"model_executor":2}') returning *`,
      [f.w, type, entity, f.owner],
    )
  ).rows[0];
}
async function pending(id: string) {
  await f.db.query(
    `update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',
    next_attempt_at=now()+interval '1 minute',lease_token=null,lease_until=null where id=$1`,
    [id],
  );
}
async function due(id: string) {
  await f.db.query(
    "update public.jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [id],
  );
}
async function finish(id: string) {
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null where id=$1",
    [id],
  );
}
async function reserve(id: string, deadlineHours = 23) {
  const usage = (
    await f.db.query<any>(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,
    settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_project_ref,remote_deadline,created_by)
    values($1,$2::uuid,gen_random_uuid(),$2::uuid::text,'openai','synthetic-model',repeat('a',64),current_date,
    1,100,100,'reserved','synthetic-'||$2::uuid::text,'synthetic-project',now()+make_interval(hours=>$4),$3) returning *`,
      [f.w, id, f.owner, deadlineHours],
    )
  ).rows[0];
  await pending(id);
  return usage;
}
async function state() {
  return (
    await f.db.query<any>(
      "select next_class,dispatch_count::int from app_private.queue_model_admission_state where workspace_id=$1",
      [f.w],
    )
  ).rows[0];
}
async function claim(id: string | null) {
  const result = await f.rpc("claim_backend_job_v2");
  expect(result?.id ?? null).toBe(id);
  return result;
}
async function proposal() {
  const source = (
    await f.db.query<any>(
      "insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic source','manual',$2) returning id",
      [f.w, f.owner],
    )
  ).rows[0];
  const opportunity = (
    await f.db.query<any>(
      "insert into public.opportunities(workspace_id,source_id,title,created_by) values($1,$2,'Synthetic buyer',$3) returning id",
      [f.w, source.id, f.owner],
    )
  ).rows[0];
  const plan = (
    await f.db.query<any>(
      `insert into public.generation_plans(workspace_id,opportunity_id,kind,status,stage,input_hash,frozen_context,evidence_revision,created_by)
    values($1,$2,'proposal','blocked','analysis',repeat('a',64),'{}',1,$3) returning id`,
      [f.w, opportunity.id, f.owner],
    )
  ).rows[0];
  const job = await enqueue("analyze_chunk", plan.id);
  await f.db.query(
    `insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
    values($1,$2,$3,'analyze_chunk','analysis',1,'{}',$4)`,
    [f.w, plan.id, job.id, f.owner],
  );
  await pending(job.id);
  await due(job.id);
  return job;
}

it.each(["unknown", "settled"])(
  "retains proposal admission through the exact accepted-poll capacity cycle after %s release",
  async (release) => {
    const target = await proposal();
    const accepted = await enqueue("classify_opportunity");
    const retainedUsage = await reserve(accepted.id);
    const background = await enqueue("classify_opportunity");
    await due(accepted.id);
    await claim(background.id); // slot 5, the one free provider slot
    await reserve(background.id);
    expect(await state()).toEqual({
      next_class: "proposal",
      dispatch_count: 1,
    });
    await claim(accepted.id); // slot 1; capacity full, accepted remote stays reserved
    await pending(accepted.id);
    await claim(null);
    await due(background.id);
    await claim(background.id); // slot 4 after the full-capacity proposal slot
    await f.db.query(
      "update public.provider_usage set state=$2,error_code=case when $2='unknown' then 'PROVIDER_BACKGROUND_TERMINATED' end where job_id=$1",
      [background.id, release],
    );
    await f.db.query(
      "update public.jobs set status='blocked',lease_token=null,lease_until=null where id=$1",
      [background.id],
    );
    expect(
      (
        await f.db.query<any>(
          "select cursor%6 slot from app_private.queue_dispatch_state where workspace_id=$1",
          [f.w],
        )
      ).rows[0].slot,
    ).toBe(5);
    const arriving = await enqueue("classify_opportunity");
    await due(accepted.id);
    await claim(accepted.id); // keep ordinary slot/deadline service
    await pending(accepted.id);
    await claim(target.id); // new background can no longer steal the free slot
    expect(await state()).toEqual({
      next_class: "background",
      dispatch_count: 2,
    });
    expect(
      (
        await f.db.query<any>("select attempts from public.jobs where id=$1", [
          arriving.id,
        ])
      ).rows[0].attempts,
    ).toBe(0);
    expect(
      (
        await f.db.query("select * from public.provider_usage where id=$1", [
          retainedUsage.id,
        ])
      ).rows[0],
    ).toEqual(retainedUsage);
    const released = (
      await f.db.query<any>(
        "select state,remote_request_id,remote_project_ref,error_code from public.provider_usage where job_id=$1",
        [background.id],
      )
    ).rows[0];
    expect(released).toMatchObject({
      state: release,
      remote_request_id: "synthetic-" + background.id,
      remote_project_ref: "synthetic-project",
    });
    if (release === "unknown")
      expect(released.error_code).toBe("PROVIDER_BACKGROUND_TERMINATED");
  },
);

it.each([1, 2])(
  "preserves model admission at capacity %i while local work and polls continue",
  async (limit) => {
    await f.db.query(
      "update public.model_execution_settings set max_parallel_requests=$2 where workspace_id=$1",
      [f.w, limit],
    );
    const accepted = [];
    for (let i = 0; i < limit; i++) {
      const j = await enqueue("classify_opportunity");
      await reserve(j.id);
      accepted.push(j);
    }
    const target = await enqueue("draft_section");
    const local = await enqueue("advance_plan");
    const before = await state();
    const cursor = (
      await f.db.query<any>(
        "select cursor from app_private.queue_dispatch_state where workspace_id=$1",
        [f.w],
      )
    ).rows[0].cursor;
    expect((await f.rpc("claim_backend_local_job")).id).toBe(local.id);
    expect(await state()).toEqual(before);
    expect(
      (
        await f.db.query<any>(
          "select cursor from app_private.queue_dispatch_state where workspace_id=$1",
          [f.w],
        )
      ).rows[0].cursor,
    ).toBe(cursor);
    await finish(local.id);
    await claim(null);
    await due(accepted[0].id);
    await claim(accepted[0].id);
    await pending(accepted[0].id);
    expect(await state()).toEqual(before);
    await f.db.query(
      "update public.provider_usage set state='settled' where job_id=$1",
      [accepted[0].id],
    );
    await finish(accepted[0].id);
    await claim(target.id); // preferred background has no eligible new model work
    expect(await state()).toEqual({
      next_class: "background",
      dispatch_count: 1,
    });
  },
);

it.each(["source_collect", "source_candidates", "cancel", "notice"])(
  "capacity-free %s work neither consumes credit nor creates a false preferred candidate",
  async (kind) => {
    await f.db.query(
      "update app_private.queue_model_admission_state set next_class='background' where workspace_id=$1",
      [f.w],
    );
    let exempt;
    if (kind === "notice") {
      const target = await proposal();
      const plan = target.entity_id;
      await f.db.query("delete from public.generation_steps where job_id=$1", [
        target.id,
      ]);
      await f.db.query("delete from public.jobs where id=$1", [target.id]);
      await f.db.query(
        "update public.generation_plans set kind='assessment',stage='assessment' where id=$1",
        [plan],
      );
      await f.db.query(
        'update public.sources set adapter_config=\'{"official_listing":"synthetic"}\' where id=(select o.source_id from public.opportunities o join public.generation_plans p on p.opportunity_id=o.id where p.id=$1)',
        [plan],
      );
      exempt = await enqueue("classify_opportunity", plan);
      expect(
        (
          await f.db.query<any>(
            "select app_private.queue_needs_notice_details(j) needed from public.jobs j where id=$1",
            [exempt.id],
          )
        ).rows[0].needed,
      ).toBe(true);
    } else {
      exempt = await enqueue(kind === "cancel" ? "classify_opportunity" : kind);
      if (kind === "cancel")
        await f.db.query(
          "update public.jobs set cancel_requested=true where id=$1",
          [exempt.id],
        );
    }
    const target = await enqueue("draft_section");
    const before = await state();
    await claim(kind === "cancel" ? null : exempt.id);
    expect(await state()).toEqual(before);
    if (kind === "cancel")
      expect(
        (
          await f.db.query<any>("select status from public.jobs where id=$1", [
            exempt.id,
          ])
        ).rows[0].status,
      ).toBe("canceled");
    else await finish(exempt.id);
    await claim(target.id);
    expect(await state()).toEqual({
      next_class: "background",
      dispatch_count: 1,
    });
  },
);

it.each(["future", "executor"])(
  "an ineligible preferred %s candidate cannot suppress another class",
  async (reason) => {
    const background = await enqueue("classify_opportunity");
    if (reason === "future")
      await f.db.query(
        "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
        [background.id],
      );
    else
      await f.db.query(
        "update public.jobs set checkpoint='{\"model_executor\":3}' where id=$1",
        [background.id],
      );
    const target = await enqueue("draft_section");
    await claim(target.id);
    expect(await state()).toEqual({
      next_class: "background",
      dispatch_count: 1,
    });
  },
);

it("keeps admission state private with RLS enabled and no browser or service grants", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect(
      (
        await f.db.query<any>(
          "select has_table_privilege($1,'app_private.queue_model_admission_state','SELECT,INSERT,UPDATE,DELETE') allowed",
          [role],
        )
      ).rows[0].allowed,
    ).toBe(false);
  }
  expect(
    (
      await f.db.query<any>(
        "select relrowsecurity from pg_class where oid='app_private.queue_model_admission_state'::regclass",
      )
    ).rows[0].relrowsecurity,
  ).toBe(true);
});
