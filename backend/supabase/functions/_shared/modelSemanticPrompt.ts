import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import {
  ModelError,
  modelPrompt,
  sha256,
  type Evidence,
  type ModelTask,
} from "./model.ts";
import {
  semanticPolicyText,
  type SemanticRevision,
} from "./modelSemanticInstructions.ts";
import { scopeComparisonApplies } from "./modelScopeInstructions.ts";
import { analysisEvidenceApplies } from "./modelAnalysisEvidenceInstructions.ts";
import { planningCoverageApplies } from "./modelPlanningInstructions.ts";
import type { VerificationRevision } from "./modelVerificationInstructions.ts";
import { sourceContractContext } from "./sourceEvidence.ts";

const keyFor = async (requestPrefix: string) =>
  `semantic-instructions-${await sha256(requestPrefix)}`;
function revision(pin: any): SemanticRevision {
  const value = pin.value;
  if (
    !value ||
    ![0, 1, 2, 3, 4, 5, 6].includes(value.version) ||
    !/^[a-f0-9]{64}$/.test(value.legacy_input_hash ?? "") ||
    (value.version > 0 &&
      value.instructions !== semanticPolicyText(value.version))
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return value.version;
}

/** Recovery only reads the phase policy. An unpinned historical phase used the
 * original prompt; it must not be upgraded while retrieving a paid response. */
export async function readSemanticPromptRevision(
  store: Pick<ModelGraphStore, "action">,
  requestPrefix: string,
): Promise<SemanticRevision> {
  const pin = await store.action("result_get", {
    key: await keyFor(requestPrefix),
  });
  return pin ? revision(pin) : 0;
}

export async function pinSemanticPrompt(o: {
  backend: Pick<Backend, "internal">;
  store: Pick<ModelGraphStore, "action">;
  job: {
    id: string;
    lease_token: string;
    checkpoint?: Record<string, unknown>;
  };
  requestPrefix: string;
  task: ModelTask;
  context: unknown;
  evidence: Evidence[];
  requiredIds: string[];
  language: "en" | "ar";
  repair: boolean;
  verificationRevision: VerificationRevision;
}): Promise<SemanticRevision> {
  if (o.task === "connection_probe") return 0;
  const key = await keyFor(o.requestPrefix);
  const legacyInputHash = await sha256(
    modelPrompt(
      o.task,
      o.context,
      o.evidence,
      o.requiredIds,
      o.language,
      o.repair,
      o.verificationRevision,
      0,
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
      ? 0
      : scopeComparisonApplies(o.task, o.context)
        ? 3
        : analysisEvidenceApplies(o.task, o.context)
          ? sourceContractContext(o.context) &&
            !Object.hasOwn(o.job.checkpoint ?? {}, "verifier_recheck")
            ? 6
            : 4
          : planningCoverageApplies(o.task, o.context)
            ? 5
            : 2;
    pin = await o.store.action("result_put", {
      key,
      value: {
        version,
        legacy_input_hash: legacyInputHash,
        ...(started
          ? {}
          : {
              instructions: semanticPolicyText(version),
            }),
      },
    });
  }
  if (pin.value?.legacy_input_hash !== legacyInputHash)
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return revision(pin);
}
