import type { Backend } from "./backend.ts";
import type { ModelGraphStore } from "./modelGraphStore.ts";
import {
  blockedContent,
  FreeModelProvider,
  modelPrompt,
  sha256,
  validateModelResult,
  type Evidence,
  type Reference,
} from "./model.ts";
import {
  normalizeOptionalNulls,
  taskJsonSchema,
  taskOutputSchema,
} from "./modelContract.ts";
import { readSemanticPromptRevision } from "./modelSemanticPrompt.ts";

/** Each paid, schema-valid rejection is private and immutable. Nothing here
 * marks its claims as supported; the normal independent verifier must do that. */
export async function retainInvalidWriter(
  store: Pick<ModelGraphStore, "action">,
  value: {
    usage_id: string;
    request_prefix: string;
    request_input_hash: string;
    task: string;
    result: unknown;
    code: string;
    producer: unknown;
  },
) {
  return store.action("result_put", {
    key: `invalid-writer-${value.usage_id}`,
    value,
  });
}

/** Recover only an already-counted initial draft after a local guard correction.
 * This helper has no generation, reservation, settlement or budget-reset path.
 * Remote recovery is limited to an exact completed OpenAI response via GET.
 */
export type PaidWriterRecoveryOptions = {
  backend: Pick<Backend, "internal" | "resolveModelEnvironment">;
  store: Pick<ModelGraphStore, "action">;
  job: { id: string; lease_token: string };
  threadId: string;
  prefix: string;
  task: string;
  context: unknown;
  evidence: Evidence[];
  requiredIds: string[];
  manifest: Reference[];
  language: "ar" | "en";
  repair: boolean;
  fetcher: typeof fetch;
  state: { next: readonly string[]; values: Record<string, any> };
  validate?: (
    result: any,
    options?: { independentGrounding?: boolean },
  ) => void;
};

export async function paidWriterCandidates(o: PaidWriterRecoveryOptions) {
  // The legacy generation step can mark repair=true after the initial writer
  // round, while this graph still has no candidate and repairCount=0. Match
  // the paid initial request too, using the same immutable business inputs.
  // Neither the step's repair flag nor any received-candidate budget is reset.
  const requestPrefix = `${o.prefix}:candidate-0`;
  const semanticRevision = await readSemanticPromptRevision(
    o.store,
    requestPrefix,
  );
  const inputHashes = await Promise.all(
    (o.repair ? [true, false] : [false]).map((repair) =>
      sha256(
        modelPrompt(
          "draft_section",
          o.context,
          o.evidence,
          o.requiredIds,
          o.language,
          repair,
          1,
          semanticRevision,
        ),
      ),
    ),
  );
  const pool = await o.backend.internal("task_model_preflight", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    manifest: o.manifest,
  });
  if (!Array.isArray(pool?.providers) || pool.pending_model_config_id)
    return [];
  const candidates: { usage: any; inputHash: string }[] = [];
  for (const inputHash of inputHashes) {
    const usages = await o.store.action("writer_recovery_candidates", {
      input_hash: inputHash,
      request_prefix: requestPrefix,
    });
    if (!Array.isArray(usages) || candidates.length + usages.length > 3)
      return [];
    candidates.push(...usages.map((usage) => ({ usage, inputHash })));
  }
  return candidates.map((candidate) => ({ ...candidate, pool, requestPrefix }));
}

export async function loadPaidWriterCandidate(
  o: PaidWriterRecoveryOptions,
  selected: Awaited<ReturnType<typeof paidWriterCandidates>>[number],
) {
  const { usage, inputHash, pool, requestPrefix } = selected;
  const config = pool.providers.find(
    (entry: any) =>
      entry.provider === usage.provider &&
      entry.model === usage.model &&
      entry.model_config_id === usage.model_config_id &&
      entry.connection_id === usage.connection_id &&
      entry.project_ref === usage.remote_project_ref,
  );
  if (
    !config ||
    usage.input_hash !== inputHash ||
    usage.state !== "settled" ||
    !usage.graph_candidate_recorded ||
    usage.execution_metadata?.input_hash !== inputHash ||
    usage.execution_metadata?.graph_thread !== o.threadId
  )
    return null;
  let retained = await o.store.action("result_get", {
    key: `invalid-writer-${usage.id}`,
  });
  if (!retained) {
    if (usage.provider !== "openai" || !usage.remote_request_id) return null;
    const env = o.backend.resolveModelEnvironment(config);
    if (!env?.key || env.provider !== "openai" || env.model !== usage.model)
      return null;
    const provider = new FreeModelProvider(
      env,
      o.fetcher,
      20000,
      false,
      config,
    );
    let response: any;
    try {
      response = await provider.pollBackground(usage.remote_request_id);
    } catch {
      return null;
    }
    if (
      response.id !== usage.remote_request_id ||
      response.status !== "completed"
    )
      return null;
    const normalized = provider.backgroundResult(response);
    if (
      !normalized.complete ||
      normalized.kind !== "completed_candidate" ||
      blockedContent(normalized.text)
    )
      return null;
    let result: unknown;
    try {
      result = taskOutputSchema("draft_section").parse(
        normalizeOptionalNulls(
          JSON.parse(normalized.text),
          taskJsonSchema("draft_section"),
        ),
      );
    } catch {
      return null;
    }
    retained = await retainInvalidWriter(o.store, {
      usage_id: usage.id,
      request_prefix: requestPrefix,
      request_input_hash: inputHash,
      task: "draft_section",
      result,
      code: "UNSUPPORTED_COMPANY_CLAIM",
      producer: {
        provider: config.provider,
        model: config.model,
        project: config.project_ref,
        connectionId: config.connection_id,
        modelId: config.model_config_id,
      },
    });
  }
  const value = retained.value;
  if (
    value.usage_id !== usage.id ||
    value.request_prefix !== requestPrefix ||
    value.request_input_hash !== inputHash ||
    value.task !== "draft_section" ||
    value.code !== "UNSUPPORTED_COMPANY_CLAIM" ||
    value.producer?.provider !== config.provider ||
    value.producer?.model !== config.model ||
    value.producer?.project !== config.project_ref ||
    value.producer?.connectionId !== config.connection_id ||
    value.producer?.modelId !== config.model_config_id ||
    blockedContent(JSON.stringify(value.result))
  )
    return null;
  let candidate: unknown;
  try {
    candidate = validateModelResult(
      "draft_section",
      value.result,
      o.evidence,
      o.requiredIds,
      { independentGrounding: true },
    );
    o.validate?.(candidate, { independentGrounding: true });
  } catch {
    return null;
  }
  return { retained, candidate, config, value };
}

export async function recoverBlockedWriter(o: PaidWriterRecoveryOptions) {
  if (
    o.task !== "draft_section" ||
    o.state.next.length !== 1 ||
    o.state.next[0] !== "produce" ||
    o.state.values.repairCount !== 0 ||
    o.state.values.candidateRef ||
    o.state.values.reportRef
  )
    return false;
  if ((await o.store.action("recovery_ready")) !== true) return false;
  const candidates = await paidWriterCandidates(o);
  const existing = await o.store.action("result_get", { key: "candidate-0" });
  for (const selected of candidates) {
    const { usage, inputHash, requestPrefix } = selected;
    const loaded = await loadPaidWriterCandidate(o, selected);
    if (!loaded) continue;
    const { retained, candidate, value } = loaded;
    const originalHash = await sha256(JSON.stringify(candidate));
    let existingHash: string | undefined;
    if (existing) {
      try {
        existingHash = await sha256(
          JSON.stringify(
            validateModelResult(
              "draft_section",
              existing.value.result,
              o.evidence,
              o.requiredIds,
              { independentGrounding: true },
            ),
          ),
        );
      } catch {
        continue;
      }
    }
    if (
      existing &&
      (existing.value.recovery_usage_id !== usage.id ||
        existingHash !== originalHash)
    )
      continue;
    const saved =
      existing ??
      (await o.store.action("result_put", {
        key: "candidate-0",
        value: {
          result: candidate,
          producer: value.producer,
          recovery_usage_id: usage.id,
        },
      }));
    const markerKey = `writer-recovery-${usage.id}`;
    const markerValue = {
      version: 1,
      reason: "paid_writer_passes_corrected_local_guard",
      usage_id: usage.id,
      candidate_ref: saved.id,
      candidate_hash: await sha256(JSON.stringify(saved.value.result)),
      retained_ref: retained.id,
      request_prefix: requestPrefix,
      request_input_hash: inputHash,
      received_candidate_budgets_unchanged: true,
      new_generation_requests: 0,
      independent_verification_required: true,
    };
    const previousMarker = await o.store.action("result_get", {
      key: markerKey,
    });
    if (previousMarker) {
      // Historical markers hashed the pre-JSONB object. Validate the immutable
      // source/result identity, but never rewrite that recorded historical hash.
      if (
        ![originalHash, markerValue.candidate_hash].includes(
          previousMarker.value.candidate_hash,
        ) ||
        Object.entries(markerValue).some(
          ([key, expected]) =>
            key !== "candidate_hash" && previousMarker.value[key] !== expected,
        )
      )
        continue;
    } else
      await o.store.action("result_put", {
        key: markerKey,
        value: markerValue,
      });
    // Reopen only this exact saved candidate. produce reads its cache, then the
    // ordinary graph proceeds through independent verify/decide/accept.
    return (
      (await o.store.action("writer_recovery_resume", {
        usage_id: usage.id,
        input_hash: inputHash,
        request_prefix: requestPrefix,
        candidate_id: saved.id,
        marker_key: markerKey,
      })) === true
    );
  }
  return false;
}
