#!/usr/bin/env node
// Real Chromium UI regression over the production build and isolated fixtures.
// Every browser request is fulfilled locally; no production account is used.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(repository, "backend/package.json"));
const { chromium } = require("playwright");
const dist = path.resolve(
  process.env.TENDERDESK_BROWSER_DIST || path.join(repository, "frontend/dist"),
);
const origin = "https://workspace-regression.test";
const workspace = "00000000-0000-4000-8000-000000000010";
const source = "00000000-0000-4000-8000-000000000011";
const foreignSource = "00000000-0000-4000-8000-000000000012";
const actor = "00000000-0000-4000-8000-000000000001";
const job = "00000000-0000-4000-8000-000000000013";
const historySize = 10501;
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const auditRows = Array.from({ length: historySize }, (_, index) => ({
  id: id(index + 1),
  action:
    index % 2
      ? `Other source event ${index + 1}`
      : `Fixture source event ${index + 1}`,
  entity_id: index % 2 ? foreignSource : source,
  actor_id: actor,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
const apiLists = new Set([
  "sources",
  "source-runs",
  "opportunities",
  "knowledge",
  "jobs",
  "notifications",
  "audit-events",
  "proposals",
  "documents",
  "proposal-versions",
  "proposal-sections",
  "questions",
  "review-inputs",
  "regeneration-requests",
  "requirements",
  "fit-assessments",
  "opportunity-discovery",
  "model-activity",
]);
const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function main() {
  assert(process.argv.length <= 3, "UNEXPECTED_ARGUMENTS");
  const expectOldFailure = process.argv[2] === "--expect-boundary-failure";
  assert(!process.argv[2] || expectOldFailure, "UNEXPECTED_ARGUMENT");
  assert(existsSync(path.join(dist, "index.html")), "FRONTEND_BUILD_REQUIRED");
  const screenshotDir = path.join(
    process.env.RUNNER_TEMP || "/tmp",
    "tenderdesk-workspace-browser",
  );
  await mkdir(screenshotDir, { recursive: true });
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath());
  assert(existsSync(executablePath), "CHROMIUM_EXECUTABLE_MISSING");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  const requests = [],
    violations = [],
    errors = [];
  let auditPageFailurePending = true;
  const envelope = (data) =>
    JSON.stringify({ data, meta: { request_id: "browser-fixture" } });
  const user = {
    id: actor,
    aud: "authenticated",
    role: "authenticated",
    email: "browser-fixture@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const session = {
    access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: actor, exp: expires, aud: "authenticated", role: "authenticated" })}.fixture-only-signature`,
    refresh_token: "fixture-only-refresh",
    expires_at: expires,
    expires_in: 3600,
    token_type: "bearer",
    user,
  };
  await context.addInitScript(
    ({ fixtureOrigin, fixtureSession }) => {
      if (location.origin === fixtureOrigin)
        localStorage.setItem(
          "sb-workspace-regression-auth-token",
          JSON.stringify(fixtureSession),
        );
    },
    { fixtureOrigin: origin, fixtureSession: session },
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push({
      path: url.pathname + url.search,
      method: request.method(),
    });
    if (url.origin !== origin || request.method() !== "GET") {
      violations.push({ path: url.pathname, method: request.method() });
      await route.abort();
      return;
    }
    const json = (data) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: envelope(data),
      });
    if (url.pathname === "/runtime-config.js") {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `window.__TENDERDESK_CONFIG__=${JSON.stringify({ apiUrl: origin, publishableKey: "fixture-only-publishable-key", appOrigin: origin })};`,
      });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(user),
      });
      return;
    }
    if (url.pathname === "/functions/v1/api/v1/bootstrap") {
      await json({
        membership: {
          user_id: actor,
          workspace_id: workspace,
          role: "Reviewer",
        },
        workspace: {
          id: workspace,
          revision: 1,
          name: "Isolated browser regression",
          settings: {},
        },
        operations: null,
      });
      return;
    }
    if (url.pathname === "/functions/v1/api/v1/status") {
      await json({
        change_token: "fixture",
        server_time: new Date().toISOString(),
        last_heartbeat_at: null,
        last_source_success_at: null,
        last_maintenance_at: null,
        scheduler_enabled: false,
        reserved_storage_bytes: "0",
        cleanup_bytes: "0",
        extracted_bytes: "0",
        database_bytes: "0",
        queued_jobs: 0,
        blocked_jobs: 0,
        cleanup_pending: 0,
        cleanup_blocked: 0,
        calls_today: 0,
        input_tokens_today: "0",
        output_tokens_today: "0",
        unknown_usage: 0,
        usage_day: "2026-01-01",
        model_enabled: false,
      });
      return;
    }
    const list = url.pathname.match(
      /^\/functions\/v1\/api\/v1\/([a-z-]+)$/,
    )?.[1];
    if (apiLists.has(list)) {
      let rows = [];
      if (list === "sources")
        rows = [
          {
            id: source,
            revision: 1,
            name: "Fixture source",
            kind: "rss",
            approval: "paused",
            url: "https://example.test/feed.xml",
            tags: [],
          },
        ];
      if (list === "jobs")
        rows = [
          {
            id: job,
            revision: 1,
            type: "source_collect",
            entity_id: source,
            status: "succeeded",
            attempts: 1,
            created_at: "2026-01-01T00:00:00Z",
          },
        ];
      if (list === "audit-events") rows = auditRows;
      const cursor = url.searchParams.get("cursor");
      if (
        !expectOldFailure &&
        list === "audit-events" &&
        cursor &&
        auditPageFailurePending
      ) {
        auditPageFailurePending = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "FIXTURE_HISTORY_UNAVAILABLE",
              message: "Fixture history is temporarily unavailable.",
            },
          }),
        });
        return;
      }
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      assert(!cursor || start > 0, "FIXTURE_CURSOR_NOT_FOUND");
      const limit = Number(url.searchParams.get("limit") || "100");
      assert(
        Number.isInteger(limit) && limit >= 1 && limit <= 500,
        "FIXTURE_LIMIT_INVALID",
      );
      const records = rows.slice(start, start + limit);
      await json({
        records,
        next_cursor: start + limit < rows.length ? records.at(-1).id : null,
      });
      return;
    }
    const relative =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (
      !/^(?:index\.html|favicon\.svg|assets\/[a-zA-Z0-9_.\/-]+)$/.test(
        relative,
      ) ||
      relative.includes("..")
    ) {
      violations.push({ path: url.pathname, method: "UNEXPECTED_GET" });
      await route.abort();
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: mime[path.extname(relative)] || "application/octet-stream",
        body: await readFile(path.join(dist, relative)),
      });
    } catch {
      violations.push({ path: url.pathname, method: "MISSING_BUILD_ASSET" });
      await route.abort();
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const auditRequests = () =>
    requests.filter((request) =>
      request.path.startsWith("/functions/v1/api/v1/audit-events?"),
    );
  const decisionVisible = async (action) =>
    page.waitForFunction(
      (expected) =>
        [
          ...document.querySelectorAll(
            'section[aria-label="Decision history"] li',
          ),
        ].some((item) => item.firstChild?.textContent === expected),
      action,
    );
  try {
    await page.goto(`${origin}/#/jobs`);
    if (expectOldFailure) {
      await page
        .getByRole("heading", { name: "Workspace unavailable", exact: true })
        .waitFor({ timeout: 30000 });
      assert(
        await page
          .getByText("Workspace results exceeded the supported boundary.", {
            exact: true,
          })
          .isVisible(),
        "OLD_BOUNDARY_ERROR_NOT_REPRODUCED",
      );
      assert.equal(auditRequests().length, 20, "OLD_AUDIT_BOUNDARY_PAGE_COUNT");
      await page.screenshot({
        path: path.join(screenshotDir, "old-workspace-boundary-failure.png"),
        fullPage: true,
      });
      assert.deepEqual(violations, [], "UNEXPECTED_FIXTURE_NETWORK");
      console.log(
        JSON.stringify({
          probe: "workspace_boot_browser_fixture",
          status: "old_failure_reproduced",
          audit_fixture_records: historySize,
          audit_requests: auditRequests().length,
          production_requests: 0,
        }),
      );
      return;
    }
    await page
      .getByRole("heading", { name: "Activity & jobs", exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(auditRequests().length, 0, "BOOT_MUST_NOT_LOAD_AUDIT_HISTORY");
    assert.equal(
      await page.getByText("Workspace unavailable", { exact: true }).count(),
      0,
      "WORKSPACE_BLOCKED",
    );
    await page.screenshot({
      path: path.join(screenshotDir, "jobs-open.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "From opportunity to proposal.",
        exact: true,
      })
      .waitFor();
    assert.equal(
      auditRequests().length,
      0,
      "DASHBOARD_MUST_NOT_LOAD_AUDIT_HISTORY",
    );
    await page.screenshot({
      path: path.join(screenshotDir, "overview-open.png"),
      fullPage: true,
    });
    await page.goto(`${origin}/#/sources/${source}`);
    await page
      .getByRole("heading", { name: "Fixture source", exact: true })
      .waitFor();
    await decisionVisible("Fixture source event 1");
    assert.equal(
      auditRequests().length,
      1,
      "SOURCE_HISTORY_MUST_LOAD_ONE_PAGE",
    );
    assert.equal(
      await page
        .locator('section[aria-label="Decision history"] li')
        .filter({ hasText: "Other source event" })
        .count(),
      0,
      "FOREIGN_SOURCE_EVENT_DISPLAYED",
    );
    await page
      .getByRole("button", { name: "Load more workspace events", exact: true })
      .click();
    await page
      .getByText("Fixture history is temporarily unavailable.", { exact: true })
      .waitFor();
    await decisionVisible("Fixture source event 1");
    assert(
      await page
        .getByRole("heading", { name: "Fixture source", exact: true })
        .isVisible(),
      "AUDIT_FAILURE_HID_SOURCE",
    );
    assert.equal(
      await page.getByText("Workspace unavailable", { exact: true }).count(),
      0,
      "AUDIT_FAILURE_BLOCKED_WORKSPACE",
    );
    await page
      .getByRole("button", { name: "Retry loading history", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "source-history-retry.png"),
    });
    await page
      .getByRole("button", { name: "Retry loading history", exact: true })
      .click();
    await decisionVisible("Fixture source event 501");
    assert.equal(
      auditRequests().length,
      3,
      "SOURCE_HISTORY_MUST_RETRY_ONE_PAGE",
    );
    assert(
      auditRequests()[1].path.includes(`cursor=${id(500)}`),
      "SOURCE_HISTORY_CURSOR_NOT_USED",
    );
    assert.equal(
      auditRequests()[1].path,
      auditRequests()[2].path,
      "SOURCE_HISTORY_RETRY_CHANGED_CURSOR",
    );
    await page
      .getByRole("heading", { name: "Fixture source", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, "source-history-paged.png"),
    });
    assert.deepEqual(errors, [], "BROWSER_RUNTIME_ERRORS");
    assert.deepEqual(violations, [], "UNEXPECTED_FIXTURE_NETWORK");
    console.log(
      JSON.stringify({
        probe: "workspace_boot_browser_fixture",
        status: "passed",
        audit_fixture_records: historySize,
        audit_requests_on_boot: 0,
        audit_requests_after_user_paging: auditRequests().length,
        jobs_visible: true,
        overview_visible: true,
        source_history_paged: true,
        source_history_failure_isolated: true,
        source_history_retry_preserved_cursor: true,
        production_requests: 0,
        real_auth_verified: false,
      }),
    );
  } catch (error) {
    await page
      .screenshot({
        path: path.join(screenshotDir, "workspace-regression-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      probe: "workspace_boot_browser_fixture",
      status: "failed",
      message: String(error.message).slice(0, 1500),
    }),
  );
  process.exitCode = 1;
});
