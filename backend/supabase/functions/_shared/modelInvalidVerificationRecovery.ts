import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import {
  blockedContent,
  ModelError,
  sha256,
  validateModelResult,
  type Evidence,
  type Reference,
} from "./model.ts";
import { candidateContent, validateGroundingReport } from "./modelGrounding.ts";
import { modelSchemas } from "./modelSchemas.ts";
import { verificationBatches } from "./modelVerification.ts";
import {
  repairOnlyValidationArtifact,
  type ModelValidationDiagnostic,
} from "./modelValidationDiagnostics.ts";

/** Reopen an exact exhausted verifier frontier using its latest retained report.
 * A reproducible citation failure supplies untrusted writer-repair hints; a
 * now-valid report returns to scoped verification. Neither path accepts a
 * candidate, resets an allowance, or makes a model request.
 */
export async function recoverInvalidVerification(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string };
  evidence: Evidence[];
  requiredIds: string[];
  manifest: Reference[];
  state: { next: readonly string[]; values: Record<string, any> };
  validate?: (result: any) => void;
  update: (
    values: { reportRef: string },
    asNode: "produce" | "verify",
  ) => Promise<unknown>;
}) {
  const { next, values } = o.state;
  const count = values.repairCount;
  if (
    next.length !== 1 ||
    !["verify", "decide"].includes(next[0]) ||
    !Number.isInteger(count) ||
    count < 0 ||
    count >= 2 ||
    !values.candidateRef
  )
    return false;
  const saved = await o.store.action("result_get", {
    key: `candidate-${count}`,
  });
  if (!saved || saved.id !== values.candidateRef) return false;
  const candidate = count ? saved.value.result.result : saved.value.result;
  try {
    if (blockedContent(JSON.stringify(candidate))) return false;
    validateModelResult("draft_section", candidate, o.evidence, o.requiredIds, {
      independentGrounding: true,
    });
    o.validate?.(candidate);
  } catch {
    return false;
  }
  const hash = await sha256(JSON.stringify(candidate));
  const selection = await o.store.action(
    "invalid_verification_repair_candidate",
    {
      candidate_id: saved.id,
      candidate_hash: hash,
      repair_count: count,
      manifest: o.manifest,
    },
  );
  if (!selection?.report || typeof selection.verification_key !== "string")
    return false;
  const retained = selection.report;
  const report = retained.value?.result;
  // Bind complete schema-valid coverage to this exact scope before diagnostics.
  // A truncated report, another candidate or missing IDs cannot become findings.
  if (
    !modelSchemas.verify_grounding.safeParse(report).success ||
    report.checked_candidate_hash !== hash ||
    blockedContent(JSON.stringify(report))
  )
    return false;
  const batches = verificationBatches(candidate);
  const wholeKey = `verification-repair-${hash}`;
  let scope:
    | { units: { id: string; text: string }[]; requirementsOnly?: boolean }
    | undefined;
  let requiredIds = o.requiredIds;
  if (selection.verification_key !== wholeKey) {
    const prefix = `verification-repair-v3-${hash}-`;
    if (!selection.verification_key.startsWith(prefix) || !batches.length)
      return false;
    const name = selection.verification_key.slice(prefix.length);
    if (name === "requirements")
      scope = { units: candidateContent(candidate), requirementsOnly: true };
    else {
      const index = batches.findIndex((_batch, i) => name === `content-${i}`);
      if (index < 0) return false;
      scope = { units: batches[index] };
      requiredIds = [];
    }
  }
  const contentIds = (scope?.units ?? candidateContent(candidate)).map(
    (unit) => unit.id,
  );
  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length &&
    new Set(a).size === a.length &&
    a.every((id) => b.includes(id));
  if (
    !sameIds(report.processed_content_ids, contentIds) ||
    !sameIds(report.processed_requirement_ids, requiredIds) ||
    !sameIds(
      report.requirement_checks.map((check: any) => check.requirement_id),
      requiredIds,
    )
  )
    return false;
  let diagnostics: ModelValidationDiagnostic[] | undefined;
  try {
    validateGroundingReport(
      report,
      candidate,
      hash,
      o.evidence,
      requiredIds,
      scope,
    );
  } catch (error) {
    if (
      !(error instanceof ModelError) ||
      error.code !== "EVIDENCE_REFERENCE_INVALID"
    )
      return false;
    diagnostics = (
      error as ModelError & {
        validationDiagnostics?: ModelValidationDiagnostic[];
      }
    ).validationDiagnostics;
    // An unclassified local failure is never evidence that the report became
    // valid, and cannot supply a safe writer-repair instruction.
    if (!diagnostics?.length) return false;
  }
  const revalidated = diagnostics === undefined;
  const artifact = revalidated
    ? { coverage: "revalidated_scope", result: report }
    : repairOnlyValidationArtifact({
        candidateHash: hash,
        diagnostics: diagnostics ?? [],
        untrustedReport: report,
        isReportPolicySafe: (value) => !blockedContent(value),
      });
  if (!artifact) return false;
  // The selector and resumer both recheck current permissions and unresolved
  // sends. This second preflight also fails before any local artifact is added.
  const pool = await o.backend.internal("task_model_preflight", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    manifest: o.manifest,
  });
  if (!Array.isArray(pool?.providers) || pool.pending_model_config_id)
    return false;
  const key = `invalid-verification-${revalidated ? "revalidated" : "repair-only"}-${saved.id}-${retained.id}`;
  const recovered = await o.store.action("result_put", {
    key,
    value: {
      ...artifact,
      producer: null,
      recovery_provenance: {
        version: 1,
        input_hash: selection.input_hash,
        candidate_ref: saved.id,
        candidate_hash: hash,
        report_ref: retained.id,
        report_hash: await sha256(JSON.stringify(report)),
        verification_key: selection.verification_key,
        repair_count: count,
        evidence_hash: await sha256(JSON.stringify(o.evidence)),
        required_ids_hash: await sha256(JSON.stringify(o.requiredIds)),
        received_candidate_budgets_unchanged: true,
        new_provider_requests: 0,
      },
    },
  });
  // Persist the same graph transition before reopening the thread. A crash in
  // between replays this immutable artifact, not a new report or model request.
  // A scoped valid report must traverse verify again: only that node can merge
  // other content/requirement scopes into complete verification coverage.
  await o.update(
    { reportRef: recovered.id },
    revalidated ? "produce" : "verify",
  );
  return (
    (await o.store.action("invalid_verification_repair_resume", {
      candidate_id: saved.id,
      candidate_hash: hash,
      repair_count: count,
      report_id: retained.id,
      artifact_id: recovered.id,
      manifest: o.manifest,
    })) === true
  );
}
