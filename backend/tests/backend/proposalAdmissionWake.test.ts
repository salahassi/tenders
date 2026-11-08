// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
let priorAttributes: unknown;
const row = async (sql: string, args: unknown[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
const queue = () => row("select * from app_private.k8s_dispatch_queue");
const attributes = () =>
  row(
    "select to_jsonb(p)-'prosrc' attributes from pg_proc p where oid='app_private.admit_proposal_issuance()'::regprocedure",
  );

beforeAll(async () => {
  f = await workflowFixture(
    undefined,
    "20261108180821_healthy_model_poll_backoff.sql",
  );
  priorAttributes = await attributes();
  await f.db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261108190052_wake_authorized_proposal_admission.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const dispatcher = await readFile(
    new URL("../../scripts/runtime/dispatcher.sql", import.meta.url),
    "utf8",
  );
  await f.db.exec(dispatcher.replaceAll(':"service_role"', '"service_role"'));
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled,collection_hosts) values(true,'https://synthetic.example.invalid',repeat('a',64),true,'{}')",
  );
  // Suppress periodic recovery so only the actual admission event can dispatch.
  await f.db.exec(
    "update app_private.k8s_dispatch_queue set last_periodic_at=clock_timestamp()",
  );
});
afterEach(async () => f.db.exec("rollback"));

async function opportunity() {
  const source = await f.command("source.create", {
    name: "Synthetic admission source",
    kind: "manual",
  });
  const value = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic admission proposal",
    reference: "SYNTHETIC",
    description: "Propose an approval workflow and handover documentation.",
    language: "en",
    decision: "shortlisted",
  });
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: value.id,
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
  return value;
}
async function generate(o?: any, key = crypto.randomUUID()) {
  o ??= await opportunity();
  const input = { id: o.id, expected_revision: o.revision };
  const result = await f.command("proposal.generate", input, key);
  const plan = await row("select * from generation_plans where id=$1", [
    result.id,
  ]);
  const job = await row(
    "select j.* from jobs j join generation_steps s on s.job_id=j.id where s.plan_id=$1 order by s.ordinal limit 1",
    [plan.id],
  );
  return { result, plan, job, input, key };
}

it("makes a newly admitted proposal immediately claimable from the durable outbox without periodic recovery", async () => {
  const before = await queue();
  expect(await f.rpc("k8s_claim_dispatch")).toBeNull();
  const x = await generate();
  expect(await attributes()).toEqual(priorAttributes);
  const after = await queue();
  expect(after.generation).toBe(before.generation + 1);
  expect(after.last_periodic_at).toEqual(before.last_periodic_at);
  const request = await row(
    "select operation,extract(epoch from deadline_at-accepted_at) seconds from proposal_issuance_requests where id=$1",
    [x.plan.issuance_request_id],
  );
  expect(request).toEqual({
    operation: "proposal.generate",
    seconds: "600.000000",
  });
  expect((await f.rpc("k8s_claim_dispatch")).generation).toBe(after.generation);
  expect(await f.rpc("k8s_claim_dispatch")).toBeNull();
});

it("does not enqueue a second wake for canonical idempotent replay", async () => {
  const x = await generate();
  const before = await queue();
  await f.command("proposal.generate", x.input, x.key);
  expect(await queue()).toEqual(before);
  expect(
    (await row("select count(*)::int count from proposal_issuance_requests"))
      .count,
  ).toBe(1);
});

it("does not wake or retain an issuance when canonical admission is rejected", async () => {
  const o = await opportunity();
  const before = await queue();
  await expect(
    f.command("proposal.generate", {
      id: o.id,
      expected_revision: o.revision + 1,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  expect(await queue()).toEqual(before);
  expect(
    (await row("select count(*)::int count from proposal_issuance_requests"))
      .count,
  ).toBe(0);
});

it("rolls back the outbox hint together with an uncommitted issuance", async () => {
  const o = await opportunity();
  const key = crypto.randomUUID();
  const before = await queue();
  await f.db.exec("savepoint uncommitted_admission");
  await generate(o, key);
  expect((await queue()).generation).toBe(before.generation + 1);
  await f.db.exec(
    "rollback to savepoint uncommitted_admission; release savepoint uncommitted_admission",
  );
  expect(await queue()).toEqual(before);
  expect(
    (await row("select count(*)::int count from proposal_issuance_requests"))
      .count,
  ).toBe(0);
  await generate(o, key);
  expect((await queue()).generation).toBe(before.generation + 1);
});

it("wakes canonical retry once while preserving saved input, checkpoint and original deadline", async () => {
  const x = await generate();
  await f.db.query(
    'update jobs set checkpoint=checkpoint||\'{"synthetic_saved":{"complete":true}}\'::jsonb where id=$1',
    [x.job.id],
  );
  const leased = await row(
    "update jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=$1 returning *",
    [x.job.id],
  );
  await f.rpc("fail_generation", [
    leased.id,
    leased.lease_token,
    "AI_AGENTS_UNAVAILABLE",
    null,
    null,
  ]);
  const failed = await row("select * from generation_plans where id=$1", [
    x.plan.id,
  ]);
  const priorRequest = await row(
    "select * from proposal_issuance_requests where id=$1",
    [x.plan.issuance_request_id],
  );
  const input = {
    id: failed.id,
    expected_revision: failed.revision,
    reason: "Synthetic saved-work resume",
  };
  const key = crypto.randomUUID();
  const before = await queue();
  await f.command("generation.retry", input, key);
  const after = await queue();
  expect(after.generation).toBe(before.generation + 1);
  const resumed = await row("select * from generation_plans where id=$1", [
    x.plan.id,
  ]);
  expect(resumed.input_hash).toBe(x.plan.input_hash);
  expect(resumed.frozen_context).toEqual(x.plan.frozen_context);
  expect(resumed.issuance_request_id).not.toBe(x.plan.issuance_request_id);
  expect(
    (await row("select checkpoint from jobs where id=$1", [x.job.id]))
      .checkpoint.synthetic_saved,
  ).toEqual({ complete: true });
  expect(
    await row("select * from proposal_issuance_requests where id=$1", [
      x.plan.issuance_request_id,
    ]),
  ).toEqual(priorRequest);
  await f.command("generation.retry", input, key);
  expect(await queue()).toEqual(after);
});

it("retains a new admission behind an existing dispatch lease and older acknowledgement", async () => {
  await f.db.exec("select app_private.dispatch_backend()");
  const held = await f.rpc("k8s_claim_dispatch");
  await generate();
  expect((await queue()).generation).toBe(held.generation + 1);
  expect(await f.rpc("k8s_claim_dispatch")).toBeNull();
  expect(
    await f.rpc("k8s_finish_dispatch_v2", [
      held.lease,
      held.generation,
      true,
      false,
      null,
    ]),
  ).toBe(true);
  expect((await f.rpc("k8s_claim_dispatch")).generation).toBe(
    held.generation + 1,
  );
});

it("does not enable or dispatch a paused dispatcher", async () => {
  await f.db.exec("update app_private.dispatcher_settings set enabled=false");
  const before = await queue();
  await generate();
  expect(await queue()).toEqual(before);
  expect(
    (await row("select enabled from app_private.dispatcher_settings")).enabled,
  ).toBe(false);
});

it("does not invoke legacy HTTP dispatch when the durable outbox is absent", async () => {
  await f.db.exec(
    "drop table app_private.k8s_dispatch_queue; create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$begin raise exception 'LEGACY_HTTP_MUST_NOT_BE_CALLED';end$$",
  );
  await generate();
  expect(
    (await row("select count(*)::int count from proposal_issuance_requests"))
      .count,
  ).toBe(1);
});
