// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const row = async (sql: string, args: unknown[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
async function attempt<T>(run: () => Promise<T>) {
  await f.db.exec("savepoint expected_error");
  try {
    return await run();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected_error");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected_error");
  }
}
async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic deadline source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic deadline proposal",
    reference: "SYNTHETIC",
    description: "Deliver a documented approval workflow.",
    language: "en",
    decision: "shortlisted",
  });
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
  });
  const accepted = await f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    "a".repeat(64),
    100,
    "Implement an approval workflow and provide handover documentation.",
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: accepted.id,
    expected_revision: accepted.revision,
  });
  const input = { id: opportunity.id, expected_revision: opportunity.revision },
    key = crypto.randomUUID();
  const result = await f.command("proposal.generate", input, key);
  const p = await row("select * from public.generation_plans where id=$1", [
    result.id,
  ]);
  const request = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [p.issuance_request_id],
  );
  const job = await row(
    "select j.* from public.jobs j join public.generation_steps s on s.job_id=j.id where s.plan_id=$1 order by s.ordinal limit 1",
    [p.id],
  );
  return { p, request, job, input, key, opportunity };
}
// Test-only owner inserts a fresh, already-aged authorization. Production has
// no client clock parameter, and its immutable accepted_at cannot be edited.
async function aged(p: any, age: number) {
  await f.db.query(
    "update public.proposal_issuance_requests set outcome='failed',error_code='SYNTHETIC_SUPERSEDED',completed_at=clock_timestamp() where id=$1",
    [p.issuance_request_id],
  );
  const r = await row(
    `insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at)
 select $1,$2,$3,'generation.retry',$4,t,t+interval '600 seconds' from (select clock_timestamp()-make_interval(secs=>$5) t) c returning *`,
    [f.w, p.id, f.owner, crypto.randomUUID(), age],
  );
  await f.db.query(
    "update public.generation_plans set issuance_request_id=$2 where id=$1",
    [p.id, r.id],
  );
  await f.db.exec("select set_config('app.issuance_authorizing','true',true)");
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||jsonb_build_object('issuance_request_id',$2::uuid) where entity_id=$1 or entity_id in(select id from public.proposal_delivery_snapshots where plan_id=$1)",
    [p.id, r.id],
  );
  await f.db.exec("select set_config('app.issuance_authorizing','',true)");
  return r;
}
it("accepts one immutable 600-second authorization; replay does not extend it or mutate paid input", async () => {
  const x = await setup();
  expect(
    (
      await row(
        "select extract(epoch from deadline_at-accepted_at) seconds from public.proposal_issuance_requests where id=$1",
        [x.request.id],
      )
    ).seconds,
  ).toBe("600.000000");
  expect(x.job.checkpoint).toMatchObject({
    issuance_request_id: x.request.id,
    issuance_deadline_version: 1,
    minimum_worker_executor: 4,
  });
  await f.command("proposal.generate", x.input, x.key);
  expect(
    (
      await f.db.query(
        "select * from public.proposal_issuance_requests where plan_id=$1",
        [x.p.id],
      )
    ).rows,
  ).toEqual([x.request]);
  expect(
    await row(
      "select frozen_context,input_hash from public.generation_plans where id=$1",
      [x.p.id],
    ),
  ).toEqual({ frozen_context: x.p.frozen_context, input_hash: x.p.input_hash });
  await expect(
    attempt(() =>
      f.db.query(
        "update public.proposal_issuance_requests set accepted_at=accepted_at+interval '1 second',deadline_at=deadline_at+interval '1 second' where id=$1",
        [x.request.id],
      ),
    ),
  ).rejects.toThrow("ISSUANCE_IDENTITY_IMMUTABLE");
});
it.each([
  [599.999, false],
  [600, true],
  [600.001, true],
])(
  "uses actual SQL clock arithmetic at %s seconds, expired=%s",
  async (seconds, expired) => {
    const x = await row(
      "with accepted as(select clock_timestamp() t) select app_private.issuance_deadline_reached(t+interval '600 seconds',t+make_interval(secs=>$1)) expired from accepted",
      [seconds],
    );
    expect(x.expired).toBe(expired);
  },
);
it("expires queue dwell and render retries without altering accepted remote usage or historical source bytes", async () => {
  const x = await setup();
  const r = await aged(x.p, 601);
  await f.db.query(
    "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by) values($1,$2,gen_random_uuid(),'synthetic-pending','openai','synthetic-model',$3,current_date,1,100,100,'unknown','synthetic-remote',now()+interval '10 minutes',$4)",
    [f.w, x.job.id, x.p.input_hash, f.owner],
  );
  const usage = await row(
    "select * from public.provider_usage where job_id=$1",
    [x.job.id],
  );
  await f.db.query(
    "update public.jobs set status='retry_wait',next_attempt_at=now()+interval '8 minutes' where entity_id in(select id from public.proposal_delivery_snapshots where plan_id=$1)",
    [x.p.id],
  );
  await f.rpc("claim_backend_job_v3");
  expect(
    await row(
      "select outcome,error_code,completed_at=deadline_at precise from public.proposal_issuance_requests where id=$1",
      [r.id],
    ),
  ).toEqual({
    outcome: "failed",
    error_code: "PROPOSAL_ISSUANCE_TIMEOUT",
    precise: true,
  });
  expect(
    (
      await row(
        "select count(*) n from public.jobs where checkpoint->>'issuance_request_id'=$1 and status in('queued','running','retry_wait','quota_wait','blocked')",
        [r.id],
      )
    ).n,
  ).toBe(0);
  expect(
    await row("select * from public.provider_usage where job_id=$1", [
      x.job.id,
    ]),
  ).toEqual(usage);
  expect(
    await row(
      "select frozen_context,input_hash from public.generation_plans where id=$1",
      [x.p.id],
    ),
  ).toEqual({ frozen_context: x.p.frozen_context, input_hash: x.p.input_hash });
  await expect(
    attempt(() =>
      f.rpc("reserve_task_model_call", [
        x.job.id,
        crypto.randomUUID(),
        "synthetic-late",
        x.p.input_hash,
        10,
        10,
        "[]",
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]),
    ),
  ).rejects.toThrow("PROPOSAL_ISSUANCE_TIMEOUT");
});
it("reports timeout on the member view before a queue sweep", async () => {
  const x = await setup();
  const r = await aged(x.p, 601);
  expect(
    await row(
      "select outcome,effective_outcome,effective_error_code from public.proposal_issuance_status where id=$1",
      [r.id],
    ),
  ).toEqual({
    outcome: "active",
    effective_outcome: "failed",
    effective_error_code: "PROPOSAL_ISSUANCE_TIMEOUT",
  });
});
it("old workers cannot claim newly pinned normal jobs or children; executor4 can, without changing routing protocol2", async () => {
  const x = await setup();
  await f.db.query("update public.jobs set status='canceled' where id<>$1", [
    x.job.id,
  ]);
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint||'{\"model_executor\":2}'::jsonb where id=$1",
    [x.job.id],
  );
  for (const fn of [
    "claim_backend_job",
    "claim_backend_job_v2",
    "claim_backend_job_v3",
  ])
    expect(await f.rpc(fn)).toBeNull();
  await f.db.exec("select set_config('app.worker_executor','4',true)");
  const j = await f.rpc("claim_backend_job");
  expect(j.id).toBe(x.job.id);
  expect(j.checkpoint.model_executor).toBe(2);
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null where id=$1",
    [j.id],
  );
  const child = await row(
    "select app_private.enqueue_generation(p,'analyze_chunk','{}',0) id from public.generation_plans p where id=$1",
    [x.p.id],
  );
  expect(
    (await row("select checkpoint from public.jobs where id=$1", [child.id]))
      .checkpoint,
  ).toMatchObject({
    minimum_worker_executor: 4,
    issuance_request_id: x.request.id,
  });
  await f.db.exec("select set_config('app.worker_executor','3',true)");
  expect(await f.rpc("claim_backend_job")).toBeNull();
});
it("pins source/repair/consistency contracts before claim even without an issuance request", async () => {
  const x = await setup();
  await f.db.query(
    "update public.generation_plans set issuance_request_id=null,frozen_context=frozen_context||'{\"source_contract_version\":1}'::jsonb where id=$1",
    [x.p.id],
  );
  await f.db.query(
    "update public.jobs set status='canceled' where workspace_id=$1",
    [f.w],
  );
  const child = await row(
    "select app_private.enqueue_generation(p,'analyze_chunk','{}',0) id from public.generation_plans p where id=$1",
    [x.p.id],
  );
  expect(
    (await row("select checkpoint from public.jobs where id=$1", [child.id]))
      .checkpoint.minimum_worker_executor,
  ).toBe(4);
  expect(await f.rpc("claim_backend_job_v3")).toBeNull();
});
it("returns known terminal model failure early, preserving unknown usage, and never retries it automatically", async () => {
  const x = await setup();
  const j = await row(
    "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
    [x.job.id],
  );
  await f.rpc("fail_generation", [
    j.id,
    j.lease_token,
    "AI_AGENTS_UNAVAILABLE",
    null,
    null,
  ]);
  expect(
    await row(
      "select outcome,error_code,completed_at<deadline_at early from public.proposal_issuance_requests where id=$1",
      [x.request.id],
    ),
  ).toEqual({
    outcome: "failed",
    error_code: "AI_AGENTS_UNAVAILABLE",
    early: true,
  });
  expect(
    (await row("select status from public.jobs where id=$1", [j.id])).status,
  ).toBe("failed");
});
it("ignores independent manually prepared render jobs and rejects partial templates as issuance", async () => {
  const x = await setup();
  const snapshot = await f.command("delivery.snapshot.prepare", {
    opportunity_id: x.opportunity.id,
    expected_revision: x.opportunity.revision,
  });
  await expect(
    attempt(() =>
      f.db.query("select app_private.complete_proposal_issuance($1,$2)", [
        x.request.id,
        snapshot.id,
      ]),
    ),
  ).rejects.toThrow("PROPOSAL_ISSUANCE_INCOMPLETE");
  const manual = await row(
    "select * from public.jobs where type='render_delivery' and entity_id=$1",
    [snapshot.id],
  );
  if (snapshot.plan_id === null)
    expect(manual.checkpoint.issuance_request_id).toBeUndefined();
});
it("registers historical issuance metadata in recovery and does not mutate state when calculating a purge manifest", async () => {
  const x = await setup();
  expect(
    (await row("select app_private.backup_tables() names")).names,
  ).toContain("proposal_issuance_requests");
  const result = await row("select app_private.purge_scope($1,$2) scope", [
    f.w,
    x.opportunity.id,
  ]);
  expect(result.scope.proposal_issuance_requests.ids).toEqual([x.request.id]);
  expect(
    await row("select * from public.proposal_issuance_requests where id=$1", [
      x.request.id,
    ]),
  ).toEqual(x.request);
});

it("returns server time and effective timeout only to a current member", async () => {
  const x = await setup();
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  const status = await f.rpc("proposal_issuance_status_for_plan", [x.p.id]);
  expect(status).toMatchObject({
    id: x.request.id,
    effective_outcome: "active",
    deadline_version: 1,
  });
  expect(Number.isFinite(Date.parse(status.server_now))).toBe(true);
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    crypto.randomUUID(),
  ]);
  await expect(
    attempt(() => f.rpc("proposal_issuance_status_for_plan", [x.p.id])),
  ).rejects.toThrow("NOT_FOUND");
});
it("creates a fresh authorized request on explicit retry while retaining old immutable deadlines and graph input", async () => {
  const x = await setup();
  const j = await row(
    "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
    [x.job.id],
  );
  await f.rpc("fail_generation", [
    j.id,
    j.lease_token,
    "AI_AGENTS_UNAVAILABLE",
    null,
    null,
  ]);
  const p = await row("select * from public.generation_plans where id=$1", [
    x.p.id,
  ]);
  const input = {
      id: p.id,
      expected_revision: p.revision,
      reason: "Synthetic explicit retry",
    },
    key = crypto.randomUUID();
  await f.command("generation.retry", input, key);
  const current = await row(
    "select * from public.generation_plans where id=$1",
    [x.p.id],
  );
  expect(current.issuance_request_id).not.toBe(x.request.id);
  expect(current.input_hash).toBe(x.p.input_hash);
  expect(current.frozen_context).toEqual(x.p.frozen_context);
  expect(
    await row(
      "select accepted_at,deadline_at from public.proposal_issuance_requests where id=$1",
      [x.request.id],
    ),
  ).toEqual({
    accepted_at: x.request.accepted_at,
    deadline_at: x.request.deadline_at,
  });
  const newRequest = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [current.issuance_request_id],
  );
  await f.command("generation.retry", input, key);
  expect(
    await row("select * from public.proposal_issuance_requests where id=$1", [
      current.issuance_request_id,
    ]),
  ).toEqual(newRequest);
  expect(
    (await row("select checkpoint from public.jobs where id=$1", [j.id]))
      .checkpoint,
  ).toMatchObject({
    issuance_request_id: current.issuance_request_id,
    minimum_worker_executor: 4,
  });
  expect(await f.rpc("claim_backend_job_v3")).toBeNull();
});

it("keeps optional partial-draft render failures independent of viable automatic generation", async () => {
  const x = await setup();
  const render = await row(
    "update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where type='render_delivery' and entity_id in(select id from public.proposal_delivery_snapshots where plan_id=$1) returning *",
    [x.p.id],
  );
  await f.rpc("fail_delivery_export", [
    render.id,
    render.lease_token,
    "DELIVERY_ARTIFACT_INVALID",
  ]);
  expect(
    (
      await row(
        "select outcome from public.proposal_issuance_requests where id=$1",
        [x.request.id],
      )
    ).outcome,
  ).toBe("active");
  expect(await f.rpc("claim_backend_job_v3")).toBeNull();
  expect(
    (
      await row(
        "select outcome from public.proposal_issuance_requests where id=$1",
        [x.request.id],
      )
    ).outcome,
  ).toBe("active");
  await f.db.exec("select set_config('app.worker_executor','4',true)");
  expect((await f.rpc("claim_backend_job")).id).toBe(x.job.id);
});
