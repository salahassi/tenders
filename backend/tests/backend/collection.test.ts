// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function source() {
  return f.command("source.create", {
    name: "Synthetic feed",
    kind: "rss",
    url: "https://feed.example.test/rss",
    approved_hosts: ["feed.example.test"],
    policy_note: "Synthetic collection permission",
  });
}
async function approve(s: any) {
  return f.command("source.action", {
    id: s.id,
    expected_revision: s.revision,
    action: "approve",
    reason: "Synthetic approved fixture",
  });
}
const notice = (description = "Synthetic software scope") => ({
  identity_key: "external:T1",
  title: "Synthetic RFP",
  description,
  buyer: "Synthetic buyer",
  reference: "T1",
  canonical_url: "https://feed.example.test/T1",
  deadline_raw: "unknown",
  deadline_at: null,
  deadline_timezone: null,
  language: "en",
});
const result = (description?: string) => ({
  status: 200,
  etag: '"v1"',
  last_modified: null,
  items: [notice(description)],
  candidates: [],
  warnings: [],
});
it("does not schedule proposed sources; due approved jobs are exclusive and paused sources cannot execute", async () => {
  const s = await source();
  expect(await f.rpc("claim_backend_job")).toBeNull();
  const active = await approve(s),
    j = await f.rpc("claim_backend_job");
  expect(j.entity_id).toBe(s.id);
  expect(await f.rpc("claim_backend_job")).toBeNull();
  await f.command("source.action", {
    id: s.id,
    expected_revision: active.revision,
    action: "pause",
    reason: "Pause test",
  });
  await expect(
    f.rpc("collection_context", [j.id, j.lease_token]),
  ).rejects.toThrow("SOURCE_PERMISSION_REQUIRED");
});
it.each(["queued", "blocked"])(
  "collects before routine assessments and replaces %s stale source jobs after resume",
  async (previousStatus) => {
    const s = await approve(await source());
    await f.db.query(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,created_at) values($1,'classify_opportunity',$2,'synthetic','queued',$3,now()-interval '10 minutes')",
      [f.w, crypto.randomUUID(), f.owner],
    );
    const queued = await f.command("source.collect", {
      id: s.id,
      expected_revision: s.revision,
    });
    const paused = await f.command("source.action", {
      id: s.id,
      expected_revision: s.revision,
      action: "pause",
      reason: "Synthetic pause while queued",
    });
    const resumed = await approve(paused);
    if (previousStatus === "blocked")
      await f.db.query(
        "update public.jobs set status='blocked',error_code='STALE_INPUT' where id=$1",
        [queued.job_id],
      );
    const job = await f.rpc("claim_backend_job");
    expect(job.type).toBe("source_collect");
    expect(job.id).not.toBe(queued.job_id);
    expect(job.input_hash).toBe(String(resumed.revision));
    expect(
      (
        await f.db.query<any>(
          "select status,error_code from public.jobs where id=$1",
          [queued.job_id],
        )
      ).rows[0],
    ).toEqual({
      status: "canceled",
      error_code: "SOURCE_CONFIGURATION_CHANGED",
    });
    expect(
      (await f.rpc("collection_context", [job.id, job.lease_token])).revision,
    ).toBe(resumed.revision);
  },
);
it("deduplicates collections, preserves human decisions, and snapshots material changes", async () => {
  const s = await approve(await source());
  let j = await f.rpc("claim_backend_job");
  await f.rpc("complete_collection", [
    j.id,
    j.lease_token,
    JSON.stringify(result()),
  ]);
  const opp = (await f.db.query<any>("select * from public.opportunities"))
    .rows[0];
  await f.command("opportunity.decision", {
    id: opp.id,
    expected_revision: opp.revision,
    target_state: "declined",
    reason: "Human decision",
  });
  for (const description of [undefined, "Changed software scope"]) {
    await f.command("source.collect", {
      id: s.id,
      expected_revision: s.revision,
    });
    j = await f.rpc("claim_backend_job");
    await f.rpc("complete_collection", [
      j.id,
      j.lease_token,
      JSON.stringify(result(description)),
    ]);
  }
  expect(
    (await f.db.query("select * from public.opportunities")).rows,
  ).toHaveLength(1);
  expect(
    (await f.db.query("select * from public.advertisement_snapshots")).rows,
  ).toHaveLength(2);
  expect(
    (
      await f.db.query<any>(
        "select decision,deadline_at from public.opportunities",
      )
    ).rows[0],
  ).toEqual({ decision: "declined", deadline_at: null });
  expect(
    (await f.db.query("select * from public.notifications")).rows,
  ).toHaveLength(2);
  await expect(
    f.rpc("complete_collection", [
      j.id,
      j.lease_token,
      JSON.stringify(result("Replay")),
    ]),
  ).rejects.toThrow("STALE_LEASE");
});
it("disappearance or 304 retains earlier records and never marks lost/canceled", async () => {
  const s = await approve(await source());
  let j = await f.rpc("claim_backend_job");
  await f.rpc("complete_collection", [
    j.id,
    j.lease_token,
    JSON.stringify(result()),
  ]);
  await f.command("source.collect", {
    id: s.id,
    expected_revision: s.revision,
  });
  j = await f.rpc("claim_backend_job");
  await f.rpc("complete_collection", [
    j.id,
    j.lease_token,
    JSON.stringify({ ...result(), status: 304, items: [] }),
  ]);
  expect(
    (await f.db.query("select * from public.opportunities")).rows,
  ).toHaveLength(1);
});
it("honors unknown quota reset and caps network retries", async () => {
  await approve(await source());
  let j = await f.rpc("claim_backend_job");
  await f.rpc("fail_collection", [
    j.id,
    j.lease_token,
    "SOURCE_QUOTA_WAIT",
    null,
  ]);
  expect(
    (
      await f.db.query<{ waiting: boolean }>(
        "select next_attempt_at='infinity'::timestamptz waiting from public.jobs where id=$1",
        [j.id],
      )
    ).rows[0].waiting,
  ).toBe(true);
  expect(await f.rpc("claim_backend_job")).toBeNull();
  await f.db.query(
    "update public.jobs set status='queued',attempts=3,next_attempt_at=now() where id=$1",
    [j.id],
  );
  j = await f.rpc("claim_backend_job");
  await f.rpc("fail_collection", [
    j.id,
    j.lease_token,
    "SOURCE_TEMPORARY_FAILURE",
    null,
  ]);
  expect(
    (
      await f.db.query<{ status: string }>(
        "select status from public.jobs where id=$1",
        [j.id],
      )
    ).rows[0].status,
  ).toBe("failed");
});
it("commits validated import previews idempotently across repeated batches", async () => {
  for (let i = 0; i < 2; i++) {
    const b = await f.command("import.preview", {
      kind: "tenders",
      rows: [notice()],
    });
    const key = crypto.randomUUID(),
      input = {
        id: b.id,
        expected_revision: b.revision,
        preview_hash: b.preview_hash,
      };
    const a = await f.command("import.commit", input, key);
    expect(await f.command("import.commit", input, key)).toEqual(a);
  }
  expect(
    (await f.db.query("select * from public.opportunities")).rows,
  ).toHaveLength(1);
  expect(
    (await f.db.query("select * from public.opportunity_source_links")).rows,
  ).toHaveLength(1);
});
it("candidates require an adapter and cannot grant collection or worker privileges", async () => {
  const batch = await f.command("import.preview", {
    kind: "sources",
    rows: [{ name: "Candidate", url: "https://candidate.example.test" }],
  });
  await f.command("import.commit", {
    id: batch.id,
    expected_revision: 1,
    preview_hash: batch.preview_hash,
  });
  const candidate = (await f.db.query<any>("select * from public.sources"))
    .rows[0];
  expect(candidate.adapter_required).toBe(true);
  expect(candidate.next_due).toBeNull();
  await expect(approve(candidate)).rejects.toThrow("ADAPTER_REQUIRED");
  await f.db.exec("reset role");
  await f.db.exec("set role authenticated");
  await expect(
    f.rpc("configure_dispatcher", ["https://synthetic.supabase.co", []]),
  ).rejects.toThrow("permission denied");
});

it("finishes a saved generation stage before routine discovery assessments", async () => {
  await f.db.query(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,created_at) values($1,'classify_opportunity',$2,'synthetic','queued',$3,now()-interval '10 minutes'),($1,'advance_plan',$4,'synthetic','queued',$3,now())",
    [f.w, crypto.randomUUID(), f.owner, crypto.randomUUID()],
  );
  expect((await f.rpc("claim_backend_job")).type).toBe("advance_plan");
});
