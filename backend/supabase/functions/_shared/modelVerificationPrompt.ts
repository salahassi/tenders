import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import { ModelError, modelPrompt, sha256, type Evidence } from "./model.ts";
import { analysisLiteralCoverage } from "./modelAnalysisLiteralCoverage.ts";
import {
  verificationPolicyText,
  type VerificationRevision,
} from "./modelVerificationInstructions.ts";

export async function pinVerificationPrompt(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: {
    id: string;
    lease_token: string;
    checkpoint?: Record<string, unknown>;
  };
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
    const version = started
      ? 1
      : o.context?.original_task === "analyze_chunk"
        ? o.context.original_context?.source_contract_version === 1 &&
          o.context.candidate &&
          typeof o.context.candidate === "object" &&
          !Array.isArray(o.context.candidate) &&
          !Object.hasOwn(o.job.checkpoint ?? {}, "verifier_recheck")
          ? analysisLiteralCoverage(o.context, o.evidence, o.requiredIds) &&
            (await sha256(JSON.stringify(o.context.candidate))) ===
              o.context.candidate_hash
            ? 6
            : 5
          : 4
        : o.context?.original_task === "review_proposal"
          ? 3
          : 2;
    pin = await o.store.action("result_put", {
      key,
      value: {
        version,
        legacy_input_hash: legacyInputHash,
        ...(started ? {} : { instructions: verificationPolicyText(version) }),
      },
    });
  }
  const value = pin.value;
  if (
    value.legacy_input_hash !== legacyInputHash ||
    ![1, 2, 3, 4, 5, 6].includes(value.version) ||
    (value.version >= 2 &&
      value.instructions !== verificationPolicyText(value.version)) ||
    (value.version === 6 &&
      (!analysisLiteralCoverage(o.context, o.evidence, o.requiredIds) ||
        (await sha256(JSON.stringify(o.context.candidate))) !==
          o.context.candidate_hash))
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return value.version as VerificationRevision;
}
