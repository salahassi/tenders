import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { modelPrompt, sha256, type Evidence, type Reference } from "./model.ts";
import { groundingDefects, validateGroundingReport } from "./modelGrounding.ts";
import { verificationBatches } from "./modelVerification.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";

/** Undo a queued repair made obsolete by a stricter semantic interpretation.
 * This changes the graph's scheduling counter only: received candidates, usage,
 * report caches and writer/verifier budgets remain immutable and authoritative.
 */
export async function recoverUnstartedRepair(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string; checkpoint?: Record<string, any> };
  prefix: string;
  task: PrimaryModelTask;
  context: any;
  evidence: Evidence[];
  requiredIds: string[];
  manifest: Reference[];
  language: "en" | "ar";
  state: { next: readonly string[]; values: Record<string, any> };
  update: (values: { repairCount: number }) => Promise<unknown>;
}) {
  const { next, values } = o.state;
  const count = values.repairCount;
  if (
    next.length !== 1 ||
    next[0] !== "produce" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 2 ||
    !values.candidateRef ||
    !values.reportRef ||
    o.job.checkpoint?.model_round
  )
    return false;
  const previous = await o.store.action("result_get", {
    key: `candidate-${count - 1}`,
  });
  if (
    !previous ||
    previous.id !== values.candidateRef ||
    (await o.store.action("result_get", { key: `candidate-${count}` }))
  )
    return false;
  const retained = await o.store.action("result_get", { id: values.reportRef });
  if (retained?.value.coverage !== "repair_only") return false;
  const candidate =
    count > 1 ? previous.value.result.result : previous.value.result;
  const hash = await sha256(JSON.stringify(candidate));
  const report = retained.value.result;
  const batches = verificationBatches(candidate);
  let units: { id: string; text: string }[] = [];
  let validScope = false;
  for (const batch of batches) {
    units = units.concat(batch);
    if (
      units.length === report?.processed_content_ids?.length &&
      units.every((unit) => report.processed_content_ids.includes(unit.id))
    ) {
      validScope = true;
      break;
    }
  }
  if (!validScope) return false;
  try {
    validateGroundingReport(
      report,
      candidate,
      hash,
      o.evidence,
      [],
      { units },
      { aggregateVerification: true },
    );
  } catch {
    return false;
  }
  if (groundingDefects(report).length) return false;
  // No request for the scheduled writer may have started, including unknown
  // usage or a completed response not yet saved into its result cache.
  const legacyHash = await sha256(
    modelPrompt(
      "repair_result",
      {
        target_task: o.task,
        original_context: o.context,
        candidate: previous.value.result,
        findings: [],
      },
      o.evidence,
      o.requiredIds,
      o.language,
      true,
    ),
  );
  const started = await o.backend.internal("model_phase_started", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    request_prefix: `${o.prefix}:candidate-${count}`,
    legacy_input_hash: legacyHash,
  });
  if (started !== false) return false;
  const pool = await o.backend.internal("task_model_preflight", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    manifest: o.manifest,
  });
  if (!pool || !Array.isArray(pool.providers) || pool.pending_model_config_id)
    return false;
  // Record the exact provenance before the checkpoint write. If a crash happens
  // between these writes, replay can complete the same idempotent recovery.
  const marker = `repair-schedule-recovery-${previous.id}-${count}-${retained.id}`;
  await o.store.action("result_put", {
    key: marker,
    value: {
      version: 1,
      reason: "retained_report_has_no_actionable_defects",
      candidate_ref: previous.id,
      candidate_hash: hash,
      report_ref: retained.id,
      scheduled_repair_before: count,
      scheduled_repair_after: count - 1,
      received_candidate_budgets_unchanged: true,
    },
  });
  await o.update({ repairCount: count - 1 });
  return true;
}
