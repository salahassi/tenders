import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { ModelError, modelPrompt, sha256, type Evidence } from "./model.ts";

export type VerificationPhase = {
  backend: Pick<Backend, "internal">;
  job: { id: string; lease_token: string };
  requestPrefix: string;
  evidence: Evidence[];
  requiredIds: string[];
  language: "en" | "ar";
  repair: boolean;
};

/** No payload-format upgrade may precede an already prepared or paid phase.
 * Instruction pins cover the pre-send crash window; the lease-bound SQL guard
 * covers accepted, settled, unknown and legacy saved-round requests. */
export async function verificationPhaseUnstarted(
  store: Pick<ModelGraphStore, "action">,
  phase: VerificationPhase,
  legacyContext: unknown,
) {
  const suffix = await sha256(phase.requestPrefix);
  for (const prefix of ["semantic-instructions", "verification-instructions"])
    if (await store.action("result_get", { key: `${prefix}-${suffix}` }))
      return false;
  const legacyInputHash = await sha256(
    modelPrompt(
      "verify_grounding",
      legacyContext,
      phase.evidence,
      phase.requiredIds,
      phase.language,
      phase.repair,
    ),
  );
  const started = await phase.backend.internal("model_phase_started", {
    job_id: phase.job.id,
    lease: phase.job.lease_token,
    request_prefix: phase.requestPrefix,
    legacy_input_hash: legacyInputHash,
  });
  if (typeof started !== "boolean")
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return !started;
}
