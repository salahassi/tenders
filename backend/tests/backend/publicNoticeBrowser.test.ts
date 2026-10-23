// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { renderedPage } from "../../scripts/backend/browser-source-worker";
import { noticeBrowserReader } from "../../supabase/functions/_shared/publicNoticeBrowser";
import type { Backend } from "../../supabase/functions/_shared/backend";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});
const url = "https://public.example.test/detail?id=synthetic";
const html =
  "<body><main><h1>Synthetic software delivery</h1><p>The public buyer requests software development, installation and documented operating instructions, with testing and deployment.</p></main></body>";
async function guardedRpc(name: string, args: unknown[]) {
  await f.db.exec("savepoint browser_rejection");
  try {
    return await f.rpc(name, args);
  } catch (error) {
    await f.db.exec("rollback to savepoint browser_rejection");
    throw error;
  } finally {
    await f.db.exec("release savepoint browser_rejection");
  }
}
async function pending() {
  const source = await f.command("source.create", {
    name: "Synthetic JavaScript notice details",
    kind: "link_directory",
    url: "https://public.example.test/notices",
    approved_hosts: ["public.example.test"],
    policy_note: "Synthetic public access permission",
  });
  await f.db.query(
    "update public.sources set adapter_config='{\"automatic\":true}',approval='approved',policy_checked_at=now(),next_due=now()+interval '6 hours' where id=$1",
    [source.id],
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
    identity_key: "external:synthetic",
    title: "Synthetic software delivery",
    description: "Public listing summary.",
    buyer: "Synthetic buyer",
    reference: "synthetic",
    language: "en",
    canonical_url: url,
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
  const before = (
    await f.db.query<any>(
      "select checkpoint,input_hash,attempts from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  const request = await f.rpc("request_notice_browser", [
    job.id,
    job.lease_token,
    url,
  ]);
  expect(request.status).toBe("queued");
  const browser = await f.rpc("claim_source_browser_page");
  expect(browser).toMatchObject({ id: request.id, url, workspace_id: f.w });
  return { source, opportunity, job, request, browser, before };
}

it.each(["ready", "waiting", "stale"])(
  "prefers browser notice continuation only for a current ready receipt (%s)",
  async (mode) => {
    const { source, job, browser } = await pending();
    if (mode !== "waiting")
      await f.rpc("complete_source_browser_page", [
        browser.id,
        browser.lease_token,
        JSON.stringify(renderedPage(html, url, url)),
        null,
      ]);
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
    expect((await f.rpc("claim_backend_job_v2")).id).toBe(
      mode === "ready" ? job.id : unseen.id,
    );
    expect(await f.rpc("claim_backend_job_v2")).toBeNull();
  },
);

it("binds rendered details to the original assessment and resumes it without changing model history", async () => {
  const { job, browser, before } = await pending();
  const page = renderedPage(html, url, url);
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    JSON.stringify(page),
    null,
  ]);
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  expect(
    await f.rpc("request_notice_browser", [
      resumed.id,
      resumed.lease_token,
      url,
    ]),
  ).toMatchObject({ status: "ready", page });
  const after = (
    await f.db.query<any>(
      "select checkpoint,input_hash from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  expect(after).toEqual({
    checkpoint: before.checkpoint,
    input_hash: before.input_hash,
  });
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.source_readings",
      )
    ).rows[0].n,
  ).toBe(0);
});

it.each(["notice", "source", "job", "authority", "archive"])(
  "rejects late rendered details after %s changes",
  async (changed) => {
    const { opportunity, source, job, browser } = await pending();
    if (changed === "archive")
      await f.db.query(
        "update public.opportunities set archived=true where id=$1",
        [opportunity],
      );
    if (changed === "notice")
      await f.db.query(
        "update public.opportunities set description='Changed synthetic notice' where id=$1",
        [opportunity],
      );
    if (changed === "source")
      await f.db.query(
        "update public.sources set revision=revision+1 where id=$1",
        [source.id],
      );
    if (changed === "job")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [job.id],
      );
    if (changed === "authority")
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1",
        [f.w],
      );
    await expect(
      guardedRpc("complete_source_browser_page", [
        browser.id,
        browser.lease_token,
        JSON.stringify(renderedPage(html, url, url)),
        null,
      ]),
    ).rejects.toThrow("STALE_INPUT");
    await expect(
      guardedRpc("source_browser_identity", [browser.id, browser.lease_token]),
    ).rejects.toThrow("STALE_INPUT");
  },
);

it("creates a new revision-bound request and skips stale queue heads without overwriting their evidence", async () => {
  const { source, job, browser, before } = await pending();
  const oldPage = renderedPage(html, url, url);
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    JSON.stringify(oldPage),
    null,
  ]);
  await f.db.query(
    "update public.sources set revision=revision+1 where id=$1",
    [source.id],
  );
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  const replacement = await f.rpc("request_notice_browser", [
    resumed.id,
    resumed.lease_token,
    url,
  ]);
  expect(replacement.id).not.toBe(browser.id);
  expect(replacement.status).toBe("queued");
  const oldReceipt = (
    await f.db.query<any>(
      "select page,status,source_revision from public.source_browser_requests where id=$1",
      [browser.id],
    )
  ).rows[0];
  expect(oldReceipt.page).toEqual(oldPage);
  expect(oldReceipt.status).toBe("ready");
  // A stale expired request can precede a valid request in the shared queue.
  await f.db.query(
    "update public.source_browser_requests set status='running',lease_until=now()-interval '1 minute',created_at=now()-interval '1 hour' where id=$1",
    [browser.id],
  );
  const next = await f.rpc("claim_source_browser_page");
  expect(next.id).toBe(replacement.id);
  const obsolete = (
    await f.db.query<any>(
      "select status,error_code,page from public.source_browser_requests where id=$1",
      [browser.id],
    )
  ).rows[0];
  expect(obsolete).toEqual({
    status: "blocked",
    error_code: "STALE_INPUT",
    page: oldPage,
  });
  const after = (
    await f.db.query<any>(
      "select checkpoint,input_hash from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  expect(after).toEqual({
    checkpoint: before.checkpoint,
    input_hash: before.input_hash,
  });
  await expect(
    guardedRpc("complete_source_browser_page", [
      browser.id,
      browser.lease_token,
      JSON.stringify(oldPage),
      null,
    ]),
  ).rejects.toThrow("STALE_LEASE");
  await f.rpc("complete_source_browser_page", [
    next.id,
    next.lease_token,
    JSON.stringify(oldPage),
    null,
  ]);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.source_browser_requests where job_id=$1",
        [job.id],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
});

it("shows a detail-page CAPTCHA under its actual source and retains one-use Owner answers", async () => {
  const { source, browser } = await pending();
  await f.rpc("source_browser_challenge", [
    browser.id,
    browser.lease_token,
    "data:image/png;base64,AAAA",
  ]);
  const challenge = await f.rpc("source_verification", [source.id]);
  expect(challenge).toMatchObject({ id: browser.id, url });
  await f.command("source.verification.answer", {
    id: browser.id,
    challenge_id: challenge.challenge_id,
    answer: "ABCDE",
  });
  expect(
    await f.rpc("source_browser_challenge", [browser.id, browser.lease_token]),
  ).toEqual({ answer: "ABCDE" });
  expect(
    await f.rpc("source_browser_challenge", [browser.id, browser.lease_token]),
  ).toEqual({});
  expect(
    JSON.stringify(
      (
        await f.db.query<any>(
          "select details from public.audit_events where action='source.verification.answer'",
        )
      ).rows,
    ),
  ).not.toContain("ABCDE");
  expect(
    await f.rpc("source_browser_identity", [browser.id, browser.lease_token]),
  ).toEqual({ workspace_id: f.w, host: "public.example.test" });
});

it("rejects a different URL and keeps detail queue mutation RPCs unavailable to clients", async () => {
  const { browser, job } = await pending();
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    null,
    "SOURCE_BROWSER_FAILED",
  ]);
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  await expect(
    guardedRpc("request_notice_browser", [
      resumed.id,
      resumed.lease_token,
      "https://other.example.test/",
    ]),
  ).rejects.toThrow("NOTICE_SOURCE_EVIDENCE_CHANGED");
  const permissions = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','public.request_notice_browser(uuid,uuid,text)','execute') client,has_function_privilege('anon','public.request_notice_browser(uuid,uuid,text)','execute') anon,has_function_privilege('service_role','app_private.source_browser_request_current(public.source_browser_requests)','execute') helper",
    )
  ).rows[0];
  expect(permissions).toEqual({ client: false, anon: false, helper: false });
});

it("translates pending browser work and verified ready markup without making network calls", async () => {
  const internal = vi
    .fn()
    .mockResolvedValueOnce({ status: "queued" })
    .mockResolvedValueOnce({
      status: "ready",
      page: {
        ...renderedPage(html, url, url),
        detail_warnings: ["NOTICE_DETAIL_TAB_UNREAD:#datesTab"],
      },
    })
    .mockResolvedValueOnce({
      status: "ready",
      page: { url, requested_url: url },
    })
    .mockResolvedValueOnce({
      status: "blocked",
      error_code: "SOURCE_HUMAN_VERIFICATION_REQUIRED",
    });
  const read = noticeBrowserReader({ internal } as unknown as Backend, {
    id: "synthetic-job",
    lease_token: "synthetic-lease",
  });
  await expect(read({ url })).rejects.toThrow("NOTICE_BROWSER_PENDING");
  await expect(read({ url })).resolves.toMatchObject({
    url,
    html: expect.stringContaining("Synthetic software delivery"),
    warnings: ["NOTICE_DETAIL_TAB_UNREAD:#datesTab"],
  });
  await expect(read({ url })).rejects.toThrow("SOURCE_BROWSER_FAILED");
  await expect(read({ url })).rejects.toThrow(
    "SOURCE_HUMAN_VERIFICATION_REQUIRED",
  );
  expect(internal).toHaveBeenCalledWith("request_notice_browser", {
    job_id: "synthetic-job",
    lease: "synthetic-lease",
    url,
  });
});
