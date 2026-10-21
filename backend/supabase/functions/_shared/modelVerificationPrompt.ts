import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { ModelError, modelPrompt, sha256, type Evidence } from "./model.ts";
import { VERIFICATION_INSTRUCTIONS_V2 } from "./modelVerificationInstructions.ts";

export async function pinVerificationPrompt(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string };
  requestPrefix: string;
  context: any;
  evidence: Evidence[];
  requiredIds: string[];
  language: "en" | "ar";
  repair: boolean;
}) {
  const key = `verification-instructions-${await sha256(o.requestPrefix)}`;
  const legacyInputHash = await sha256(
    modelPrompt(
      "verify_grounding",
      o.context,
      o.evidence,
      o.requiredIds,
      o.language,
      o.repair,
    ),
  );
  let pin = await o.store.action("result_get", { key });
  if (!pin) {
    const started = await o.backend.internal("model_phase_started", {
      job_id: o.job.id,
      lease: o.job.lease_token,
      request_prefix: o.requestPrefix,
      legacy_input_hash: legacyInputHash,
    });
    if (typeof started !== "boolean")
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    pin = await o.store.action("result_put", {
      key,
      value: {
        version: started ? 1 : 2,
        legacy_input_hash: legacyInputHash,
        ...(started ? {} : { instructions: VERIFICATION_INSTRUCTIONS_V2 }),
      },
    });
  }
  const value = pin.value;
  if (
    value.legacy_input_hash !== legacyInputHash ||
    ![1, 2].includes(value.version) ||
    (value.version === 2 && value.instructions !== VERIFICATION_INSTRUCTIONS_V2)
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return value.version as 1 | 2;
}
