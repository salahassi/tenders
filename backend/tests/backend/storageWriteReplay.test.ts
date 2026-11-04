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
async function setup() {
  const source = await f.command("source.create", {
    name: "Synthetic replay review",
    kind: "manual",
  });
  const opp = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic replay scope",
    reference: "S1",
    description: "Configure the approval workflow and demonstrate acceptance.",
    decision: "shortlisted",
  });
  const snapshot = await f.command("delivery.snapshot.prepare", {
    opportunity_id: opp.id,
    expected_revision: opp.revision,
  });
  const job = await f.rpc("claim_backend_job_v4");
  const context = await f.rpc("delivery_export_context", [
    job.id,
    job.lease_token,
  ]);
  return { snapshot, job, key: context.artifacts[0].storage_key };
}
async function consume(d: { job: any; key: string }) {
  expect(
    await f.rpc("begin_render_storage_write", [
      d.job.id,
      d.job.lease_token,
      d.key,
      "a".repeat(64),
      123,
    ]),
  ).toMatchObject({ send: true });
  await f.db.query("update public.jobs set failure_count=5 where id=$1", [
    d.job.id,
  ]);
  await f.rpc("fail_delivery_export", [
    d.job.id,
    d.job.lease_token,
    "DELIVERY_STORAGE_UNAVAILABLE",
  ]);
}
it("retry replay must leave a later failed upload and cleanup inventory unchanged", async () => {
  const d = await setup();
  await consume(d);
  const proposal = (
    await f.db.query<any>(
      "select delivery_revision from public.proposals where id=$1",
      [d.snapshot.proposal_id],
    )
  ).rows[0];
  const input = {
    snapshot_id: d.snapshot.id,
    expected_delivery_revision: proposal.delivery_revision,
  };
  const key = crypto.randomUUID();
  const first = await f.command("delivery.snapshot.retry", input, key);
  const job = await f.rpc("claim_backend_job_v4");
  const context = await f.rpc("delivery_export_context", [
    job.id,
    job.lease_token,
  ]);
  await consume({ job, key: context.artifacts[0].storage_key });
  const state = async () =>
    (
      await f.db.query<any>(
        "select (select jsonb_agg(to_jsonb(a) order by id) from public.proposal_delivery_artifacts a) artifacts,(select jsonb_agg(to_jsonb(q) order by id) from public.storage_cleanup_queue q) cleanup",
      )
    ).rows[0];
  const before = await state();
  expect((await f.command("delivery.snapshot.retry", input, key)).id).toBe(
    first.id,
  );
  expect(await state()).toEqual(before);
});
it("one-time storage begin rejects a lease expired after the transaction began", async () => {
  const d = await setup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await f.db.query(
    "update public.jobs set lease_until=clock_timestamp()-interval '1 millisecond' where id=$1",
    [d.job.id],
  );
  const clocks = (
    await f.db.query<any>(
      "select lease_until>now() past_transaction_start,lease_until<clock_timestamp() actually_expired from public.jobs where id=$1",
      [d.job.id],
    )
  ).rows[0];
  expect(clocks).toEqual({
    past_transaction_start: true,
    actually_expired: true,
  });
  await expect(
    f.rpc("begin_render_storage_write", [
      d.job.id,
      d.job.lease_token,
      d.key,
      "a".repeat(64),
      123,
    ]),
  ).rejects.toThrow("STALE_LEASE");
});
