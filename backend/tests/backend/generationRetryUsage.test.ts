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

async function setup(modern = true) {
  if (modern)
    await f.db.query(
      "insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by) values($1,true,now()-interval '1 day',$2)",
      [f.w, f.owner],
    );
  const source = await f.command("source.create", {
    name: "Synthetic retry source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic retry proposal",
    reference: "SYNTHETIC",
    description: "Deliver an approval workflow with documented handover.",
    language: "en",
    decision: "shortlisted",
  });
  const document = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: 100,
    hash: "a".repeat(64),
  });
  const accepted = await f.rpc("accept_uploaded_document", [
    document.id,
    f.owner,
    "a".repeat(64),
    100,
    "Deliver an approval workflow and documented handover.",
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: accepted.id,
    expected_revision: accepted.revision,
  });
  const generated = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const plan = await row("select * from public.generation_plans where id=$1", [
    generated.id,
  ]);
  await f.db.query(
    "select app_private.fail_proposal_issuance($1,'PROPOSAL_ISSUANCE_TIMEOUT')",
    [plan.issuance_request_id],
  );
  const p = await row("select * from public.generation_plans where id=$1", [
    plan.id,
  ]);
  const job = await row(
    "select j.* from public.jobs j join public.generation_steps s on s.job_id=j.id where s.plan_id=$1 and app_private.queue_work_class(j)<>'local' order by s.ordinal limit 1",
    [p.id],
  );
  const original = await row(
    "select * from public.proposal_issuance_requests where id=$1",
    [p.issuance_request_id],
  );
  return { p, job, original };
}
async function usage(
  job: string | null = null,
  state = "unknown",
  aged = false,
) {
  return row(
    `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
    application_day,settings_revision,reserved_input,reserved_output,state,created_by,created_at,remote_deadline)
    values($1,$2,gen_random_uuid(),$3,'openai','synthetic-model',repeat('b',64),current_date,1,100,100,$4,$5,
      now()-case when $6 then interval '20 minutes' else interval '0 seconds' end,
      now()+case when $6 then interval '-1 minute' else interval '10 minutes' end) returning *`,
    [f.w, job, crypto.randomUUID(), state, f.owner, aged],
  );
}
const retry = (p: any, key = crypto.randomUUID()) =>
  f.command(
    "generation.retry",
    {
      id: p.id,
      expected_revision: p.revision,
      reason: "Resume synthetic saved work.",
    },
    key,
  );
async function automatic(job: any) {
  await f.db.query(
    `update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_executor',2,
    'model_operation',jsonb_build_object('task',type),'model_routing',jsonb_build_object('mode','round_robin','providers','[]'::jsonb)) where id=$1`,
    [job.id],
  );
}
const allUsage = async () =>
  (await f.db.query("select * from public.provider_usage order by id")).rows;

it("resumes a modern current plan despite unrelated unknown history, preserving history and one issuance on replay", async () => {
  const x = await setup();
  const old = await usage();
  const key = crypto.randomUUID();
  const result = await retry(x.p, key);
  expect(result).toMatchObject({ id: x.p.id, status: "queued" });
  const current = await row(
    "select * from public.generation_plans where id=$1",
    [x.p.id],
  );
  expect(current.issuance_request_id).not.toBe(x.original.id);
  expect(current.input_hash).toBe(x.p.input_hash);
  expect(current.frozen_context).toEqual(x.p.frozen_context);
  expect(await allUsage()).toEqual([old]);
  expect(
    await row("select * from public.proposal_issuance_requests where id=$1", [
      x.original.id,
    ]),
  ).toEqual(x.original);
  const issued = await row(
    "select *,extract(epoch from deadline_at-accepted_at) seconds from public.proposal_issuance_requests where id=$1",
    [current.issuance_request_id],
  );
  expect(issued).toMatchObject({
    operation: "generation.retry",
    outcome: "active",
    seconds: "600.000000",
  });
  expect(await retry(x.p, key)).toEqual(result);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_issuance_requests where plan_id=$1",
        [x.p.id],
      )
    ).n,
  ).toBe(2);
  expect(
    await row(
      "select *,extract(epoch from deadline_at-accepted_at) seconds from public.proposal_issuance_requests where id=$1",
      [current.issuance_request_id],
    ),
  ).toEqual(issued);
  expect(
    await row("select checkpoint,status from public.jobs where id=$1", [
      x.job.id,
    ]),
  ).toMatchObject({
    status: "queued",
    checkpoint: { issuance_request_id: current.issuance_request_id },
  });
});

it.each([false, true])(
  "keeps reserved usage blocking when modern admission is %s",
  async (modern) => {
    const x = await setup(modern);
    const old = await usage(null, "reserved");
    await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
    expect(await allUsage()).toEqual([old]);
    expect(
      await row("select * from public.generation_plans where id=$1", [x.p.id]),
    ).toEqual(x.p);
  },
);

it("preserves the manual-policy unknown guard", async () => {
  const x = await setup(false);
  const old = await usage();
  await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
  expect(await allUsage()).toEqual([old]);
});

it("does not admit an untouched old plan after a later modern cutoff", async () => {
  const x = await setup();
  await usage();
  await f.db.query(
    "update public.model_execution_settings set admitted_after=now()+interval '1 second' where workspace_id=$1",
    [f.w],
  );
  await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
});

it("accepts the router's null cutoff but does not reinterpret a manual checkpoint", async () => {
  const x = await setup();
  await usage();
  await f.db.query(
    "update public.model_execution_settings set admitted_after=null where workspace_id=$1",
    [f.w],
  );
  await f.db.query(
    'update public.jobs set checkpoint=checkpoint||\'{"model_routing":{"mode":"manual"}}\' where id=$1',
    [x.job.id],
  );
  await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
  await f.db.query(
    "update public.jobs set checkpoint=checkpoint-'model_routing' where id=$1",
    [x.job.id],
  );
  expect(await retry(x.p)).toMatchObject({ id: x.p.id, status: "queued" });
});

it("retains frozen catalog continuation despite later settings changes and ignores local steps", async () => {
  const x = await setup();
  await automatic(x.job);
  await usage();
  await f.db.query(
    "update public.model_execution_settings set enabled=false,admitted_after=now()+interval '1 day' where workspace_id=$1",
    [f.w],
  );
  await f.db.query(
    "select app_private.enqueue_generation(p,'advance_plan','{}'::jsonb) from public.generation_plans p where id=$1",
    [x.p.id],
  );
  expect(await retry(x.p)).toMatchObject({ id: x.p.id, status: "queued" });
});

it.each([false, true])(
  "a local-only transition retains modern admission=%s",
  async (modern) => {
    const x = await setup(modern);
    await usage();
    await f.db.query(
      "update public.generation_steps set status='completed',output='{}'::jsonb where plan_id=$1",
      [x.p.id],
    );
    await f.db.query(
      "select app_private.enqueue_generation(p,'advance_plan','{}'::jsonb) from public.generation_plans p where id=$1",
      [x.p.id],
    );
    if (modern)
      expect(await retry(x.p)).toMatchObject({ id: x.p.id, status: "queued" });
    else await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
  },
);

it("blocks a current ambiguous call on the resumed job without new issuance or accounting mutation", async () => {
  const x = await setup();
  await automatic(x.job);
  const old = await usage(x.job.id);
  await expect(retry(x.p)).rejects.toThrow("USAGE_REVIEW_REQUIRED");
  expect(await allUsage()).toEqual([old]);
  expect(
    (
      await row(
        "select count(*)::int n from public.proposal_issuance_requests where plan_id=$1",
        [x.p.id],
      )
    ).n,
  ).toBe(1);
});

it("records eligible old ambiguity without settling usage or replenishing model allowances", async () => {
  const x = await setup();
  await automatic(x.job);
  const old = await usage(x.job.id, "unknown", true);
  await f.db.query(
    "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,candidate_count) values(repeat('c',64),$1,$2,$3,'analyze_chunk',2)",
    [f.w, x.job.id, x.p.input_hash],
  );
  await f.db.exec(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values(repeat('c',64),'synthetic-input',2)",
  );
  const budget = (
    await f.db.query(
      "select * from app_private.model_graph_budgets order by thread_id",
    )
  ).rows;
  expect(await retry(x.p)).toMatchObject({ id: x.p.id, status: "queued" });
  expect(await allUsage()).toEqual([old]);
  expect(
    (
      await f.db.query(
        "select * from app_private.model_graph_budgets order by thread_id",
      )
    ).rows,
  ).toEqual(budget);
  expect(
    await row(
      "select details from public.audit_events where entity_id=$1 and action='model.usage_recovery'",
      [x.job.id],
    ),
  ).toMatchObject({
    details: {
      operation: "generation_retry",
      usage_unchanged: true,
      candidate_allowances_unchanged: true,
    },
  });
});

it("does not alter legacy automatic routing or bypass expected revisions and current-contract checks", async () => {
  const x = await setup(false);
  await usage();
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  await expect(retry({ ...x.p, revision: x.p.revision + 1 })).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  await f.db.query(
    "update public.generation_plans set frozen_context=frozen_context-'proposal_consistency_version' where id=$1",
    [x.p.id],
  );
  await expect(retry(x.p)).rejects.toThrow(
    "PROPOSAL_CURRENT_CONTRACT_REQUIRED",
  );
  await f.db.query(
    "update public.generation_plans set frozen_context=$2::jsonb where id=$1",
    [x.p.id, JSON.stringify(x.p.frozen_context)],
  );
  expect(await retry(x.p)).toMatchObject({ id: x.p.id, status: "queued" });
  for (const role of ["anon", "authenticated", "service_role"])
    expect(
      (
        await row(
          "select has_function_privilege($1,'app_private.assert_generation_retry_usage(public.generation_plans,text)','execute') allowed",
          [role],
        )
      ).allowed,
    ).toBe(false);
});
