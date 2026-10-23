// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { seedExtraction } from "./sourceExtractionFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
const host = "www.ramallah.ps";
const url = `https://${host}/synthetic-attachment.pdf`;
const hash = "a".repeat(64);
const output = {
  sha256: hash,
  engine: "tesseract",
  languages: ["ara", "eng"],
  pages: [
    {
      page: 1,
      text: "Synthetic published notice for software support and operational handover.",
      confidence: 91,
    },
  ],
};
async function fixture() {
  const source = await f.command("source.create", {
    name: "Synthetic public OCR source",
    kind: "link_directory",
    url: `https://${host}/tenders`,
    approved_hosts: [host],
    policy_note: "Synthetic public source",
  });
  await f.db.query(
    "update public.sources set adapter_config=$2::jsonb,approval='approved',policy_checked_at=now(),next_due=now()+interval '6 hours' where id=$1",
    [
      source.id,
      JSON.stringify({
        official_listing: "ps-ramallah",
        extraction: seedExtraction("ps-ramallah"),
      }),
    ],
  );
  await f.db.query(
    "insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,collection_hosts,enabled) values(true,'https://synthetic.supabase.co','synthetic',$1,true) on conflict(singleton) do update set collection_hosts=excluded.collection_hosts,enabled=true",
    [[host]],
  );
  await f.command("model.configure", {
    provider: "gemini_free",
    expected_revision: 0,
    enabled: true,
    model: "synthetic-model",
    project_ref: "synthetic",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_mode: "provider_managed",
    quota_ends_at: null,
    quota_remaining_tokens: null,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  });
  const item = {
    title: "Synthetic public software notice",
    description: "Synthetic listing awaiting original scanned notice.",
    reference: "fixture:ocr",
    canonical_url: `https://${host}/Article/synthetic`,
    buyer: "Synthetic buyer",
    language: "en",
    identity_key: "external:ocr",
  };
  const opportunity = (
    await f.db.query<any>(
      "select app_private.ingest_notice($1,s,$3::jsonb,$4) id from public.sources s where id=$2",
      [f.w, source.id, JSON.stringify(item), f.owner],
    )
  ).rows[0].id;
  await f.rpc("schedule_assessment_refresh");
  const job = await f.rpc("claim_backend_job");
  expect(job.type).toBe("classify_opportunity");
  return { source, opportunity, job };
}
async function request(job: any, target = url, pages = [1]) {
  return f.rpc("request_notice_ocr", [
    job.id,
    job.lease_token,
    target,
    hash,
    JSON.stringify(pages),
    1,
    "application/pdf",
  ]);
}
it("defers and resumes the same lease-bound assessment with exact-hash OCR evidence and no provider usage", async () => {
  const { job } = await fixture();
  const pending = await request(job);
  expect(pending.status).toBe("pending");
  const before = (
    await f.db.query<any>(
      "select input_hash,checkpoint from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  const claim = await f.rpc("claim_notice_ocr");
  expect(claim).toMatchObject({
    id: pending.request_id,
    sha256: hash,
    pages: [1],
    approved_hosts: [host],
  });
  await f.rpc("complete_notice_ocr", [
    claim.id,
    claim.lease_token,
    JSON.stringify(output),
    null,
  ]);
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  expect(await request(resumed)).toEqual({ status: "ready", result: output });
  const after = (
    await f.db.query<any>(
      "select input_hash,checkpoint from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  expect(after).toEqual(before);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
});
it("rejects an unapproved destination before creating a native worker request", async () => {
  const { job } = await fixture();
  await expect(
    request(job, "https://other.example.test/attachment.pdf"),
  ).rejects.toThrow("UNSAFE_DESTINATION");
});
it("limits redirect hosts to the intersection of source and deployment approvals", async () => {
  const { job, source } = await fixture();
  await f.db.query("update public.sources set approved_hosts=$2 where id=$1", [
    source.id,
    [host, "cdn.example.test"],
  ]);
  await request(job);
  expect((await f.rpc("claim_notice_ocr")).approved_hosts).toEqual([host]);
});
it("rejects invalid page bounds before releasing the generation lease", async () => {
  const { job } = await fixture();
  await expect(request(job, url, [2])).rejects.toThrow("INVALID_INPUT");
});
it("rejects a worker result whose content hash differs from the fetched evidence", async () => {
  const { job } = await fixture();
  await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      claim.lease_token,
      JSON.stringify({ ...output, sha256: "b".repeat(64) }),
      null,
    ]),
  ).rejects.toThrow("INVALID_INPUT");
});
it("rejects a stale native lease and preserves the exact pending request", async () => {
  const { job } = await fixture();
  await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      crypto.randomUUID(),
      JSON.stringify(output),
      null,
    ]),
  ).rejects.toThrow("STALE_LEASE");
});
it("rejects incomplete or substituted page coverage even for the correct document hash", async () => {
  const { job } = await fixture();
  await f.rpc("request_notice_ocr", [
    job.id,
    job.lease_token,
    url,
    hash,
    "[1,2]",
    2,
    "application/pdf",
  ]);
  const claim = await f.rpc("claim_notice_ocr");
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      claim.lease_token,
      JSON.stringify(output),
      null,
    ]),
  ).rejects.toThrow("INVALID_INPUT");
});
it.each(["ready", "waiting", "partial_waiting", "stale"])(
  "prioritizes only a current ready OCR receipt before unseen inference (%s)",
  async (mode) => {
    const { job, source } = await fixture();
    await request(job);
    if (mode !== "waiting") {
      const claim = await f.rpc("claim_notice_ocr");
      await f.rpc("complete_notice_ocr", [
        claim.id,
        claim.lease_token,
        JSON.stringify(output),
        null,
      ]);
    }
    if (mode === "partial_waiting") {
      const resumed = await f.rpc("claim_backend_job_v2");
      expect(resumed.id).toBe(job.id);
      await request(resumed, url + "?attachment=second");
    }
    if (mode === "stale")
      await f.db.query(
        "update public.sources set revision=revision+1 where id=$1",
        [source.id],
      );
    await f.db.query(
      "update public.jobs set next_attempt_at=now() where id=$1",
      [job.id],
    );
    await f.db.query(
      "update app_private.queue_dispatch_state set cursor=0 where workspace_id=$1",
      [f.w],
    );
    const unseen = (
      await f.db.query<any>(
        "insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status) values($1,'classify_opportunity',gen_random_uuid(),'synthetic-unseen',$2,'queued') returning id",
        [f.w, f.owner],
      )
    ).rows[0];
    const claimed = await f.rpc("claim_backend_job_v2");
    expect(claimed.id).toBe(mode === "ready" ? job.id : unseen.id);
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
    expect(
      (await f.db.query("select * from public.provider_usage")).rows,
    ).toHaveLength(0);
  },
);

it("alternates initial public notice reading with model owners while preserving due times", async () => {
  const { job } = await fixture();
  await f.db.query(
    "update public.jobs set status='queued',lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 hour' where id=$1",
    [job.id],
  );
  await f.db.query(
    "update app_private.queue_dispatch_state set cursor=0 where workspace_id=$1",
    [f.w],
  );
  const unseen = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status) values($1,'classify_opportunity',gen_random_uuid(),'synthetic-unseen',$2,'queued') returning id",
      [f.w, f.owner],
    )
  ).rows[0];
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(unseen.id);
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null where id=$1",
    [unseen.id],
  );
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    job.id,
  ]);
  // At an ordinary cycle, an unseen model owner still receives its turn.
  const second = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status) values($1,'classify_opportunity',gen_random_uuid(),'synthetic-second',$2,'queued') returning id",
      [f.w, f.owner],
    )
  ).rows[0];
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(second.id);
  await f.db.query(
    "update public.jobs set status='succeeded',lease_token=null,lease_until=null where id=$1",
    [second.id],
  );
  const third = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,created_by,status) values($1,'classify_opportunity',gen_random_uuid(),'synthetic-third',$2,'queued') returning id",
      [f.w, f.owner],
    )
  ).rows[0];
  expect((await f.rpc("claim_backend_job_v2")).id).toBe(job.id);
  expect(
    (
      await f.db.query<any>("select attempts from public.jobs where id=$1", [
        third.id,
      ])
    ).rows[0].attempts,
  ).toBe(0);
});

it("blocks queued OCR when its source configuration changes", async () => {
  const { job, source } = await fixture();
  const pending = await request(job);
  await f.db.query(
    "update public.sources set revision=revision+1 where id=$1",
    [source.id],
  );
  expect(await f.rpc("claim_notice_ocr")).toBeNull();
  expect(
    (
      await f.db.query<any>(
        "select status,error_code from app_private.public_notice_ocr_requests where id=$1",
        [pending.request_id],
      )
    ).rows[0],
  ).toEqual({ status: "blocked", error_code: "STALE_INPUT" });
});
it("creates a new revision-bound request after source reconfiguration and retains old evidence", async () => {
  const { job, source } = await fixture();
  const old = await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await f.rpc("complete_notice_ocr", [
    claim.id,
    claim.lease_token,
    JSON.stringify(output),
    null,
  ]);
  await f.db.query(
    "update public.sources set revision=revision+1 where id=$1",
    [source.id],
  );
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  const current = await request(resumed);
  expect(current.status).toBe("pending");
  expect(current.request_id).not.toBe(old.request_id);
  const receipts = (
    await f.db.query<any>(
      "select id,status,result,source_revision from app_private.public_notice_ocr_requests where job_id=$1 order by source_revision",
      [job.id],
    )
  ).rows;
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toMatchObject({
    id: old.request_id,
    status: "ready",
    result: output,
  });
  expect(receipts[1]).toMatchObject({
    id: current.request_id,
    status: "queued",
    result: null,
  });
  expect(Number(receipts[1].source_revision)).toBe(
    Number(receipts[0].source_revision) + 1,
  );
});
it("skips multiple stale requests and claims valid work in the same bounded scan", async () => {
  const { job, source } = await fixture();
  const first = await request(job);
  await f.db.query(
    "update public.sources set revision=revision+1 where id=$1",
    [source.id],
  );
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    job.id,
  ]);
  const second = await request(await f.rpc("claim_backend_job"));
  await f.db.query(
    "update public.sources set revision=revision+1 where id=$1",
    [source.id],
  );
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    job.id,
  ]);
  const third = await request(await f.rpc("claim_backend_job"));
  await f.db.query(
    "update app_private.public_notice_ocr_requests set created_at=now()-interval '1 hour' where id=any($1::uuid[])",
    [[first.request_id, second.request_id]],
  );
  expect((await f.rpc("claim_notice_ocr")).id).toBe(third.request_id);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from app_private.public_notice_ocr_requests where job_id=$1 and status='blocked' and error_code='STALE_INPUT'",
        [job.id],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (
      await f.db.query<any>(
        "select next_attempt_at>now() waiting from public.jobs where id=$1",
        [job.id],
      )
    ).rows[0].waiting,
  ).toBe(true);
});
it("does not claim queued OCR after the opportunity is archived", async () => {
  const { job, opportunity } = await fixture();
  await request(job);
  await f.db.query(
    "update public.opportunities set archived=true where id=$1",
    [opportunity],
  );
  expect(await f.rpc("claim_notice_ocr")).toBeNull();
});
it("rejects a native result after the opportunity is archived", async () => {
  const { job, opportunity } = await fixture();
  await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await f.db.query(
    "update public.opportunities set archived=true where id=$1",
    [opportunity],
  );
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      claim.lease_token,
      JSON.stringify(output),
      null,
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("does not accept an OCR result after the owning assessment is canceled", async () => {
  const { job } = await fixture();
  await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await f.db.query(
    "update public.jobs set cancel_requested=true,status='canceled' where id=$1",
    [job.id],
  );
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      claim.lease_token,
      JSON.stringify(output),
      null,
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("checks current operator authorization again when the native worker returns", async () => {
  const { job } = await fixture();
  await request(job);
  const claim = await f.rpc("claim_notice_ocr");
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  await expect(
    f.rpc("complete_notice_ocr", [
      claim.id,
      claim.lease_token,
      JSON.stringify(output),
      null,
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("retains partial OCR pages explicitly without inventing recognized text", async () => {
  const { job } = await fixture();
  await f.rpc("request_notice_ocr", [
    job.id,
    job.lease_token,
    url,
    hash,
    "[1,2]",
    2,
    "application/pdf",
  ]);
  const claim = await f.rpc("claim_notice_ocr");
  const partial = {
    ...output,
    pages: [...output.pages, { page: 2, text: "", confidence: 0 }],
  };
  await f.rpc("complete_notice_ocr", [
    claim.id,
    claim.lease_token,
    JSON.stringify(partial),
    null,
  ]);
  expect(
    (
      await f.db.query<any>(
        "select result from app_private.public_notice_ocr_requests where id=$1",
        [claim.id],
      )
    ).rows[0].result,
  ).toEqual(partial);
});
it("denies browser roles access to native requests and service-only RPCs", async () => {
  const privileges = (
    await f.db.query<any>(
      "select has_table_privilege('authenticated','app_private.public_notice_ocr_requests','select') readable,has_function_privilege('authenticated','public.claim_notice_ocr()','execute') executable,has_function_privilege('anon','public.request_notice_ocr(uuid,uuid,text,text,jsonb,integer,text)','execute') anonymous",
    )
  ).rows[0];
  expect(privileges).toEqual({
    readable: false,
    executable: false,
    anonymous: false,
  });
  await f.db.exec("set local role authenticated");
  await expect(f.rpc("claim_notice_ocr")).rejects.toThrow("permission denied");
});
it("retries one transient native failure within the original two-attempt budget", async () => {
  const { job } = await fixture();
  const pending = await request(job);
  const first = await f.rpc("claim_notice_ocr");
  await f.rpc("complete_notice_ocr", [
    first.id,
    first.lease_token,
    null,
    "SOURCE_TIMEOUT",
  ]);
  const waiting = (
    await f.db.query<any>(
      "select status,error_code,lease_token,next_attempt_at>now() future from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  expect(waiting).toEqual({
    status: "retry_wait",
    error_code: "NOTICE_OCR_PENDING",
    lease_token: null,
    future: true,
  });
  const second = await f.rpc("claim_notice_ocr");
  expect(second.id).toBe(pending.request_id);
  expect(second.lease_token).not.toBe(first.lease_token);
  await f.rpc("complete_notice_ocr", [
    second.id,
    second.lease_token,
    null,
    "SOURCE_TIMEOUT",
  ]);
  expect(await f.rpc("claim_notice_ocr")).toBeNull();
  expect(
    (
      await f.db.query<any>(
        "select status,attempts from app_private.public_notice_ocr_requests where id=$1",
        [pending.request_id],
      )
    ).rows[0],
  ).toEqual({ status: "blocked", attempts: 2 });
});
