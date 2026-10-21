import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { sha256, type Evidence, type Reference } from "./model.ts";
import { groundingDefects, validateGroundingReport } from "./modelGrounding.ts";

/** Revalidate a retained complete report after a deterministic guard correction.
 * This path cannot call a model, change the candidate, or reset any allowance.
 * The normal retry command and every store/preflight RPC retain their revision,
 * input, permission and current-job-lease checks.
 */
export async function recoverBlockedVerification(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string };
  evidence: Evidence[];
  requiredIds: string[];
  manifest: Reference[];
  state: { next: readonly string[]; values: Record<string, any> };
  validate?: (result: any) => void;
  update: (values: { reportRef: string }) => Promise<unknown>;
}) {
  const { next, values } = o.state;
  // A failed verifier (or an interrupted recovery's final decision) is the
  // only eligible checkpoint. A scheduled writer must never be bypassed.
  if (
    next.length !== 1 ||
    !["verify", "decide", "accept"].includes(next[0]) ||
    !Number.isInteger(values.repairCount) ||
    values.repairCount < 0 ||
    values.repairCount > 2 ||
    !values.candidateRef
  )
    return false;
  const saved = await o.store.action("result_get", {
    key: `candidate-${values.repairCount}`,
  });
  if (!saved || saved.id !== values.candidateRef) return false;
  const candidate = values.repairCount
    ? saved.value.result.result
    : saved.value.result;
  const hash = await sha256(JSON.stringify(candidate));
  // Prefer the corrective report. If it exists but remains invalid, an older
  // report cannot conceal its newer semantic findings.
  const retained =
    (await o.store.action("result_get", {
      key: `invalid-verification-repair-${hash}`,
    })) ??
    (await o.store.action("result_get", {
      key: `invalid-verification-${hash}`,
    }));
  if (!retained || retained.value.coverage === "repair_only") return false;
  try {
    o.validate?.(candidate);
    validateGroundingReport(
      retained.value.result,
      candidate,
      hash,
      o.evidence,
      o.requiredIds,
    );
  } catch {
    return false;
  }
  if (groundingDefects(retained.value.result).length) return false;
  // Check the current database state, including unknown sends, reservations
  // without a remote ID and saved rounds that preflight does not report.
  if ((await o.store.action("recovery_ready")) !== true) return false;
  const pool = await o.backend.internal("task_model_preflight", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    manifest: o.manifest,
  });
  if (!pool || !Array.isArray(pool.providers) || pool.pending_model_config_id)
    return false;
  const markerKey = `validated-recovery-${saved.id}-${retained.id}`;
  const markerValue = {
    version: 1,
    reason: "retained_complete_report_passes_current_guards",
    candidate_ref: saved.id,
    candidate_hash: hash,
    report_ref: retained.id,
    report_hash: await sha256(JSON.stringify(retained.value.result)),
    evidence_hash: await sha256(JSON.stringify(o.evidence)),
    required_ids_hash: await sha256(JSON.stringify(o.requiredIds)),
    repair_count: values.repairCount,
    received_candidate_budgets_unchanged: true,
    new_provider_requests: 0,
  };
  const accepted = await o.store.action("result_get", { key: "accepted" });
  if (accepted) {
    // accept writes its immutable result before changing the thread status.
    // A crash in between may replay only this exact proven recovery, never
    // replace a previously accepted candidate or skip the validation above.
    const marker = await o.store.action("result_get", { key: markerKey });
    if (
      (await sha256(JSON.stringify(accepted.value))) !== hash ||
      !marker ||
      Object.entries(markerValue).some(
        ([key, value]) => marker.value[key] !== value,
      )
    )
      return false;
  }
  await o.store.action("result_put", {
    key: markerKey,
    value: markerValue,
  });
  // Resume the existing normal decision/accept nodes. Those nodes repeat the
  // complete-content/evidence/requirement and zero-defect validation before
  // persisting the identical candidate as the accepted result.
  await o.update({ reportRef: retained.id });
  return true;
}
