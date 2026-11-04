/** Explicitly selected real draft export acceptance. Never starts generation or approves content. */
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { unzipSync } from "fflate";
import { renderDocx } from "../../../frontend/src/lib/renderDocx.ts";
import {
  verifyExportDocx,
  exportParagraphs,
} from "../../supabase/functions/_shared/export.ts";

export const LIMITS = Object.freeze({
  volumes: 2,
  httpRequests: 32,
  browserApiReads: 700,
  browserMutations: 8,
  bytesPerArtifact: 10485760,
  reportBytes: 32 * 1024 * 1024,
});
const MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const check = (ok, code) => {
  if (!ok) throw new AcceptanceError(code);
};
const safeCode = (error) =>
  typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code
    : "EXPORT_ACCEPTANCE_FAILED";

export function validateInput(input) {
  check(
    input && typeof input === "object" && !Array.isArray(input),
    "EXPORT_SELECTION_INVALID",
  );
  const origin = new URL(input.origin);
  check(
    origin.protocol === "https:" &&
      origin.origin === input.origin &&
      !origin.username &&
      !origin.password,
    "EXPORT_ORIGIN_INVALID",
  );
  for (const field of [
    "workspace_id",
    "actor_id",
    "opportunity_id",
    "plan_id",
    "proposal_id",
    "proposal_version_id",
  ])
    check(
      typeof input[field] === "string" && UUID.test(input[field]),
      "EXPORT_SELECTION_INVALID",
    );
  check(
    Number.isSafeInteger(input.expected_revision) &&
      input.expected_revision > 0 &&
      /^[0-9]{1,20}$/.test(input.run_id),
    "EXPORT_SELECTION_INVALID",
  );
  check(
    typeof input.access_token === "string" &&
      input.access_token.length > 20 &&
      input.access_token.length < 16384,
    "EXPORT_SESSION_INVALID",
  );
  const mode = input.mode ?? "browser";
  check(["browser", "http"].includes(mode), "EXPORT_MODE_INVALID");
  if (mode === "browser")
    check(
      input.session?.access_token === input.access_token &&
        input.session?.user?.id === input.actor_id &&
        typeof input.session?.refresh_token === "string" &&
        input.session.refresh_token.length > 0,
      "EXPORT_SESSION_INVALID",
    );
  return { ...input, mode };
}

function identity(record, id, input) {
  check(
    record?.id === id && record.workspace_id === input.workspace_id,
    "EXPORT_RECORD_IDENTITY_MISMATCH",
  );
}
function artifactIdentity(artifact, request, input) {
  identity(artifact, artifact?.id, input);
  check(
    UUID.test(artifact.id) &&
      artifact.export_id === request.id &&
      artifact.kind === "generated" &&
      artifact.mime_type === MIME &&
      artifact.storage_key === `${input.workspace_id}/exports/${artifact.id}`,
    "EXPORT_ARTIFACT_IDENTITY_MISMATCH",
  );
}
function contextIdentity(value, request, input, ordinal) {
  identity(value?.request, request.id, input);
  check(
    value.request.proposal_version_id === input.proposal_version_id &&
      value.request.mode === "draft" &&
      value.request.volume === request.volume &&
      value.model?.id === request.id &&
      value.model.mode === "draft" &&
      value.model.volume === request.volume &&
      value.model.version === ordinal &&
      ["en", "ar"].includes(value.model.language) &&
      Array.isArray(value.model.blocks),
    "EXPORT_CONTEXT_MISMATCH",
  );
}
function exportProof(bytes, model, artifact) {
  check(
    bytes.length > 0 &&
      bytes.length <= LIMITS.bytesPerArtifact &&
      sha(bytes) === artifact.content_hash &&
      bytes.length === Number(artifact.expected_size),
    "EXPORT_DOWNLOADED_HASH_MISMATCH",
  );
  verifyExportDocx(bytes, model);
  const files = unzipSync(bytes),
    xml = new TextDecoder().decode(files["word/document.xml"]);
  const embeddedFonts = Object.keys(files).filter((name) =>
    name.endsWith(".odttf"),
  ).length;
  check(
    embeddedFonts === 4 && /TOC/.test(xml),
    "EXPORT_DOCUMENT_STRUCTURE_INVALID",
  );
  if (model.language === "ar")
    check(xml.includes("w:bidi"), "EXPORT_ARABIC_DIRECTION_MISSING");
  return {
    language: model.language,
    blocks: model.blocks.length,
    paragraphs: exportParagraphs(model).length,
    tables: model.blocks.filter((b) => b.type === "table").length,
    embedded_fonts: embeddedFonts,
    exact_authorized_content: true,
    visual_layout_reviewed: false,
  };
}

/** A browser blob is accepted only after an independently authenticated GET. */
export async function verifyServerRoundtrip(
  browserBytes,
  artifact,
  model,
  download,
) {
  const response = await download(artifact.id);
  check(response.ok, "EXPORT_SERVER_DOWNLOAD_FAILED");
  const reader = response.body?.getReader();
  check(reader, "EXPORT_SERVER_DOWNLOAD_FAILED");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMITS.bytesPerArtifact) {
      void reader.cancel();
      throw new AcceptanceError("EXPORT_DOCUMENT_TOO_LARGE");
    }
    chunks.push(value);
  }
  const serverBytes = Buffer.concat(chunks);
  const proof = exportProof(serverBytes, model, artifact);
  check(
    Buffer.from(browserBytes).equals(serverBytes),
    "EXPORT_BROWSER_SERVER_BYTES_MISMATCH",
  );
  return { ...proof, authenticated_server_download_verified: true };
}

/** Historical browser-protocol guard retained for v1 regression fixtures.
 * The current browser execution uses durableBrowserWriteAllowed below. */
export function browserWriteAllowed(path, method, raw, state, input) {
  if (method === "POST" && path === "/functions/v1/api/v1/commands") {
    let body;
    try {
      body = JSON.parse(raw || "");
    } catch {
      return false;
    }
    if (!Array.isArray(body.commands) || body.commands.length !== 1)
      return false;
    const { operation, input: value } = body.commands[0];
    if (operation === "export.prepare")
      return (
        value?.proposal_version_id === input.proposal_version_id &&
        value.expected_revision === input.expected_revision &&
        value.mode === "draft" &&
        state.volumes.includes(value.volume) &&
        !state.preparedVolumes.has(value.volume) &&
        Object.keys(value).sort().join() ===
          "expected_revision,mode,proposal_version_id,volume"
      );
    if (operation === "export.reserve")
      return (
        state.contexts.has(value?.export_id) &&
        value.kind === "generated" &&
        value.mime_type === MIME &&
        value.review_attested === false &&
        Number.isSafeInteger(value.size) &&
        value.size > 0 &&
        value.size <= LIMITS.bytesPerArtifact &&
        /^[a-f0-9]{64}$/.test(value.hash) &&
        !state.reservedExports.has(value.export_id)
      );
    return false;
  }
  if (
    method === "POST" &&
    path.startsWith("/storage/v1/object/tenderdesk-private/")
  )
    return [...state.artifacts.values()].some(
      (a) =>
        path === `/storage/v1/object/tenderdesk-private/${a.storage_key}` &&
        !state.uploaded.has(a.id),
    );
  const complete = path.match(
    /^\/functions\/v1\/api\/v1\/export-artifacts\/([0-9a-f-]{36})\/complete$/,
  );
  return (
    method === "POST" &&
    !!complete &&
    state.artifacts.has(complete[1]) &&
    state.uploaded.has(complete[1]) &&
    !state.completed.has(complete[1])
  );
}

/** New browser path permits only one exact whole-package preparation. The
 * explicit HTTP path below intentionally retains its historical v1 behavior. */
export function durableBrowserWriteAllowed(path, method, raw, state, input) {
  if (
    method !== "POST" ||
    path !== "/functions/v1/api/v1/commands" ||
    state.prepared
  )
    return false;
  try {
    const body = JSON.parse(raw || "");
    if (
      Object.keys(body).join() !== "commands" ||
      !Array.isArray(body.commands) ||
      body.commands.length !== 1
    )
      return false;
    const command = body.commands[0],
      value = command.input;
    return (
      Object.keys(command).sort().join() === "input,operation" &&
      command.operation === "export.package.prepare" &&
      value?.proposal_version_id === input.proposal_version_id &&
      value.expected_revision === input.expected_revision &&
      value.mode === "draft" &&
      Object.keys(value).sort().join() ===
        "expected_revision,mode,proposal_version_id"
    );
  } catch {
    return false;
  }
}
export function observeDurablePackage(value, state, input, volumes) {
  check(
    UUID.test(value?.id || "") &&
      value.proposal_version_id === input.proposal_version_id &&
      value.mode === "draft" &&
      Number.isSafeInteger(value.revision) &&
      ["preparing", "ready", "blocked"].includes(value.status),
    "EXPORT_DURABLE_PACKAGE_INVALID",
  );
  check(
    Number.isFinite(Date.parse(value.server_now)) &&
      Date.parse(value.deadline_at) - Date.parse(value.accepted_at) === 600000,
    "EXPORT_DURABLE_CLOCK_INVALID",
  );
  const prior = state.package;
  check(
    !prior ||
      (prior.id === value.id &&
        prior.accepted_at === value.accepted_at &&
        prior.deadline_at === value.deadline_at),
    "EXPORT_DURABLE_IDENTITY_CHANGED",
  );
  check(
    Array.isArray(value.artifacts) &&
      JSON.stringify(value.artifacts.map((a) => a.volume).sort()) ===
        JSON.stringify([...volumes].sort()),
    "EXPORT_VOLUME_COVERAGE_INVALID",
  );
  if (value.status === "ready")
    check(
      value.job?.status === "succeeded" &&
        value.artifacts.every(
          (a) =>
            UUID.test(a.id || "") &&
            UUID.test(a.export_id || "") &&
            a.status === "ready" &&
            /^[a-f0-9]{64}$/.test(a.content_hash || "") &&
            Number.isSafeInteger(Number(a.expected_size)) &&
            Number(a.expected_size) > 0 &&
            Number(a.expected_size) <= LIMITS.bytesPerArtifact,
        ),
      "EXPORT_DURABLE_PACKAGE_INCOMPLETE",
    );
  state.package = value;
  return value;
}
async function acceptDurableBrowser(
  input,
  version,
  volumes,
  report,
  api,
  http,
  readSelected,
) {
  const state = { prepared: false, package: null },
    pending = new Set(),
    downloads = [];
  let violation = null,
    failure = null;
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ],
  });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
    });
    const storageKey = `sb-${new URL(input.origin).hostname.split(".")[0]}-auth-token`;
    await context.addInitScript(
      ({ origin, key, session }) => {
        if (window.location.origin === origin)
          localStorage.setItem(key, JSON.stringify(session));
      },
      { origin: input.origin, key: storageKey, session: input.session },
    );
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      if (["blob:", "data:"].includes(url.protocol)) return route.continue();
      if (url.origin !== input.origin) {
        violation = "EXPORT_BROWSER_ORIGIN_BLOCKED";
        return route.abort();
      }
      if (["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (
          url.pathname.startsWith("/functions/v1/api/") &&
          ++report.browser_api_reads > LIMITS.browserApiReads
        ) {
          violation = "EXPORT_BROWSER_READ_LIMIT";
          return route.abort();
        }
        return route.continue();
      }
      if (
        method === "POST" &&
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "refresh_token"
      ) {
        if (++report.browser_auth_refreshes > 3) {
          violation = "EXPORT_BROWSER_REFRESH_LIMIT";
          return route.abort();
        }
        return route.continue();
      }
      await Promise.all([...pending]);
      if (
        !durableBrowserWriteAllowed(
          url.pathname,
          method,
          request.postData(),
          state,
          input,
        )
      ) {
        violation = "EXPORT_BROWSER_WRITE_BLOCKED";
        return route.abort();
      }
      state.prepared = true;
      report.browser_mutations++;
      return route.continue();
    });
    const page = await context.newPage();
    page.on("response", (response) => {
      const task = (async () => {
        const url = new URL(response.url()),
          path = url.pathname,
          request = response.request();
        if (url.origin !== input.origin) return;
        if (request.method() === "POST" && path === "/auth/v1/token") {
          check(response.ok(), "EXPORT_BROWSER_SESSION_REFRESH_FAILED");
          const session = await response.json();
          check(
            session?.user?.id === input.actor_id,
            "EXPORT_BROWSER_SESSION_IDENTITY_CHANGED",
          );
          return;
        }
        if (
          request.method() === "POST" &&
          path === "/functions/v1/api/v1/commands"
        ) {
          check(response.ok(), "EXPORT_BROWSER_COMMAND_FAILED");
          const body = await response.json();
          check(body?.data?.length === 1, "EXPORT_COMMAND_RESULT_INVALID");
          observeDurablePackage(body.data[0], state, input, volumes);
        } else if (
          request.method() === "GET" &&
          /^\/functions\/v1\/api\/v1\/export-packages\/[^/]+$/.test(path)
        ) {
          check(response.ok(), "EXPORT_PACKAGE_CURRENTNESS_FAILED");
          const body = await response.json();
          observeDurablePackage(body.data, state, input, volumes);
        }
        if (state.package?.status === "blocked")
          failure = "EXPORT_DURABLE_PREPARATION_BLOCKED";
      })().catch((error) => {
        failure = safeCode(error);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    page.on("download", (download) => downloads.push(download));
    await page.goto(`${input.origin}/#/proposals/${input.proposal_id}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const button = page.getByRole("button", {
      name: "Download complete draft Word",
      exact: true,
    });
    await button.waitFor({ state: "visible", timeout: 90000 });
    check(!violation && !failure, violation || failure);
    await readSelected();
    report.checks.push("selected_owner_and_version_current_before_export");
    await button.click();
    const end = Date.now() + 660000;
    while (
      downloads.length < volumes.length &&
      Date.now() < end &&
      !violation &&
      !failure
    )
      await new Promise((resolve) => setTimeout(resolve, 200));
    await Promise.all([...pending]);
    check(!violation && !failure, violation || failure);
    check(
      downloads.length === volumes.length && state.package?.status === "ready",
      "EXPORT_BROWSER_DOWNLOAD_INCOMPLETE",
    );
    const saved = observeDurablePackage(
      await api(`/v1/export-packages/${state.package.id}`),
      state,
      input,
      volumes,
    );
    check(saved.status === "ready", "EXPORT_DURABLE_PACKAGE_INCOMPLETE");
    report.durable_package = {
      id: saved.id,
      revision: saved.revision,
      accepted_at: saved.accepted_at,
      deadline_at: saved.deadline_at,
      status: saved.status,
    };
    report.export_path = "durable_server_package";
    for (const download of downloads) {
      check(!(await download.failure()), "EXPORT_BROWSER_DOWNLOAD_FAILED");
      const file = await download.path();
      check(file, "EXPORT_BROWSER_DOWNLOAD_FAILED");
      check(
        (await stat(file)).size <= LIMITS.bytesPerArtifact,
        "EXPORT_DOCUMENT_TOO_LARGE",
      );
      const bytes = new Uint8Array(await readFile(file)),
        hash = sha(bytes),
        artifact = saved.artifacts.find((a) => a.content_hash === hash);
      check(
        artifact && !report.artifacts.some((a) => a.id === artifact.id),
        "EXPORT_DOWNLOADED_HASH_MISMATCH",
      );
      const data = await api(`/v1/exports/${artifact.export_id}/context`);
      contextIdentity(
        data,
        { id: artifact.export_id, volume: artifact.volume },
        input,
        version.ordinal,
      );
      const proof = await verifyServerRoundtrip(
        bytes,
        artifact,
        data.model,
        (id) => http(`/functions/v1/api/v1/export-artifacts/${id}/download`),
      );
      report.created_exports.push({
        id: artifact.export_id,
        volume: artifact.volume,
        mode: "draft",
      });
      report.reserved_artifacts.push({
        id: artifact.id,
        export_id: artifact.export_id,
        content_hash: artifact.content_hash,
        bytes: bytes.length,
      });
      report.artifacts.push({
        id: artifact.id,
        export_id: artifact.export_id,
        volume: artifact.volume,
        original_name: artifact.original_name,
        status: "ready",
        verification: "generated_content",
        content_hash: hash,
        bytes: bytes.length,
        ...proof,
        docx_base64: Buffer.from(bytes).toString("base64"),
      });
    }
    const final = observeDurablePackage(
      await api(`/v1/export-packages/${saved.id}`),
      state,
      input,
      volumes,
    );
    check(
      final.status === "ready" &&
        JSON.stringify(final.artifacts) === JSON.stringify(saved.artifacts),
      "EXPORT_PACKAGE_CHANGED_AFTER_DOWNLOAD",
    );
    report.checks.push(
      "actual_deployed_editor_download_clicked",
      "browser_writes_restricted_to_one_durable_draft_prepare",
      "server_rendered_complete_durable_package",
      "original_600s_export_deadline_preserved",
    );
  } finally {
    await browser.close();
  }
}

export async function acceptProposalExport(rawInput, fetcher = fetch) {
  const input = validateInput(rawInput),
    selected = Object.fromEntries(
      [
        "workspace_id",
        "actor_id",
        "opportunity_id",
        "plan_id",
        "proposal_id",
        "proposal_version_id",
        "expected_revision",
      ].map((k) => [k, input[k]]),
    );
  const report = {
    version: 1,
    kind: "actual_proposal_draft_export",
    mode: input.mode,
    passed: false,
    selection: selected,
    checks: [],
    readiness: null,
    created_exports: [],
    reserved_artifacts: [],
    artifacts: [],
    requests: 0,
    browser_api_reads: 0,
    browser_mutations: 0,
    browser_auth_refreshes: 0,
    model_calls: 0,
    approval_commands: 0,
  };
  let browser;
  const http = async (path, options = {}, token = true) => {
    check(
      path.startsWith("/") &&
        !path.startsWith("//") &&
        !/[\r\n#]/.test(path) &&
        new URL(path, input.origin).origin === input.origin,
      "EXPORT_REQUEST_ORIGIN_INVALID",
    );
    check(report.requests < LIMITS.httpRequests, "EXPORT_REQUEST_LIMIT");
    report.requests++;
    const response = await fetcher(input.origin + path, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${input.access_token}` } : {}),
        ...(options.headers || {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    check(response.ok, `EXPORT_HTTP_${response.status}`);
    return response;
  };
  const api = async (path, options = {}) => {
    const response = await http(`/functions/v1/api${path}`, options);
    const body = await response.json();
    check(body && Object.hasOwn(body, "data"), "EXPORT_API_ENVELOPE_INVALID");
    return body.data;
  };
  const command = (operation, value, key) =>
    api("/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `draft-acceptance:${input.run_id}:${key}`,
      },
      body: JSON.stringify({ commands: [{ operation, input: value }] }),
    }).then((rows) => {
      check(
        Array.isArray(rows) && rows.length === 1,
        "EXPORT_COMMAND_RESULT_INVALID",
      );
      return rows[0];
    });
  const readSelected = async () => {
    const bootstrap = await api("/v1/bootstrap");
    check(
      bootstrap?.membership?.user_id === input.actor_id &&
        bootstrap.membership.workspace_id === input.workspace_id &&
        bootstrap.workspace?.id === input.workspace_id &&
        bootstrap.membership.role === "Owner",
      "EXPORT_MEMBERSHIP_MISMATCH",
    );
    const version = await api(
        `/v1/proposal-versions/${input.proposal_version_id}`,
      ),
      plan = await api(`/v1/generation-plans/${input.plan_id}`),
      proposal = await api(`/v1/proposals/${input.proposal_id}`);
    identity(version, input.proposal_version_id, input);
    identity(plan, input.plan_id, input);
    identity(proposal, input.proposal_id, input);
    check(
      version.plan_id === input.plan_id &&
        version.proposal_id === input.proposal_id &&
        version.revision === input.expected_revision &&
        proposal.active_version_id === version.id &&
        proposal.opportunity_id === input.opportunity_id &&
        plan.opportunity_id === input.opportunity_id &&
        plan.proposal_id === proposal.id &&
        plan.kind === "proposal" &&
        plan.status === "completed" &&
        version.status !== "superseded",
      "EXPORT_SELECTED_VERSION_NOT_CURRENT",
    );
    return { version, plan, proposal };
  };
  try {
    const { version } = await readSelected();
    report.readiness = await api(
      `/v1/proposal-versions/${version.id}/readiness`,
    );
    check(
      Array.isArray(report.readiness?.blockers),
      "EXPORT_READINESS_INVALID",
    );
    report.checks.push(
      "genuine_selected_member",
      "completed_selected_plan",
      "current_exact_proposal_version",
      "approval_readiness_observed_without_approval",
    );
    const volumes = version.separate_volumes
      ? ["technical", "financial"]
      : ["combined"];
    const fonts = {},
      manifest = JSON.parse(
        await readFile(
          new URL(
            "../../../frontend/public/fonts/manifest.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    for (const entry of manifest) {
      check(
        /^(Amiri|Carlito)-(Regular|Bold)\.ttf$/.test(entry.file),
        "EXPORT_FONT_MANIFEST_INVALID",
      );
      const bytes = new Uint8Array(
        await (await http(`/fonts/${entry.file}`, {}, false)).arrayBuffer(),
      );
      check(
        bytes.length < 4 * 1024 * 1024 && sha(bytes) === entry.sha256,
        "EXPORT_HOSTED_FONT_HASH_MISMATCH",
      );
      fonts[entry.file.slice(0, -4)] = bytes;
    }
    report.checks.push("hosted_licensed_font_hashes_verified");
    if (input.mode === "http") {
      report.export_path = "legacy_explicit_http_render_upload";
      await readSelected();
      report.checks.push("selected_owner_and_version_current_before_export");
      for (const volume of volumes) {
        const request = await command(
          "export.prepare",
          {
            proposal_version_id: version.id,
            expected_revision: version.revision,
            mode: "draft",
            volume,
          },
          `prepare:${volume}`,
        );
        identity(request, request?.id, input);
        check(UUID.test(request.id), "EXPORT_REQUEST_ID_INVALID");
        report.created_exports.push({ id: request.id, volume, mode: "draft" });
        const context = await api(`/v1/exports/${request.id}/context`);
        contextIdentity(context, request, input, version.ordinal);
        const bytes = new Uint8Array(
          await (await renderDocx(context.model, fonts)).arrayBuffer(),
        );
        check(
          bytes.length <= LIMITS.bytesPerArtifact,
          "EXPORT_DOCUMENT_TOO_LARGE",
        );
        verifyExportDocx(bytes, context.model);
        const artifact = await command(
          "export.reserve",
          {
            export_id: request.id,
            kind: "generated",
            original_name: `proposal_v${version.ordinal}_${volume}_draft.docx`,
            mime_type: MIME,
            size: bytes.length,
            hash: sha(bytes),
            review_attested: false,
          },
          `reserve:${volume}`,
        );
        artifactIdentity(artifact, request, input);
        report.reserved_artifacts.push({
          id: artifact.id,
          export_id: request.id,
          content_hash: artifact.content_hash,
          bytes: Number(artifact.expected_size),
        });
        await http(
          `/storage/v1/object/tenderdesk-private/${artifact.storage_key}`,
          {
            method: "POST",
            headers: {
              "Content-Type": MIME,
              "x-upsert": "false",
              "Cache-Control": "max-age=3600",
            },
            body: bytes,
          },
        );
        const complete = await api(
          `/v1/export-artifacts/${artifact.id}/complete`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `export-complete:${artifact.id}`,
            },
            body: "{}",
          },
        );
        check(
          complete.id === artifact.id &&
            complete.status === "ready" &&
            complete.verification === "generated_content" &&
            complete.content_hash === artifact.content_hash,
          "EXPORT_SERVER_VERIFICATION_FAILED",
        );
        const downloaded = new Uint8Array(
          await (
            await http(
              `/functions/v1/api/v1/export-artifacts/${artifact.id}/download`,
            )
          ).arrayBuffer(),
        );
        const proof = exportProof(downloaded, context.model, artifact);
        report.artifacts.push({
          id: artifact.id,
          export_id: request.id,
          volume,
          original_name: artifact.original_name,
          status: complete.status,
          verification: complete.verification,
          content_hash: artifact.content_hash,
          bytes: downloaded.length,
          ...proof,
          authenticated_server_download_verified: true,
          docx_base64: Buffer.from(downloaded).toString("base64"),
        });
      }
    } else {
      await acceptDurableBrowser(
        input,
        version,
        volumes,
        report,
        api,
        http,
        readSelected,
      );
    }
    check(
      report.artifacts.length === volumes.length &&
        new Set(report.artifacts.map((a) => a.volume)).size === volumes.length,
      "EXPORT_VOLUME_COVERAGE_INVALID",
    );
    await readSelected();
    report.checks.push("selected_owner_and_version_current_after_export");
    report.checks.push(
      "draft_exports_frozen_by_server",
      "server_verified_exact_docx_content",
      "private_storage_roundtrip",
      "downloaded_sha256_matches_registered_artifacts",
    );
    report.passed = true;
  } catch (error) {
    report.code = safeCode(error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        report.passed = false;
        report.code = "EXPORT_BROWSER_CLEANUP_FAILED";
      }
    }
  }
  const serialized = JSON.stringify(report);
  check(
    Buffer.byteLength(serialized) <= LIMITS.reportBytes,
    "EXPORT_REPORT_TOO_LARGE",
  );
  check(
    !serialized.includes(input.access_token) &&
      (!input.session?.refresh_token ||
        !serialized.includes(input.session.refresh_token)),
    "EXPORT_SECRET_IN_REPORT",
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.info = console.warn = console.error = () => {};
  let mode = "browser";
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      check(raw.length <= 65536, "EXPORT_INPUT_TOO_LARGE");
    }
    const parsed = JSON.parse(raw);
    if (["browser", "http"].includes(parsed?.mode)) mode = parsed.mode;
    const report = await acceptProposalExport(parsed);
    process.stdout.write(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        kind: "actual_proposal_draft_export",
        mode,
        passed: false,
        code: safeCode(error),
        artifacts: [],
      }),
    );
    process.exitCode = 1;
  }
}
