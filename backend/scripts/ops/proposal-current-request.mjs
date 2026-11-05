/** Explicit one-request browser recovery. Nothing executes merely by importing. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import {
  currentProposalRequest,
  currentProposalCommands,
} from "../../../frontend/src/lib/currentProposalRequest.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMANDS = "/functions/v1/api/v1/commands";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const check = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { code });
};
const safeCode = (error) =>
  /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || "")
    ? error.code
    : "CURRENT_REQUEST_BROWSER_FAILED";
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );

export function validateInput(input) {
  check(input && typeof input === "object", "CURRENT_REQUEST_INPUT_INVALID");
  const origin = new URL(input.origin);
  check(
    origin.protocol === "https:" && origin.origin === input.origin &&
      !origin.username && !origin.password,
    "CURRENT_REQUEST_ORIGIN_INVALID",
  );
  for (const key of ["workspace_id", "opportunity_id", "plan_id", "proposal_id", "actor_id"])
    check(typeof input[key] === "string" && UUID.test(input[key]), "CURRENT_REQUEST_INPUT_INVALID");
  for (const key of ["expected_plan_revision", "expected_opportunity_revision", "expected_proposal_revision"])
    check(Number.isSafeInteger(input[key]) && input[key] > 0, "CURRENT_REQUEST_INPUT_INVALID");
  check(HASH.test(input.preserved_input_hash || ""), "CURRENT_REQUEST_INPUT_INVALID");
  check(/^[0-9]{1,20}$/.test(input.run_id || ""), "CURRENT_REQUEST_INPUT_INVALID");
  check(
    typeof input.access_token === "string" && input.access_token.length > 20 &&
      input.access_token.length < 16384 && input.session?.access_token === input.access_token &&
      input.session?.user?.id === input.actor_id && typeof input.session?.refresh_token === "string" &&
      input.session.refresh_token.length > 0,
    "CURRENT_REQUEST_SESSION_INVALID",
  );
  return input;
}

/** Small, independently testable boundary around the actual frontend sender. */
export class CurrentRequestGuard {
  constructor(input) {
    this.input = validateInput(input);
    this.phase = "initial";
    this.details = null;
    this.prepared = null;
    this.report = {
      version: 1, kind: "actual_current_proposal_request", outcome: "failed",
      browser_commands: { resume: 0, batch: 0, unexpected_mutations: 0 },
      checks: [], browser_cleanup_confirmed: false, browser_api_reads: 0,
    };
  }
  probe(body, key) {
    check(this.phase === "initial", "CURRENT_REQUEST_PROBE_REPEATED");
    check(UUID.test(key || ""), "CURRENT_REQUEST_IDEMPOTENCY_REQUIRED");
    const expected = {
      commands: [{ operation: "generation.retry", input: {
        id: this.input.plan_id, expected_revision: this.input.expected_plan_revision,
        reason: "User requested continuation of the saved work.",
      } }],
    };
    check(canonical(body) === canonical(expected), "CURRENT_REQUEST_PROBE_CHANGED");
    this.phase = "probe_sent";
    this.report.browser_commands.resume++;
  }
  observeProbe(status, body) {
    check(this.phase === "probe_sent", "CURRENT_REQUEST_PROBE_ORDER_INVALID");
    check(status === 422 && body?.error?.code === "PROPOSAL_CURRENT_CONTRACT_REQUIRED", "CURRENT_REQUEST_LEGACY_GUARD_REQUIRED");
    const details = currentProposalRequest(body.error.details, this.input.opportunity_id);
    check(
      details && details.plan_id === this.input.plan_id && details.proposal_id === this.input.proposal_id &&
        details.expected_plan_revision === this.input.expected_plan_revision &&
        details.expected_opportunity_revision === this.input.expected_opportunity_revision &&
        details.expected_proposal_revision === this.input.expected_proposal_revision &&
        details.preserved_input_hash === this.input.preserved_input_hash &&
        details.cancel_required && details.base_version_id === null && details.next_operation === "proposal.generate",
      "CURRENT_REQUEST_SERVER_DETAILS_CHANGED",
    );
    this.details = details;
    this.phase = "probe_checked";
    this.report.checks.push("current_contract_guard", "fresh_server_owned_details");
  }
  async prepare(body, key, persist) {
    check(this.phase === "probe_checked", "CURRENT_REQUEST_BATCH_ORDER_INVALID");
    check(UUID.test(key || ""), "CURRENT_REQUEST_IDEMPOTENCY_REQUIRED");
    // Claim before the canonical builder's first asynchronous digest as well
    // as before persistence; only this invocation may authorize a send.
    this.phase = "persisting";
    const expected = { commands: await currentProposalCommands(this.details) };
    check(canonical(body) === canonical(expected), "CURRENT_REQUEST_CANONICAL_BATCH_CHANGED");
    const body_sha256 = sha(JSON.stringify(body));
    const request = { idempotency_key: key, body, server_owned_details: this.details, body_sha256 };
    const ack = await persist(request);
    check(
      ack?.event === "persisted" && ack.body_sha256 === body_sha256 && HASH.test(ack.report_sha256 || ""),
      "CURRENT_REQUEST_DURABLE_RECEIPT_REQUIRED",
    );
    this.prepared = request;
    this.phase = "sending";
    this.report.request_body_sha256 = body_sha256;
    this.report.prepared_request_sha256 = ack.report_sha256;
    this.report.browser_commands.batch++;
    this.report.checks.push("canonical_frontend_commands", "request_persisted_before_send", "single_business_request");
  }
  observeBatch(status, body) {
    check(this.phase === "sending", "CURRENT_REQUEST_BATCH_ORDER_INVALID");
    if (status < 200 || status >= 300) {
      // A known command rejection is distinct from a lost post-commit response.
      const code = body?.error?.code;
      const definite = new Set(["AI_AGENTS_UNAVAILABLE", "MODEL_NOT_CONFIGURED", "REVISION_CONFLICT", "STALE_INPUT", "ROLE_FORBIDDEN", "FORBIDDEN", "UNAUTHENTICATED", "ACCESS_PENDING", "WORKSPACE_MISMATCH", "STORAGE_CAP_REACHED", "GENERATION_BUSY", "FILE_PROCESSING_BUSY"]);
      this.report.outcome = definite.has(code) ? "blocked" : "unknown";
      this.report.code = /^[A-Z][A-Z0-9_]{1,100}$/.test(code || "") ? code : "CURRENT_REQUEST_RESPONSE_UNKNOWN";
      this.phase = "finished";
      return;
    }
    const [old, next] = body?.data || [];
    check(
      Array.isArray(body?.data) && body.data.length === 2 && old?.id === this.input.plan_id &&
        old.workspace_id === this.input.workspace_id && old.status === "canceled" &&
        next?.id !== this.input.plan_id && UUID.test(next?.id || "") &&
        next.workspace_id === this.input.workspace_id && next.opportunity_id === this.input.opportunity_id &&
        next.proposal_id === this.input.proposal_id && next.kind === "proposal" &&
        next.frozen_context?.generated_delivery_version === 3 && next.frozen_context?.proposal_consistency_version === 1 &&
        UUID.test(next.issuance_request_id || ""),
      "CURRENT_REQUEST_SUCCESSOR_RESPONSE_INVALID",
    );
    this.report.successor_plan_id = next.id;
    this.report.issuance_request_id = next.issuance_request_id;
    this.report.outcome = "started";
    this.report.checks.push("frontend_received_successor");
    this.phase = "finished";
  }
  failure(error) {
    this.report.outcome = this.report.browser_commands.batch ? "unknown" : "failed";
    this.report.code = safeCode(error);
  }
}

export async function requestThroughBrowser(input, persist, engine = chromium, captureBrowser) {
  const guard = new CurrentRequestGuard(input), pending = new Set();
  let browser, server, violation = null, refreshes = 0, bootstrapVerified = false;
  let currentAccessToken = input.access_token, currentRefreshToken = input.session.refresh_token;
  try {
    check(typeof captureBrowser === "function", "CURRENT_REQUEST_BROWSER_CAPTURE_REQUIRED");
    server = await engine.launchServer({ host: "127.0.0.1", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
    const pid = server.process().pid;
    const captured = await captureBrowser(pid);
    check(captured?.event === "browser_captured" && captured.pid === pid, "CURRENT_REQUEST_BROWSER_CAPTURE_REQUIRED");
    browser = await engine.connect(server.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
    const storageKey = `sb-${new URL(input.origin).hostname.split(".")[0]}-auth-token`;
    await context.addInitScript(({ origin, key, session }) => {
      if (location.origin === origin) localStorage.setItem(key, JSON.stringify(session));
    }, { origin: input.origin, key: storageKey, session: input.session });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      try {
        if (["blob:", "data:"].includes(url.protocol)) return await route.continue();
        check(url.origin === input.origin, "CURRENT_REQUEST_BROWSER_ORIGIN_BLOCKED");
        if (["GET", "HEAD", "OPTIONS"].includes(method)) {
          if (url.pathname.startsWith("/functions/v1/api/")) guard.report.browser_api_reads++;
          return await route.continue();
        }
        if (method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
          check(++refreshes <= 3, "CURRENT_REQUEST_REFRESH_LIMIT");
          const body = JSON.parse(request.postData() || "null");
          check(body && Object.keys(body).length === 1 && body.refresh_token === currentRefreshToken, "CURRENT_REQUEST_REFRESH_IDENTITY_CHANGED");
          return await route.continue();
        }
        await Promise.all([...pending]);
        check(!violation && bootstrapVerified, violation || "CURRENT_REQUEST_BROWSER_MEMBERSHIP_REQUIRED");
        check(method === "POST" && url.pathname === COMMANDS && !url.search, "CURRENT_REQUEST_BROWSER_WRITE_BLOCKED");
        check(request.headers()["authorization"] === `Bearer ${currentAccessToken}`, "CURRENT_REQUEST_BROWSER_IDENTITY_CHANGED");
        const body = JSON.parse(request.postData() || "null"), key = request.headers()["idempotency-key"];
        if (guard.phase === "initial") guard.probe(body, key);
        else await guard.prepare(body, key, persist);
        return await route.continue();
      } catch (error) {
        violation = safeCode(error);
        guard.report.browser_commands.unexpected_mutations++;
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== input.origin || !["/auth/v1/token", "/functions/v1/api/v1/bootstrap"].includes(url.pathname)) return;
      const task = (async () => {
        check(response.ok(), "CURRENT_REQUEST_BROWSER_IDENTITY_FAILED");
        const value = await response.json();
        if (url.pathname === "/auth/v1/token") {
          check(value?.user?.id === input.actor_id && typeof value.access_token === "string" && value.access_token.length > 20 && typeof value.refresh_token === "string" && value.refresh_token.length > 0, "CURRENT_REQUEST_BROWSER_IDENTITY_CHANGED");
          currentAccessToken = value.access_token;
          currentRefreshToken = value.refresh_token;
        }
        else {
          check(value?.data?.membership?.user_id === input.actor_id && value.data.membership.workspace_id === input.workspace_id && value.data.membership.role === "Owner" && value.data.workspace?.id === input.workspace_id, "CURRENT_REQUEST_BROWSER_MEMBERSHIP_CHANGED");
          bootstrapVerified = true;
        }
      })().catch((error) => { violation = safeCode(error); });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    await page.goto(`${input.origin}/#/opportunities/${input.opportunity_id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const resume = page.getByRole("button", { name: "Resume saved work", exact: true });
    await resume.waitFor({ state: "visible", timeout: 600000 });
    await Promise.all([...pending]);
    check(!violation && bootstrapVerified, violation || "CURRENT_REQUEST_BROWSER_MEMBERSHIP_REQUIRED");
    guard.report.checks.push("genuine_browser_session");
    const commandResponse = () => page.waitForResponse((r) => new URL(r.url()).pathname === COMMANDS && r.request().method() === "POST", { timeout: 180000 });
    const probe = commandResponse();
    await resume.click();
    const probeResponse = await probe;
    check(!violation, violation);
    guard.observeProbe(probeResponse.status(), await probeResponse.json());
    const start = page.getByRole("button", { name: "Start new request with current checks", exact: true });
    await start.waitFor({ state: "visible", timeout: 30000 });
    const batch = commandResponse();
    await start.click();
    const batchResponse = await batch;
    check(!violation, violation);
    guard.observeBatch(batchResponse.status(), await batchResponse.json());
  } catch (error) {
    guard.failure(violation ? { code: violation } : error);
  } finally {
    if (server) {
      try { if (browser) await browser.close(); await server.close(); guard.report.browser_cleanup_confirmed = true; }
      catch { guard.failure({ code: "CURRENT_REQUEST_BROWSER_CLEANUP_FAILED" }); }
    }
  }
  const report = JSON.stringify(guard.report);
  check(!report.includes(input.access_token) && !report.includes(input.session.refresh_token), "CURRENT_REQUEST_SECRET_IN_REPORT");
  return guard.report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.info = console.warn = console.error = () => {};
  const inputLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = inputLines[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    check(!first.done && Buffer.byteLength(first.value) <= 65536, "CURRENT_REQUEST_INPUT_INVALID");
    const input = JSON.parse(first.value);
    const report = await requestThroughBrowser(input, async (request) => {
      process.stdout.write(JSON.stringify({ event: "prepared", request }) + "\n");
      const ack = await lines.next();
      check(!ack.done && Buffer.byteLength(ack.value) <= 4096, "CURRENT_REQUEST_DURABLE_RECEIPT_REQUIRED");
      return JSON.parse(ack.value);
    }, chromium, async (pid) => {
      process.stdout.write(JSON.stringify({ event: "browser_started", pid }) + "\n");
      const ack = await lines.next();
      check(!ack.done && Buffer.byteLength(ack.value) <= 4096, "CURRENT_REQUEST_BROWSER_CAPTURE_REQUIRED");
      return JSON.parse(ack.value);
    });
    process.stdout.write(JSON.stringify({ event: "result", report }) + "\n");
    process.exitCode = report.outcome === "started" ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ event: "result", report: { version: 1, kind: "actual_current_proposal_request", outcome: "failed", code: safeCode(error), browser_commands: { resume: 0, batch: 0, unexpected_mutations: 0 }, checks: [], browser_cleanup_confirmed: false, browser_api_reads: 0 } }) + "\n");
    process.exitCode = 1;
  } finally {
    inputLines.close();
    process.stdin.destroy();
  }
}
