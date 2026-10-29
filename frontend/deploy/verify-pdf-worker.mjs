#!/usr/bin/env node
// Verify deployed production assets and real PDF extraction without signing in
// or writing application records. Build frontend/dist before running this probe.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const probe = "frontend_pdf_worker";

async function verify() {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node frontend/deploy/verify-pdf-worker.mjs ORIGIN",
  );
  const origin = new URL(process.argv[2]);
  assert(
    ["http:", "https:"].includes(origin.protocol),
    "ORIGIN_PROTOCOL_INVALID",
  );
  assert(
    !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/",
    "ORIGIN_INVALID",
  );
  const repository = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const require = createRequire(path.join(repository, "backend/package.json"));
  const { chromium, request } = require("playwright");
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const dist = path.join(repository, "frontend/dist");
  const assetsDirectory = path.join(dist, "assets");
  const names = await readdir(assetsDirectory);
  const workers = names.filter((name) =>
    /^extraction\.worker-[\w-]+\.js$/.test(name),
  );
  assert.equal(workers.length, 1, "PRODUCTION_EXTRACTION_WORKER_NOT_UNIQUE");
  const extractionWorker = workers[0];
  const extractionSource = await readFile(
    path.join(assetsDirectory, extractionWorker),
    "utf8",
  );
  const pdfWorkers = names.filter(
    (name) =>
      /^pdf\.worker[^/]*\.mjs$/.test(name) && extractionSource.includes(name),
  );
  assert.equal(pdfWorkers.length, 1, "PRODUCTION_PDF_WORKER_NOT_UNIQUE");
  const pdfWorker = pdfWorkers[0];
  const extractionUrl = new URL(`assets/${extractionWorker}`, origin);
  const pdfUrl = new URL(`assets/${pdfWorker}`, origin);
  pdfUrl.searchParams.set("module-mime", "javascript-v1");
  const index = await readFile(path.join(dist, "index.html"), "utf8");
  const linkedAssets = [
    ...index.matchAll(/(?:src|href)=["']([^"']+\.(?:m?js|css))["']/g),
  ]
    .map((match) => new URL(match[1], origin))
    .filter(
      (url) =>
        url.origin === origin.origin && url.pathname.startsWith("/assets/"),
    );
  assert(
    linkedAssets.some((url) => url.pathname.endsWith(".css")),
    "PRODUCTION_STYLESHEET_MISSING",
  );
  const urls = [
    ...new Set([
      extractionUrl.href,
      pdfUrl.href,
      ...linkedAssets.map((url) => url.href),
    ]),
  ];

  // Respect the managed environment's proxy for remote acceptance probes.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  const configuredProxy = loopback
    ? undefined
    : process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  let proxy;
  if (configuredProxy) {
    const url = new URL(configuredProxy);
    proxy = { server: url.origin };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    if (process.env.NO_PROXY) proxy.bypass = process.env.NO_PROXY;
  }
  const http = await request.newContext({ proxy, timeout: 20_000 });
  let browser;
  const reports = [];
  try {
    for (const urlString of urls) {
      const url = new URL(urlString);
      const response = await http.get(url.href, { maxRedirects: 0 });
      assert.equal(
        response.status(),
        200,
        "ASSET_HTTP_STATUS_INVALID: " + url.pathname,
      );
      const headers = response.headers();
      const contentType = (headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      assert(
        url.pathname.endsWith(".css")
          ? contentType === "text/css"
          : ["application/javascript", "text/javascript"].includes(contentType),
        "ASSET_MIME_INVALID: " + url.pathname,
      );
      const contentTypeOptions = (headers["x-content-type-options"] || "")
        .split(",")
        .map((value) => value.trim().toLowerCase());
      assert(
        contentTypeOptions.every((value) => value === "nosniff"),
        "ASSET_NOSNIFF_MISSING: " + url.pathname,
      );
      for (const directive of ["public", "max-age=31536000", "immutable"])
        assert(
          (headers["cache-control"] || "").toLowerCase().includes(directive),
          "ASSET_CACHE_INVALID: " + url.pathname,
        );
      const actual = await response.body();
      const expected = await readFile(
        path.join(assetsDirectory, path.posix.basename(url.pathname)),
      );
      assert.equal(
        createHash("sha256").update(actual).digest("hex"),
        createHash("sha256").update(expected).digest("hex"),
        "DEPLOYED_ASSET_CONTENT_MISMATCH: " + url.pathname,
      );
      reports.push({
        path: url.pathname + url.search,
        status: response.status(),
        contentType,
        bytes: actual.length,
      });
      await response.dispose();
    }
    for (const extension of ["mjs", "js", "css"]) {
      const response = await http.get(
        new URL(`assets/__pdf_worker_probe_missing__.${extension}`, origin)
          .href,
        { maxRedirects: 0 },
      );
      assert.equal(
        response.status(),
        404,
        "MISSING_ASSET_DID_NOT_RETURN_404: " + extension,
      );
      await response.dispose();
    }

    const expectedText =
      "Tenderdesk production PDF worker verifies genuine document extraction.";
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage([612, 792])
      .drawText(expectedText, { x: 40, y: 720, size: 12, font });
    const bytes = await pdf.save();
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const executablePath =
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : chromium.executablePath());
    assert(existsSync(executablePath), "CHROMIUM_EXECUTABLE_MISSING");
    browser = await chromium.launch({
      executablePath,
      proxy,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const observed = [];
    const browserErrors = [];
    context.on("request", (request) =>
      observed.push({ url: request.url(), method: request.method() }),
    );
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    // The health document establishes the real origin without booting the app.
    const health = await page.goto(new URL("healthz", origin).href, {
      waitUntil: "load",
    });
    assert.equal(health.status(), 200, "FRONTEND_HEALTH_UNAVAILABLE");
    assert(
      await page.evaluate(() => isSecureContext),
      "SECURE_BROWSER_CONTEXT_REQUIRED",
    );
    const result = await page.evaluate(
      ({ workerUrl, bytes }) =>
        new Promise((resolve) => {
          const worker = new Worker(workerUrl, { type: "module" });
          const finish = (result) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(result);
          };
          const timer = setTimeout(
            () => finish({ error: "PDF_EXTRACTION_TIMEOUT" }),
            45_000,
          );
          worker.onmessage = ({ data }) => {
            // Ignore PDF.js handshakes; only the app's result envelope completes.
            if (data?.kind === "document-result") finish(data);
          };
          worker.onerror = (event) =>
            finish({ error: event.message || "EXTRACTION_WORKER_FAILED" });
          worker.postMessage({
            file: new File(
              [new Uint8Array(bytes)],
              "synthetic-production-probe.pdf",
              { type: "application/pdf" },
            ),
            classification: "unspecified",
          });
        }),
      { workerUrl: extractionUrl.href, bytes: Array.from(bytes) },
    );
    assert(!result.error, "PDF_EXTRACTION_FAILED: " + result.error);
    assert.equal(
      result.document.status,
      "ready",
      "EXTRACTED_DOCUMENT_NOT_READY",
    );
    assert(
      result.document.text.includes(expectedText),
      "EXTRACTED_TEXT_MISMATCH",
    );
    assert.equal(
      result.document.hash,
      expectedHash,
      "EXTRACTED_FILE_HASH_MISMATCH",
    );
    assert.equal(
      result.document.size,
      bytes.length,
      "EXTRACTED_FILE_SIZE_MISMATCH",
    );
    assert(
      observed.some((entry) => entry.url === pdfUrl.href),
      "VERSIONED_PDF_WORKER_NOT_REQUESTED",
    );
    assert(
      observed.every((entry) => {
        const url = new URL(entry.url);
        return (
          entry.method === "GET" &&
          url.origin === origin.origin &&
          (url.pathname.startsWith("/assets/") ||
            ["/healthz", "/favicon.ico"].includes(url.pathname))
        );
      }),
      "UNEXPECTED_NONSTATIC_REQUEST",
    );
    assert.equal(
      browserErrors.length,
      0,
      "BROWSER_ERROR_DURING_PDF_EXTRACTION",
    );
    console.log(
      JSON.stringify({
        probe,
        status: "passed",
        origin: origin.origin,
        assets: reports,
        workerRequest: pdfUrl.pathname + pdfUrl.search,
        missingAssetsReturn404: true,
        extraction: {
          status: result.document.status,
          syntheticPdf: true,
          textVerified: true,
          sha256Verified: true,
          bytes: bytes.length,
        },
        applicationRecordsWritten: false,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await http.dispose();
  }
}

try {
  await verify();
} catch (error) {
  console.log(
    JSON.stringify({
      probe,
      status: "failed",
      code: error instanceof Error ? error.message : "VERIFICATION_FAILED",
    }),
  );
  process.exitCode = 1;
}
