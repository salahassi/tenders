import type { ModelGraphStore } from "./modelGraphStore.ts";
import {
  ModelError,
  sha256,
  validateModelResult,
  draftInputPolicyVersion,
  type Evidence,
  type Ledger,
  type Reference,
} from "./model.ts";
import {
  groundingDefects,
  groundingOptions,
  validateGroundingReport,
} from "./modelGrounding.ts";

export type VerifierRecheck = {
  version: 1;
  parent_job_id: string;
  parent_thread_id: string;
  candidate_id: string;
  candidate_hash: string;
  input_hash: string;
};
type Store = Pick<ModelGraphStore, "action">;
type Validation = {
  context: unknown;
  evidence: Evidence[];
  requiredIds: string[];
  validate?: (result: any) => void;
};
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reject = () => {
  throw new ModelError("MODEL_IDENTITY_CHANGED");
};

/** A checkpoint selects this restricted path, but never authorizes it. Every
 * lease must obtain the independently checked database seed before any model
 * operation. Malformed markers cannot fall through to the ordinary writer. */
export function verifierRecheckMarker(
  job: { id: string; checkpoint?: Record<string, any> },
  task: string,
  repair: boolean,
): VerifierRecheck | null {
  if (!Object.hasOwn(job.checkpoint ?? {}, "verifier_recheck")) return null;
  const marker = job.checkpoint!.verifier_recheck;
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 6 ||
    marker.version !== 1 ||
    !uuid.test(marker.parent_job_id ?? "") ||
    !uuid.test(marker.candidate_id ?? "") ||
    !hash.test(marker.parent_thread_id ?? "") ||
    !hash.test(marker.candidate_hash ?? "") ||
    !hash.test(marker.input_hash ?? "") ||
    marker.parent_job_id === job.id ||
    task !== "analyze_chunk" ||
    repair
  )
    reject();
  return marker;
}

export async function prepareVerifierRecheck(
  ledger: Pick<Ledger, "preflight">,
  manifest: Reference[],
) {
  const pool = await ledger.preflight(manifest, "verify_grounding");
  if (pool.executor_version !== 2) reject();
  if (!pool.providers.some((provider) => provider.enabled === true))
    throw new ModelError("MODEL_NOT_CONFIGURED");
}

/** Only the whole-report verifier and its one report correction are allowed.
 * This guard precedes cache lookup, provider preparation and token counting. */
export function assertVerifierRecheckCall(
  marker: VerifierRecheck,
  task: string,
  key: string,
  unit: string,
) {
  if (
    task !== "verify_grounding" ||
    ![
      [
        `verification-${marker.candidate_hash}`,
        `verifier-${marker.candidate_hash}`,
      ],
      [
        `verification-repair-${marker.candidate_hash}`,
        `verifier-repair-${marker.candidate_hash}`,
      ],
    ].some(
      ([allowedKey, allowedUnit]) => key === allowedKey && unit === allowedUnit,
    )
  )
    reject();
}

export async function seedVerifierRecheck(
  o: Validation & {
    store: Store;
    marker: VerifierRecheck;
    inputHash: string;
    threadId: string;
  },
) {
  if (
    o.marker.input_hash !== o.inputHash ||
    o.marker.parent_thread_id === o.threadId
  )
    reject();
  const seed = await o.store.action("recheck_seed", {
    input_hash: o.inputHash,
    task: "analyze_chunk",
  });
  if (
    !seed ||
    seed.verification_revision !== 4 ||
    Object.entries(o.marker).some(([key, value]) => seed[key] !== value) ||
    !seed.value ||
    typeof seed.value !== "object" ||
    !seed.value.result ||
    !seed.value.producer ||
    typeof seed.value.producer !== "object" ||
    !uuid.test(seed.value.producer.modelId ?? "") ||
    !uuid.test(seed.value.producer.connectionId ?? "") ||
    typeof seed.value.producer.provider !== "string" ||
    typeof seed.value.producer.model !== "string" ||
    seed.value.local_validation ||
    (await sha256(JSON.stringify(seed.value.result))) !==
      o.marker.candidate_hash
  )
    reject();
  validateModelResult(
    "analyze_chunk",
    seed.value.result,
    o.evidence,
    o.requiredIds,
    {
      independentGrounding: true,
      draftInputVersion: draftInputPolicyVersion("analyze_chunk", o.context),
    },
  );
  o.validate?.(seed.value.result);
  const provenance = { ...o.marker, verification_revision: 4 };
  const previous = await o.store.action("result_get", {
    key: "verifier-recheck-provenance",
  });
  if (
    previous &&
    JSON.stringify(previous.value) !== JSON.stringify(provenance)
  ) {
    // JSONB can reorder object fields; compare the exact field set and values.
    if (
      Object.keys(previous.value ?? {}).length !==
        Object.keys(provenance).length ||
      Object.entries(provenance).some(
        ([key, value]) => previous.value?.[key] !== value,
      )
    )
      reject();
  }
  if (!previous)
    await o.store.action("result_put", {
      key: "verifier-recheck-provenance",
      value: provenance,
    });
  const saved = await o.store.action("result_get", { key: "candidate-0" });
  if (saved) {
    if (
      (await sha256(JSON.stringify(saved.value))) !==
      (await sha256(JSON.stringify(seed.value)))
    )
      reject();
    return saved;
  }
  // Preserve the parent value byte-for-byte at the JSON value boundary. The
  // lineage is separate; it never pretends the child generated this candidate.
  return o.store.action("result_put", {
    key: "candidate-0",
    value: seed.value,
  });
}

export function assertVerifierRecheckState(
  state: Record<string, any>,
  candidateId: string,
) {
  if (
    (state.repairCount === undefined &&
      (state.candidateRef || state.reportRef)) ||
    (state.repairCount !== undefined && state.repairCount !== 0) ||
    (state.candidateRef && state.candidateRef !== candidateId) ||
    state.decision === "repair"
  )
    reject();
}

export async function validateAcceptedRecheck(
  o: Validation & {
    store: Store;
    marker: VerifierRecheck;
    candidate: any;
  },
) {
  if ((await sha256(JSON.stringify(o.candidate))) !== o.marker.candidate_hash)
    reject();
  const report =
    (await o.store.action("result_get", {
      key: `verification-repair-${o.marker.candidate_hash}`,
    })) ??
    (await o.store.action("result_get", {
      key: `verification-${o.marker.candidate_hash}`,
    }));
  if (!report || report.value.coverage === "repair_only")
    throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
  validateGroundingReport(
    report.value.result,
    o.candidate,
    o.marker.candidate_hash,
    o.evidence,
    o.requiredIds,
    undefined,
    groundingOptions(o.context),
  );
  if (groundingDefects(report.value.result).length)
    throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
  o.validate?.(o.candidate);
}
