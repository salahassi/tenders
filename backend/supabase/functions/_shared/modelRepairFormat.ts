import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { ModelError, modelPrompt, sha256, type Evidence } from "./model.ts";
import {
  buildSemanticPatchScope,
  canonicalPatchValue,
  type SemanticPatchScope,
} from "./modelSemanticPatch.ts";

/** An explicit new-work contract is necessary but never sufficient to repin an
 * existing request. Every already prepared/paid phase keeps its original wire. */
export async function pinRepairFormat(options: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string; checkpoint?: Record<string, any> };
  requestPrefix: string;
  context: any;
  evidence: Evidence[];
  requiredIds: string[];
  language: "en" | "ar";
}): Promise<SemanticPatchScope | null> {
  if (options.context.original_context?.repair_contract_version !== 1)
    return null;
  const suffix = await sha256(options.requestPrefix),
    key = `repair-format-${suffix}`;
  const legacyHash = await sha256(
    modelPrompt(
      "repair_result",
      options.context,
      options.evidence,
      options.requiredIds,
      options.language,
      true,
    ),
  );
  let pinned = await options.store.action("result_get", { key });
  if (!pinned) {
    let started =
      options.job.checkpoint?.model_round?.input_hash === legacyHash;
    for (const prefix of ["semantic-instructions", "quote-repair-scope"])
      if (
        await options.store.action("result_get", { key: `${prefix}-${suffix}` })
      )
        started = true;
    if (!started) {
      const phase = await options.backend.internal("model_phase_started", {
        job_id: options.job.id,
        lease: options.job.lease_token,
        request_prefix: options.requestPrefix,
        legacy_input_hash: legacyHash,
      });
      if (typeof phase !== "boolean")
        throw new ModelError("MODEL_IDENTITY_CHANGED");
      started = phase;
    }
    const scope = started
      ? null
      : await buildSemanticPatchScope({
          task: options.context.target_task,
          candidate: options.context.candidate,
          diagnostics: options.context.validation_diagnostics,
          omittedDiagnosticCount:
            options.context.omitted_validation_diagnostic_count,
          findings: options.context.findings,
          trustedFindings:
            !options.context.validation_diagnostics &&
            !options.context.untrusted_verification_report,
        });
    pinned = await options.store.action("result_put", {
      key,
      value: { version: started ? 0 : 1, legacy_input_hash: legacyHash, scope },
    });
  }
  const value = pinned.value;
  if (
    ![0, 1].includes(value?.version) ||
    value.legacy_input_hash !== legacyHash ||
    (value.version === 0 && value.scope !== null)
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  if (value.version === 0) return null;
  const expected = await buildSemanticPatchScope({
    task: options.context.target_task,
    candidate: options.context.candidate,
    diagnostics: options.context.validation_diagnostics,
    omittedDiagnosticCount: options.context.omitted_validation_diagnostic_count,
    findings: options.context.findings,
    trustedFindings:
      !options.context.validation_diagnostics &&
      !options.context.untrusted_verification_report,
  });
  if (canonicalPatchValue(value.scope) !== canonicalPatchValue(expected))
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  if (!expected.paths.length)
    throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
  return expected;
}
