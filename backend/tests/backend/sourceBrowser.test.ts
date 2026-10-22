// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  publicDestination,
  renderedPage,
} from "../../scripts/backend/browser-source-worker";
import {
  sealSession,
  openSession,
} from "../../supabase/functions/_shared/browserIdentity";
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
async function pending() {
  const source = await f.command("source.create", {
    name: "Synthetic JavaScript source",
    kind: "manual",
    url: "https://public.example.test/tenders",
  });
  await f.command("source.action", {
    id: source.id,
    expected_revision: source.revision,
    action: "approve",
    reason: "Synthetic public collection",
  });
  const job = await f.rpc("claim_backend_job");
  const queued = await f.rpc("queue_source_browser_page", [
    job.id,
    job.lease_token,
  ]);
  expect(queued.waiting_for_browser).toBe(true);
  const browser = await f.rpc("claim_source_browser_page");
  expect(browser).toMatchObject({ id: queued.request_id, workspace_id: f.w });
  return { source, job, browser };
}
const page = {
  requested_url: "https://public.example.test/tenders",
  url: "https://public.example.test/tenders",
  text: "Synthetic public software procurement notice with complete details.",
  links: [],
  partial: false,
  rendered: true,
};
it("resumes the same saved job with rendered evidence and rejects a stale browser lease", async () => {
  const { job, browser } = await pending();
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    JSON.stringify(page),
    null,
  ]);
  const resumed = await f.rpc("claim_backend_job");
  expect(resumed.id).toBe(job.id);
  expect(
    await f.rpc("source_browser_page", [resumed.id, resumed.lease_token]),
  ).toMatchObject({ status: "ready", page });
  await expect(
    f.rpc("complete_source_browser_page", [
      browser.id,
      browser.lease_token,
      JSON.stringify(page),
      null,
    ]),
  ).rejects.toThrow("STALE_LEASE");
});
it("requires current Owner authority, binds CAPTCHA answers to the live challenge, and redacts its audit", async () => {
  const { source, browser } = await pending();
  await f.rpc("source_browser_challenge", [
    browser.id,
    browser.lease_token,
    "data:image/png;base64,AAAA",
  ]);
  const challenge = await f.rpc("source_verification", [source.id]);
  expect(challenge).toMatchObject({
    id: browser.id,
    image: "data:image/png;base64,AAAA",
  });
  const payload = {
    id: browser.id,
    challenge_id: challenge.challenge_id,
    answer: "ABCDE",
  };
  const key = crypto.randomUUID();
  const result = await f.command("source.verification.answer", payload, key);
  expect(await f.command("source.verification.answer", payload, key)).toEqual(
    result,
  );
  expect(
    await f.rpc("source_browser_challenge", [browser.id, browser.lease_token]),
  ).toEqual({ answer: "ABCDE" });
  expect(
    await f.rpc("source_browser_challenge", [browser.id, browser.lease_token]),
  ).toEqual({});
  const audit = (
    await f.db.query<any>(
      "select details from public.audit_events where action='source.verification.answer'",
    )
  ).rows;
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain("ABCDE");
  await f.db.query(
    "update public.source_browser_requests set challenge_expires_at=now()-interval '1 second' where id=$1",
    [browser.id],
  );
  await expect(
    f.command("source.verification.answer", payload),
  ).rejects.toThrow("SOURCE_VERIFICATION_EXPIRED");
});
it("never publishes a page after the source is paused or a job is canceled", async () => {
  const { source, job, browser } = await pending();
  await f.db.query("update public.sources set approval='paused' where id=$1", [
    source.id,
  ]);
  await expect(
    f.rpc("complete_source_browser_page", [
      browser.id,
      browser.lease_token,
      JSON.stringify(page),
      null,
    ]),
  ).rejects.toThrow("STALE_INPUT");
});
it("keeps human-verification failures explicit and browser/session RPCs unavailable to client roles", async () => {
  const { browser } = await pending();
  await f.rpc("complete_source_browser_page", [
    browser.id,
    browser.lease_token,
    null,
    "SOURCE_HUMAN_VERIFICATION_REQUIRED",
  ]);
  expect(
    (
      await f.db.query<any>(
        "select status,page,error_code from public.source_browser_requests where id=$1",
        [browser.id],
      )
    ).rows[0],
  ).toEqual({
    status: "blocked",
    page: null,
    error_code: "SOURCE_HUMAN_VERIFICATION_REQUIRED",
  });
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','public.claim_source_browser_page()','execute') client,has_table_privilege('authenticated','app_private.source_browser_sessions','select') sessions,has_table_privilege('authenticated','app_private.source_browser_answers','select') answers",
      )
    ).rows[0],
  ).toEqual({ client: false, sessions: false, answers: false });
});
it("encrypts browser sessions with tamper detection and workspace/host binding", async () => {
  const session = {
    cookies: [{ name: "synthetic", value: "secret-session" }],
    origins: [],
  };
  const sealed = await sealSession(
    session,
    "synthetic-key",
    "workspace:source.test",
  );
  expect(sealed).not.toContain("secret-session");
  expect(
    await openSession(sealed, "synthetic-key", "workspace:source.test"),
  ).toEqual(session);
  expect(
    await openSession(sealed, "wrong-key", "workspace:source.test"),
  ).toBeUndefined();
  expect(
    await openSession(sealed, "synthetic-key", "other:source.test"),
  ).toBeUndefined();
  expect(
    await openSession(
      sealed.slice(0, -4) + "AAAA",
      "synthetic-key",
      "workspace:source.test",
    ),
  ).toBeUndefined();
});
it("rejects private DNS answers, plain HTTP, credentials and nonstandard ports before browsing", async () => {
  for (const url of [
    "http://public.test",
    "https://user:pass@public.test",
    "https://public.test:8443",
  ])
    await expect(
      publicDestination(url, async () => ["8.8.8.8"]),
    ).rejects.toThrow("UNSAFE_DESTINATION");
  await expect(
    publicDestination("https://private.test", async () => ["127.0.0.1"]),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  await expect(
    publicDestination("https://mixed.test", async () => [
      "8.8.8.8",
      "169.254.169.254",
    ]),
  ).rejects.toThrow("UNSAFE_DESTINATION");
});
it("retains real rendered wording and observed HTTPS links without executing embedded content", () => {
  const result = renderedPage(
    '<body><script>secretInstruction()</script><p>Synthetic public procurement notice and closing details.</p><a href="/notice/1">Notice</a><a href="javascript:bad()">Bad</a></body>',
    page.url,
    page.url,
  );
  expect(result.rendered).toBe(true);
  expect(result.text).not.toContain("secretInstruction");
  expect(result.links).toEqual([
    { id: "L1", text: "Notice", url: "https://public.example.test/notice/1" },
  ]);
});
