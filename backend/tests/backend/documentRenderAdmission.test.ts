// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
  await f.db.exec(
    `create table app_private.test_render_dispatches(id bigint generated always as identity);create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$begin insert into app_private.test_render_dispatches default values;end$$;`,
  );
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.exec(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled) values(true,'https://synthetic.supabase.co','synthetic',true)",
  );
});
afterEach(async () => f.db.exec("rollback"));
async function row(sql: string, args: unknown[] = []) {
  return (await f.db.query<any>(sql, args)).rows[0];
}
async function enqueue(
  type: string,
  status = "queued",
  checkpoint: Record<string, unknown> = {
    model_executor: 4,
    minimum_worker_executor: 4,
  },
) {
  return row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values($1,$2,$3,'synthetic-render-admission',$4,$5,$6) returning *",
    [
      f.w,
      type,
      crypto.randomUUID(),
      status,
      f.owner,
      JSON.stringify(checkpoint),
    ],
  );
}
async function finish(id: string) {
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null,revision=revision+1 where id=$1",
    [id],
  );
}
async function claim() {
  return f.rpc("claim_backend_job_v5");
}
async function wake(id: string) {
  return f.rpc("wake_backend_queue_status_v5", [id, crypto.randomUUID()]);
}
async function poll() {
  const j = await enqueue("draft_section", "retry_wait");
  await f.db.query(
    "update public.jobs set error_code='MODEL_IN_PROGRESS' where id=$1",
    [j.id],
  );
  await f.db.query(
    "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by) values($1,$2::uuid,gen_random_uuid(),$2::uuid::text,'openai','synthetic',repeat('a',64),current_date,1,100,100,'reserved','synthetic-accepted',now()+interval '1 hour',$3)",
    [f.w, j.id, f.owner],
  );
  return j;
}
it.each(["render_delivery", "render_export"])(
  "admits only one %s/mixed renderer lease without consuming queued attempts",
  async (type) => {
    const first = await enqueue(type);
    const second = await enqueue(
      type === "render_delivery" ? "render_export" : "render_delivery",
    );
    const active = await claim();
    expect([first.id, second.id]).toContain(active.id);
    const waiting = active.id === first.id ? second : first;
    const before = await row(
      "select to_jsonb(j) value from public.jobs j where id=$1",
      [waiting.id],
    );
    for (let i = 0; i < 12; i++) expect(await claim()).toBeNull();
    expect(
      await row("select to_jsonb(j) value from public.jobs j where id=$1", [
        waiting.id,
      ]),
    ).toEqual(before);
    expect(
      (
        await row(
          "select app_private.document_render_slot_available() available",
        )
      ).available,
    ).toBe(false);
    await finish(active.id);
    expect((await claim()).id).toBe(waiting.id);
  },
);
it.each(["model", "poll", "projection"])(
  "allows one %s wake and claim while rendering, preserving the existing non-render lane",
  async (kind) => {
    const render = await enqueue("render_export");
    expect((await claim()).id).toBe(render.id);
    const completed = await enqueue("advance_plan", "succeeded");
    const next =
      kind === "poll"
        ? await poll()
        : await enqueue(
            kind === "model" ? "model_probe" : "prepare_generated_delivery",
          );
    const another = await enqueue(
      kind === "model" ? "model_probe" : "prepare_generated_delivery",
    );
    expect(await wake(completed.id)).toMatchObject({ dispatched: true });
    const working = await claim();
    expect([next.id, another.id]).toContain(working.id);
    const waiting = working.id === next.id ? another : next;
    expect(await claim()).toBeNull();
    expect(
      await row(
        "select attempts,failure_count,status from public.jobs where id=$1",
        [waiting.id],
      ),
    ).toEqual({
      attempts: 0,
      failure_count: 0,
      status:
        kind === "poll" && waiting.id === next.id ? "retry_wait" : "queued",
    });
    await finish(working.id);
    expect((await claim()).id).toBe(waiting.id);
    expect(
      (await row("select status from public.jobs where id=$1", [render.id]))
        .status,
    ).toBe("running");
  },
);
it("admits rendering alongside one model lease and preserves old executor exclusion", async () => {
  const model = await enqueue("model_probe");
  expect((await claim()).id).toBe(model.id);
  const render = await enqueue("render_export");
  expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  expect(await f.rpc("claim_backend_job_v3")).toBeNull();
  expect((await claim()).id).toBe(render.id);
  const extra = await enqueue("model_probe");
  expect(await claim()).toBeNull();
  expect(
    (await row("select attempts from public.jobs where id=$1", [extra.id]))
      .attempts,
  ).toBe(0);
});
it("does not wake solely occupied render work but permits it after completion", async () => {
  const first = await enqueue("render_delivery");
  expect((await claim()).id).toBe(first.id);
  await enqueue("render_export");
  const done = await enqueue("advance_plan", "succeeded");
  expect(await wake(done.id)).toEqual({ dispatched: false });
  expect(
    (
      await row(
        "select count(*)::int n from app_private.test_render_dispatches",
      )
    ).n,
  ).toBe(0);
  await finish(first.id);
  expect(await wake(done.id)).toEqual({ dispatched: true });
});
it("preserves model reservation capacity when an independent render slot is free", async () => {
  const p = await poll();
  await f.db.query(
    "update public.jobs set next_attempt_at=now()+interval '1 hour' where id=$1",
    [p.id],
  );
  const model = await enqueue("model_probe");
  const render = await enqueue("render_export");
  expect((await claim()).id).toBe(render.id);
  expect(await claim()).toBeNull();
  expect(
    (await row("select attempts from public.jobs where id=$1", [model.id]))
      .attempts,
  ).toBe(0);
  expect(
    (
      await row(
        "select count(*)::int n from public.provider_usage where state='reserved'",
      )
    ).n,
  ).toBe(1);
});
it("recovers an expired render lease without admitting a second valid render lease", async () => {
  const one = await enqueue("render_export"),
    two = await enqueue("render_delivery");
  const active = await claim();
  await f.db.query(
    "update public.jobs set lease_until=now()-interval '1 second' where id=$1",
    [active.id],
  );
  const recovered = await claim();
  expect([one.id, two.id]).toContain(recovered.id);
  expect(
    (
      await row(
        "select count(*)::int n from public.jobs where status='running' and type in ('render_delivery','render_export') and lease_until>clock_timestamp() and lease_token is not null",
      )
    ).n,
  ).toBe(1);
  expect(await claim()).toBeNull();
});

it("drains twelve accepted packages without spending waiting attempts or renewing their 600-second clocks", async () => {
  // SQL admission simulation: synthetic verified storage receipts deliberately
  // isolate queue semantics. Actual DOCX bytes have separate pipeline coverage.
  const packages = [];
  for (let i = 0; i < 12; i++) {
    const data = await commercialHelpers(f).setup();
    await f.db.query(
      "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
      [data.plan],
    );
    packages.push(
      await f.command("export.package.prepare", {
        proposal_version_id: data.version,
        expected_revision: 1,
        mode: "draft",
      }),
    );
  }
  const clocks = (
    await f.db.query(
      "select id,accepted_at,deadline_at,extract(epoch from deadline_at-accepted_at)::int seconds from public.export_packages order by id",
    )
  ).rows;
  expect(clocks).toHaveLength(12);
  expect(clocks.every((p: any) => p.seconds === 600)).toBe(true);
  const claimed = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const job = await claim();
    expect(job.type).toBe("render_export");
    expect(claimed.has(job.id)).toBe(false);
    claimed.add(job.id);
    expect(job.attempts).toBe(1);
    const waiting = (
      await f.db.query(
        "select to_jsonb(j) value from public.jobs j where type='render_export' and status='queued' order by id",
      )
    ).rows;
    expect(waiting).toHaveLength(11 - i);
    for (let probe = 0; probe < 3; probe++) expect(await claim()).toBeNull();
    expect(
      (
        await f.db.query(
          "select to_jsonb(j) value from public.jobs j where type='render_export' and status='queued' order by id",
        )
      ).rows,
    ).toEqual(waiting);
    expect(
      waiting.every(
        (r: any) =>
          r.value.attempts === 0 &&
          r.value.failure_count === 0 &&
          r.value.lease_token === null,
      ),
    ).toBe(true);
    await f.rpc("export_render_context", [job.id, job.lease_token]);
    const slot = await row(
      "select id from public.export_package_volumes where package_id=$1",
      [job.entity_id],
    );
    await f.rpc("complete_export_package_volume", [
      job.id,
      job.lease_token,
      slot.id,
      "a".repeat(64),
      100,
    ]);
    await f.rpc("finish_export_package", [job.id, job.lease_token]);
  }
  expect(await claim()).toBeNull();
  expect(
    (
      await f.db.query(
        "select id,accepted_at,deadline_at,extract(epoch from deadline_at-accepted_at)::int seconds from public.export_packages order by id",
      )
    ).rows,
  ).toEqual(clocks);
  expect(
    (
      await row(
        "select count(*)::int n from public.export_packages where status='ready'",
      )
    ).n,
  ).toBe(12);
  expect(
    (await row("select count(*)::int n from public.provider_usage")).n,
  ).toBe(0);
});

it("expires a package still waiting for the render lane without claiming it or resetting its deadline", async () => {
  const render = await enqueue("render_delivery");
  expect((await claim()).id).toBe(render.id);
  const data = await commercialHelpers(f).setup();
  await f.db.query(
    "update public.generation_plans set frozen_context=app_private.delivery_input(workspace_id,opportunity_id) where id=$1",
    [data.plan],
  );
  const p = await f.command("export.package.prepare", {
    proposal_version_id: data.version,
    expected_revision: 1,
    mode: "draft",
  });
  await f.db.query(
    "with t as (select clock_timestamp()-interval '601 seconds' accepted) update public.export_packages set accepted_at=t.accepted,deadline_at=t.accepted+interval '600 seconds' from t where id=$1",
    [p.id],
  );
  const before = await row(
    "select accepted_at,deadline_at from public.export_packages where id=$1",
    [p.id],
  );
  expect(await claim()).toBeNull();
  expect(
    await row(
      "select status,error_code,attempts from public.jobs where entity_id=$1",
      [p.id],
    ),
  ).toEqual({
    status: "failed",
    error_code: "EXPORT_ISSUANCE_TIMEOUT",
    attempts: 0,
  });
  expect(
    await row(
      "select accepted_at,deadline_at from public.export_packages where id=$1",
      [p.id],
    ),
  ).toEqual(before);
});
