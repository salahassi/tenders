import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import {
  sha256,
  validateModelResult,
  type Evidence,
  type Reference,
} from "./model.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";

type Validation = {
  task: PrimaryModelTask;
  evidence: Evidence[];
  requiredIds: string[];
  validate?: (
    result: any,
    options?: { independentGrounding?: boolean },
  ) => void;
};

export function revalidateWriter(candidate: any, options: Validation) {
  try {
    validateModelResult(
      options.task,
      candidate,
      options.evidence,
      options.requiredIds,
      { independentGrounding: true },
    );
    options.validate?.(candidate, { independentGrounding: true });
    return true;
  } catch {
    return false;
  }
}

/** A corrected local guard can release the exact retained writer to ordinary
 * independent verification. Never accept content or replenish a model budget. */
export async function recoverRevalidatedWriter(
  o: Validation & {
    backend: Pick<Backend, "internal">;
    store: Pick<ModelGraphStore, "action">;
    job: { id: string; lease_token: string };
    manifest: Reference[];
    state: { next: readonly string[]; values: Record<string, any> };
    update: (values: { reportRef: string }) => Promise<unknown>;
  },
) {
  const { values, next } = o.state;
  const count = values.repairCount;
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 2 ||
    next.length > 1 ||
    (next.length === 1 &&
      !["verify", "decide", "needs_review"].includes(next[0]))
  )
    return false;
  const key = `candidate-${count}`;
  const saved = await o.store.action("result_get", { key });
  if (
    !saved ||
    saved.id !== values.candidateRef ||
    !saved.value.local_validation
  )
    return false;
  const candidate = count ? saved.value.result.result : saved.value.result;
  if (!revalidateWriter(candidate, o)) return false;
  const hash = await sha256(JSON.stringify(candidate));
  const rejected = await o.store.action("result_get", {
    key: `writer-validation-repair-only-${hash}`,
  });
  if (
    !rejected ||
    rejected.value.coverage !== "repair_only" ||
    rejected.value.result?.checked_candidate_hash !== hash
  )
    return false;
  const markerKey = `writer-local-revalidated-${saved.id}`;
  const previous = await o.store.action("result_get", { key: markerKey });
  if (
    values.reportRef !== rejected.id &&
    !(next[0] === "verify" && !values.reportRef && previous)
  )
    return false;
  if ((await o.store.action("recovery_ready")) !== true) return false;
  const pool = await o.backend.internal("task_model_preflight", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    manifest: o.manifest,
  });
  if (!Array.isArray(pool?.providers) || pool.pending_model_config_id)
    return false;
  const marker = await o.store.action("result_put", {
    key: markerKey,
    value: {
      version: 1,
      candidate_id: saved.id,
      candidate_key: key,
      candidate_hash: hash,
      rejected_report_id: rejected.id,
      repair_count: count,
      received_candidate_budgets_unchanged: true,
      new_provider_requests: 0,
    },
  });
  // Checkpoint first. If interrupted, the exact marker permits replay of this
  // update before the lease-bound DB transition releases verification.
  await o.update({ reportRef: "" });
  return (
    (await o.store.action("revalidated_writer_resume", {
      candidate_id: saved.id,
      candidate_key: key,
      marker_id: marker.id,
      manifest: o.manifest,
    })) === true
  );
}
