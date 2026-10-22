import { sha256, validateModelResult } from "./model.ts";
import {
  groundingDefects,
  groundingOptions,
  validateGroundingReport,
} from "./modelGrounding.ts";
import {
  loadPaidWriterCandidate,
  paidWriterCandidates,
  type PaidWriterRecoveryOptions,
} from "./modelWriterRecovery.ts";

/** Evaluate another already-received initial candidate after an application
 * rejection. This cannot generate a writer result or change a candidate budget.
 * The rejected candidate and its latest complete findings remain immutable.
 */
export async function recoverAlternatePaidWriter(
  o: PaidWriterRecoveryOptions & {
    update: (values: {
      candidateRef: string;
      reportRef: string;
    }) => Promise<unknown>;
  },
) {
  const { next, values } = o.state;
  if (
    o.task !== "draft_section" ||
    next.length !== 1 ||
    !["verify", "decide"].includes(next[0]) ||
    values.repairCount !== 0 ||
    !values.candidateRef ||
    (await o.store.action("recovery_ready")) !== true ||
    (await o.store.action("result_get", { key: "accepted" }))
  )
    return false;

  const choices = await o.store.action("writer_alternative_selections");
  if (!Array.isArray(choices) || choices.length > 2) return false;
  const latest = choices.at(-1);
  // A crash after recording selection but before/after checkpoint persistence
  // resumes that same transition. It cannot pick a more favorable older report.
  if (
    latest &&
    !latest.resumed_at &&
    (latest.previous_candidate_id === values.candidateRef ||
      (latest.candidate_id === values.candidateRef && !values.reportRef))
  ) {
    const selected = await o.store.action("result_get", {
      id: latest.candidate_id,
    });
    if (!selected) return false;
    const hash = await sha256(JSON.stringify(selected.value.result));
    if (hash !== latest.candidate_hash) return false;
    try {
      validateModelResult(
        "draft_section",
        selected.value.result,
        o.evidence,
        o.requiredIds,
        { independentGrounding: true },
      );
      o.validate?.(selected.value.result, { independentGrounding: true });
    } catch {
      return false;
    }
    await o.update({ candidateRef: selected.id, reportRef: "" });
    return (
      (await o.store.action("writer_alternative_resume", {
        usage_id: latest.usage_id,
        candidate_id: selected.id,
        manifest: o.manifest,
      })) === true
    );
  }

  const previous = await o.store.action("result_get", {
    id: values.candidateRef,
  });
  if (!previous || !previous.value.recovery_usage_id) return false;
  const previousHash = await sha256(JSON.stringify(previous.value.result));
  const report =
    (await o.store.action("result_get", {
      key: `invalid-verification-repair-${previousHash}`,
    })) ??
    (await o.store.action("result_get", {
      key: `invalid-verification-${previousHash}`,
    })) ??
    (values.reportRef
      ? await o.store.action("result_get", {
          id: values.reportRef,
        })
      : null);
  if (!report || report.value.coverage === "repair_only") return false;
  try {
    validateModelResult(
      "draft_section",
      previous.value.result,
      o.evidence,
      o.requiredIds,
      { independentGrounding: true },
    );
    o.validate?.(previous.value.result, { independentGrounding: true });
    validateGroundingReport(
      report.value.result,
      previous.value.result,
      previousHash,
      o.evidence,
      o.requiredIds,
      undefined,
      groundingOptions(o.context),
    );
  } catch {
    return false;
  }
  const defects = groundingDefects(report.value.result);
  if (!defects.length) return false;

  const initial = await o.store.action("result_get", { key: "candidate-0" });
  if (!initial?.value.recovery_usage_id) return false;
  const seenUsage = new Set([
    initial.value.recovery_usage_id,
    ...choices.map((choice: any) => choice.usage_id),
  ]);
  const seenHashes = new Set([
    await sha256(JSON.stringify(initial.value.result)),
    ...choices.map((choice: any) => choice.candidate_hash),
  ]);
  if (choices.length >= 2) return false;
  for (const selected of await paidWriterCandidates(o)) {
    const { usage, inputHash, requestPrefix } = selected;
    if (seenUsage.has(usage.id)) continue;
    const loaded = await loadPaidWriterCandidate(o, selected);
    if (!loaded) continue;
    const normalizedHash = await sha256(JSON.stringify(loaded.candidate));
    if (seenHashes.has(normalizedHash)) continue;
    const saved = await o.store.action("result_put", {
      key: `paid-writer-alternative-${usage.id}`,
      value: {
        result: loaded.candidate,
        producer: loaded.value.producer,
        recovery_usage_id: usage.id,
      },
    });
    const hash = await sha256(JSON.stringify(saved.value.result));
    if (seenHashes.has(hash)) continue;
    const selectedByStore = await o.store.action("writer_alternative_select", {
      usage_id: usage.id,
      input_hash: inputHash,
      request_prefix: requestPrefix,
      candidate_id: saved.id,
      candidate_hash: hash,
      previous_candidate_id: previous.id,
      previous_candidate_hash: previousHash,
      previous_report_id: report.id,
      previous_report_hash: await sha256(JSON.stringify(report.value.result)),
      evidence_hash: await sha256(JSON.stringify(o.evidence)),
      required_ids_hash: await sha256(JSON.stringify(o.requiredIds)),
      manifest: o.manifest,
    });
    if (selectedByStore !== true) return false;
    await o.update({ candidateRef: saved.id, reportRef: "" });
    return (
      (await o.store.action("writer_alternative_resume", {
        usage_id: usage.id,
        candidate_id: saved.id,
        manifest: o.manifest,
      })) === true
    );
  }
  return false;
}
