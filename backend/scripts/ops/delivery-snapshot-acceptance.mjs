/** GET-only acceptance of an explicitly selected saved delivery. No render,
 * upload, generation, retry, approval or business mutation is performed here. */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport.ts";
import { verifyExportDocx } from "../../supabase/functions/_shared/export.ts";

export const LIMITS = Object.freeze({
  bytes: 10485760,
  json: 8388608,
  requests: 500,
  report: 33554432,
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (error) =>
  /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || "")
    ? error.code
    : "DELIVERY_ACCEPTANCE_FAILED";
export function validateInput(value) {
  fail(value?.version === 2, "DELIVERY_SELECTION_INVALID");
  const origin = new URL(value.origin);
  fail(
    origin.protocol === "https:" &&
      origin.origin === value.origin &&
      !origin.username &&
      !origin.password,
    "DELIVERY_ORIGIN_INVALID",
  );
  for (const key of [
    "workspace_id",
    "opportunity_id",
    "proposal_id",
    "snapshot_id",
    "actor_id",
  ])
    fail(UUID.test(value[key] || ""), "DELIVERY_SELECTION_INVALID");
  fail(
    HASH.test(value.content_hash || "") &&
      Number.isSafeInteger(value.delivery_revision) &&
      value.delivery_revision >= 1,
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    ["template", "partial", "substantive", "issued"].includes(
      value.expectation,
    ),
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    ["available", "partial", "insufficient"].includes(value.input_state) &&
      ["preparing", "ready", "blocked"].includes(value.package_status),
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    Number.isSafeInteger(value.wait_seconds) &&
      value.wait_seconds >= 0 &&
      value.wait_seconds <= 600,
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    (value.plan_id === null &&
      value.issuance_id === null &&
      value.issuance_outcome === null) ||
      (UUID.test(value.plan_id || "") &&
        UUID.test(value.issuance_id || "") &&
        ["active", "issued", "failed"].includes(value.issuance_outcome)),
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    value.expectation !== "issued" ||
      (value.issuance_outcome === "issued" && value.package_status === "ready"),
    "DELIVERY_SELECTION_INVALID",
  );
  fail(
    typeof value.access_token === "string" &&
      value.access_token.length > 20 &&
      value.access_token.length < 16384,
    "DELIVERY_SESSION_INVALID",
  );
  return value;
}

/** Classification is independent of artifact existence and never promotes a
 * template, a reviewed authored draft or an unissued generated file. */
export function classifySnapshot(snapshot) {
  const p = snapshot?.payload;
  fail(p?.approval_state === "draft", "DELIVERY_APPROVAL_CLASS_INVALID");
  if (p.version === 1 && p.substantive_complete === false) {
    if (p.content_state === "template") return "template";
    if (["source_draft", "partial_draft"].includes(p.content_state))
      return "partial";
  }
  if (
    p.version === 2 &&
    p.content_state === "substantive_draft" &&
    p.substantive_complete === true &&
    p.assurance_state === "human_reviewed"
  )
    return "substantive";
  if (
    p.version === 3 &&
    p.content_state === "generated_review_draft" &&
    p.substantive_complete === false &&
    p.assurance_state === "model_checked_source_review_required"
  )
    return "issued";
  // Unreviewed authored work remains partial, never substantive.
  if (
    p.version === 2 &&
    p.content_state === "authored_draft" &&
    p.substantive_complete === false
  )
    return "partial";
  fail(false, "DELIVERY_CONTENT_CLASS_INVALID");
}

export function checkIssuance(value, input) {
  fail(
    value?.id === input.issuance_id &&
      value.plan_id === input.plan_id &&
      value.workspace_id === input.workspace_id &&
      value.deadline_version === 1,
    "DELIVERY_ISSUANCE_IDENTITY_CHANGED",
  );
  const accepted = Date.parse(value.accepted_at),
    deadline = Date.parse(value.deadline_at),
    now = Date.parse(value.server_now);
  fail(
    Number.isFinite(accepted) &&
      Number.isFinite(deadline) &&
      Number.isFinite(now) &&
      deadline - accepted === 600000,
    "DELIVERY_ISSUANCE_CLOCK_INVALID",
  );
  const outcome = value.effective_outcome;
  fail(
    ["active", "issued", "failed"].includes(outcome),
    "DELIVERY_ISSUANCE_STATE_INVALID",
  );
  if (outcome === "active")
    fail(
      now < deadline &&
        value.outcome === "active" &&
        value.completed_at === null,
      "DELIVERY_EXPIRED_REQUEST_ACTIVE",
    );
  if (outcome === "issued")
    fail(
      value.outcome === "issued" &&
        value.issued_snapshot_id === input.snapshot_id &&
        Date.parse(value.completed_at) >= accepted &&
        Date.parse(value.completed_at) < deadline &&
        !value.error_code,
      "DELIVERY_ISSUANCE_RECEIPT_INVALID",
    );
  if (outcome === "failed")
    fail(
      typeof value.effective_error_code === "string" &&
        value.effective_error_code.length > 0 &&
        value.issued_snapshot_id === null,
      "DELIVERY_FAILURE_RECEIPT_INVALID",
    );
  return {
    id: value.id,
    outcome,
    accepted_at: value.accepted_at,
    deadline_at: value.deadline_at,
    completed_at: value.effective_completed_at,
    error_code: value.effective_error_code,
    observed_at: value.server_now,
  };
}

async function bounded(response, maximum) {
  fail(
    Number(response.headers.get("content-length") || 0) <= maximum,
    "DELIVERY_RESPONSE_TOO_LARGE",
  );
  fail(response.body, "DELIVERY_EMPTY_RESPONSE");
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      fail(size <= maximum, "DELIVERY_RESPONSE_TOO_LARGE");
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function acceptDeliverySnapshot(
  raw,
  fetcher = fetch,
  clock = {
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  const report = {
    version: 2,
    kind: "saved_delivery_acceptance",
    passed: false,
    path: "authenticated_http",
    observations: [],
    artifacts: [],
    business_writes: 0,
    model_calls: 0,
    checks: [],
  };
  let requests = 0;
  try {
    const input = validateInput(raw),
      start = clock.now();
    report.expectation = input.expectation;
    report.selection = {
      snapshot_id: input.snapshot_id,
      content_hash: input.content_hash,
      delivery_revision: input.delivery_revision,
    };
    const get = async (path, binary = false) => {
      fail(++requests <= LIMITS.requests, "DELIVERY_REQUEST_LIMIT");
      const response = await fetcher(
        `${input.origin}/functions/v1/api${path}`,
        {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${input.access_token}` },
          signal: AbortSignal.timeout(30000),
        },
      );
      fail(response.ok, `DELIVERY_HTTP_${response.status}`);
      const bytes = await bounded(
        response,
        binary ? LIMITS.bytes : LIMITS.json,
      );
      if (binary) return bytes;
      const envelope = JSON.parse(new TextDecoder().decode(bytes));
      fail(
        envelope && Object.hasOwn(envelope, "data"),
        "DELIVERY_API_ENVELOPE_INVALID",
      );
      return envelope.data;
    };
    const identity = async () => {
      const bootstrap = await get("/v1/bootstrap"),
        m = bootstrap?.membership;
      fail(
        m?.user_id === input.actor_id &&
          m.workspace_id === input.workspace_id &&
          m.role === "Owner" &&
          bootstrap.workspace?.id === input.workspace_id,
        "DELIVERY_ACTOR_CHANGED",
      );
      const proposal = await get(`/v1/proposals/${input.proposal_id}`);
      fail(
        proposal.id === input.proposal_id &&
          proposal.workspace_id === input.workspace_id &&
          proposal.opportunity_id === input.opportunity_id &&
          proposal.active_delivery_snapshot_id === input.snapshot_id &&
          proposal.delivery_revision === input.delivery_revision,
        "DELIVERY_SELECTION_STALE",
      );
    };
    await identity();
    const snapshot = await get(
      `/v1/delivery-snapshots/${input.snapshot_id}/context`,
    );
    fail(
      snapshot.id === input.snapshot_id &&
        snapshot.workspace_id === input.workspace_id &&
        snapshot.proposal_id === input.proposal_id &&
        snapshot.opportunity_id === input.opportunity_id &&
        snapshot.content_hash === input.content_hash,
      "DELIVERY_SNAPSHOT_MISMATCH",
    );
    fail(
      classifySnapshot(snapshot) === input.expectation &&
        snapshot.payload.input_state === input.input_state,
      "DELIVERY_EXPECTATION_MISMATCH",
    );
    if (input.expectation === "template")
      fail(
        snapshot.payload.notice?.trim() &&
          snapshot.payload.gaps?.length > 0 &&
          snapshot.payload.sections?.some((section) =>
            section.content_blocks?.some(
              (block) => block.type === "placeholder",
            ),
          ),
        "DELIVERY_TEMPLATE_NOTICE_OR_GAP_MISSING",
      );
    const volumes = snapshot.payload.separate_volumes
      ? ["financial", "technical"]
      : ["combined"];
    let pkg, issuance, priorClock;
    while (true) {
      pkg = await get(`/v1/delivery-snapshots/${input.snapshot_id}/package`);
      fail(
        pkg?.snapshot?.id === input.snapshot_id &&
          pkg.snapshot.proposal_id === input.proposal_id &&
          pkg.snapshot.delivery_revision === input.delivery_revision &&
          pkg.snapshot.content_state === snapshot.payload.content_state,
        "DELIVERY_PACKAGE_MISMATCH",
      );
      fail(
        ["ready", "preparing", "blocked"].includes(pkg.status) &&
          Array.isArray(pkg.artifacts) &&
          pkg.artifacts.length <= 2,
        "DELIVERY_PACKAGE_INVALID",
      );
      if (input.plan_id) {
        issuance = checkIssuance(
          await get(`/v1/proposal-issuance/${input.plan_id}`),
          input,
        );
        const stable = JSON.stringify([
          issuance.id,
          issuance.accepted_at,
          issuance.deadline_at,
        ]);
        fail(
          !priorClock || priorClock === stable,
          "DELIVERY_ISSUANCE_CLOCK_RESET",
        );
        priorClock = stable;
      }
      report.observations.push({
        status: pkg.status,
        job_status: pkg.job?.status ?? null,
        error_code: pkg.job?.error_code ?? null,
        ready_volumes: pkg.artifacts
          .filter((a) => a.status === "ready")
          .map((a) => a.volume),
        issuance: issuance || null,
      });
      if (
        pkg.status === input.package_status &&
        (!input.plan_id || issuance.outcome === input.issuance_outcome)
      )
        break;
      fail(
        pkg.status !== "blocked" && !(issuance?.outcome === "failed"),
        "DELIVERY_TERMINAL_BEFORE_EXPECTATION",
      );
      fail(
        clock.now() - start < input.wait_seconds * 1000,
        "DELIVERY_EXPECTED_STATE_NOT_OBSERVED",
      );
      await clock.wait(
        Math.min(5000, input.wait_seconds * 1000 - (clock.now() - start)),
      );
    }
    if (pkg.status === "ready") {
      fail(
        pkg.job?.status === "succeeded" &&
          JSON.stringify(pkg.artifacts.map((a) => a.volume).sort()) ===
            JSON.stringify(volumes) &&
          pkg.artifacts.every((a) => a.status === "ready"),
        "DELIVERY_WHOLE_PACKAGE_REQUIRED",
      );
      for (const a of pkg.artifacts) {
        fail(
          UUID.test(a.id) &&
            HASH.test(a.content_hash || "") &&
            Number.isSafeInteger(Number(a.expected_size)) &&
            Number(a.expected_size) > 0 &&
            Number(a.expected_size) <= LIMITS.bytes,
          "DELIVERY_ARTIFACT_INVALID",
        );
        const bytes = await get(
          `/v1/delivery-artifacts/${a.id}/download`,
          true,
        );
        fail(
          bytes.length === Number(a.expected_size) &&
            sha(bytes) === a.content_hash,
          "DELIVERY_STORED_BYTES_MISMATCH",
        );
        // Canonical deployed-contract projection checks exact paragraphs/tables,
        // placeholder highlights, volume separation and forbidden extra content.
        verifyExportDocx(bytes, buildDeliveryExport(snapshot, a.volume));
        report.artifacts.push({
          id: a.id,
          volume: a.volume,
          bytes: bytes.length,
          content_hash: sha(bytes),
          authenticated_storage_download_verified: true,
          canonical_docx_verified: true,
          docx_base64: Buffer.from(bytes).toString("base64"),
        });
      }
    } else {
      fail(
        !issuance || issuance.outcome !== "issued",
        "DELIVERY_ISSUED_WITHOUT_PACKAGE",
      );
      // A ready first volume must still be denied while its sibling is pending.
      for (const a of pkg.artifacts.filter((item) => item.status === "ready")) {
        try {
          await get(`/v1/delivery-artifacts/${a.id}/download`, true);
          fail(false, "DELIVERY_PARTIAL_PACKAGE_DOWNLOADABLE");
        } catch (error) {
          fail(
            ["DELIVERY_HTTP_409", "DELIVERY_HTTP_422"].includes(error?.code),
            "DELIVERY_PENDING_DOWNLOAD_NOT_DENIED",
          );
        }
      }
    }
    // Independent current authenticated reads after observation/download prove
    // re-entry without relying on a browser's in-memory export operation.
    await identity();
    const current = await get(
      `/v1/delivery-snapshots/${input.snapshot_id}/context`,
    );
    fail(
      current.content_hash === input.content_hash,
      "DELIVERY_SOURCE_CHANGED",
    );
    if (pkg.status === "ready") {
      const reentered = await get(
        `/v1/delivery-snapshots/${input.snapshot_id}/package`,
      );
      fail(
        reentered.status === "ready" &&
          reentered.job?.status === "succeeded" &&
          JSON.stringify(reentered.artifacts) === JSON.stringify(pkg.artifacts),
        "DELIVERY_PACKAGE_CHANGED_AFTER_DOWNLOAD",
      );
    }
    if (input.plan_id) {
      const finalIssuance = checkIssuance(
        await get(`/v1/proposal-issuance/${input.plan_id}`),
        input,
      );
      fail(
        finalIssuance.outcome === input.issuance_outcome &&
          JSON.stringify([
            finalIssuance.id,
            finalIssuance.accepted_at,
            finalIssuance.deadline_at,
          ]) === priorClock,
        "DELIVERY_ISSUANCE_CHANGED_AFTER_DOWNLOAD",
      );
    }
    report.package_status = pkg.status;
    report.deliverable_verified = pkg.status === "ready";
    report.issuance_verified =
      input.expectation === "issued" &&
      issuance?.outcome === "issued" &&
      pkg.status === "ready";
    report.substantive_complete = snapshot.payload.substantive_complete;
    report.checks = [
      "current_owner_and_selection_before_after",
      "current_source_context_before_after",
      "get_only_no_business_mutation",
      "content_class_independent_of_file_existence",
      "canonical_600s_clock_when_present",
    ];
    report.passed = true;
  } catch (error) {
    report.code = safe(error);
  }
  report.http_requests = requests;
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = "";
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      fail(Buffer.byteLength(input) <= 65536, "DELIVERY_INPUT_TOO_LARGE");
    }
    const report = await acceptDeliverySnapshot(JSON.parse(input));
    const output = JSON.stringify(report);
    fail(
      Buffer.byteLength(output) <= LIMITS.report,
      "DELIVERY_REPORT_TOO_LARGE",
    );
    process.stdout.write(output);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        version: 2,
        kind: "saved_delivery_acceptance",
        passed: false,
        artifacts: [],
        code: safe(error),
      }),
    );
    process.exitCode = 1;
  }
}
