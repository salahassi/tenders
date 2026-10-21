import { AsyncLocalStorageProviderSingleton } from "langsmith/singletons/traceable";
import { env as runtimeEnvironment } from "node:process";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { Backend, BackendEnvironment } from "./backend.ts";
import {
  executeModel,
  ModelDeferred,
  ModelError,
  modelPrompt,
  sha256,
  type Evidence,
  type Reference,
  type Ledger,
} from "./model.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";
import { modelLedger } from "./modelLedger.ts";
import { ModelGraphStore } from "./modelGraphStore.ts";
import {
  verificationBatches,
  mergeVerificationReports,
} from "./modelVerification.ts";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "./modelGrounding.ts";
import { pinVerificationPrompt } from "./modelVerificationPrompt.ts";
import { pinSemanticPrompt } from "./modelSemanticPrompt.ts";
import { recoverUnstartedRepair } from "./modelRepairRecovery.ts";
import { recoverBlockedVerification } from "./modelBlockedRecovery.ts";
import { recoverAlternatePaidWriter } from "./modelAlternateWriterRecovery.ts";
import {
  recoverBlockedWriter,
  retainInvalidWriter,
} from "./modelWriterRecovery.ts";
import type { StructuredRequest } from "./modelContract.ts";

type Options = {
  backend: Backend;
  job: {
    id: string;
    lease_token: string;
    attempts: number;
    checkpoint?: Record<string, any>;
  };
  prefix: string;
  task: PrimaryModelTask;
  context: any;
  evidence: Evidence[];
  requiredIds: string[];
  manifest: Reference[];
  environments: BackendEnvironment["models"];
  language: "ar" | "en";
  repair: boolean;
  fetcher: typeof fetch;
  validate?: (
    result: any,
    options?: { independentGrounding?: boolean },
  ) => void;
};
const State = Annotation.Root({
  candidateRef: Annotation<string>(),
  reportRef: Annotation<string>(),
  repairCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  defectHash: Annotation<string>(),
  decision: Annotation<"accept" | "repair" | "needs_review">(),
});

export function disableExternalModelTracing(
  env: Record<string, string | undefined>,
) {
  // LangGraph is local orchestration only. Explicitly suppress inherited tracing
  // even if a hosting environment defines LANGSMITH_TRACING or a tracing key.
  // Persistently disable these process-wide switches: graph iterator internals
  // can create a fresh async context without inheriting the outer placeholder.
  // Do not restore flags after a request, which would race concurrent jobs.
  for (const flag of [
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
  ]) {
    // Supabase exposes a readable but immutable process environment. Unset or
    // disabled flags already prevent export; assigning them still throws there.
    if (env[flag] !== "true") continue;
    try {
      env[flag] = "false";
    } catch {
      // Never run customer content with inherited tracing enabled when the
      // runtime cannot disable it. Do not echo the environment or its values.
      throw new ModelError("MODEL_TRACING_CONFIGURATION_UNSAFE");
    }
  }
}
export async function verificationContext(
  store: Pick<ModelGraphStore, "action">,
  ledger: Ledger,
  context: any,
  manifest: Reference[],
) {
  // Pin the context format before sending. An in-flight legacy request must
  // keep its exact input hash; it can opt into the compact format only after
  // the provider request finishes. Replays retain this immutable marker.
  const formatKey = `verification-format-${context.candidate_hash}`;
  let format = await store.action("result_get", { key: formatKey });
  if (!format) {
    const preflight = ledger.preflight;
    const pool = await preflight(manifest, "verify_grounding");
    let prepared = true;
    ledger.preflight = async (manifest, operation) => {
      if (prepared) {
        prepared = false;
        return pool;
      }
      return preflight(manifest, operation);
    };
    if (!pool.pending_model_config_id) {
      format = await store.action("result_put", {
        key: formatKey,
        value: { version: 2 },
      });
    }
  }
  if (format?.value.version === 2) {
    // content_units already contains every reviewed string. Sending the same
    // text twice more wastes context and encourages oversized reports.
    const {
      candidate: _candidate,
      candidate_text: _text,
      ...compact
    } = context;
    context = { ...compact, response_style: "compact-verification-v2" };
  }
  return context;
}

export async function retainInvalidVerification(
  store: Pick<ModelGraphStore, "action">,
  key: string,
  result: unknown,
  code: string,
  producer?: Record<string, unknown>,
) {
  const value = { result, code, producer: producer ?? null };
  // Keep each distinct rejection privately for diagnostics, including later
  // providers in the same round. Fixed-length keys and result_put's immutable
  // content check make replay idempotent; correction still uses the first one.
  await store.action("result_put", {
    key: `invalid-report-${await sha256(JSON.stringify([key, value]))}`,
    value: { verification_key: key, ...value },
  });
  const invalidKey = `invalid-${key}`;
  if (!(await store.action("result_get", { key: invalidKey })))
    await store.action("result_put", { key: invalidKey, value });
}

/** One durable graph phase per queue lease. Large inputs/results are kept outside
 * LangGraph channels; checkpoint replay reads their immutable database references.
 * The database job lease, permissions and existing remote-request ledger remain
 * the sole authority for dispatch, polling and publishing results.
 */
export function executeGuardedModel(o: Options) {
  disableExternalModelTracing(runtimeEnvironment);
  // A disabled context avoids constructing a RunTree/Client, which can perform
  // a server-capability lookup even when trace recording itself is disabled.
  return new Promise<Awaited<ReturnType<typeof runGuardedModel>>>(
    (resolve, reject) => {
      AsyncLocalStorageProviderSingleton.getInstance().run(
        { tracingEnabled: false },
        () => void runGuardedModel(o).then(resolve, reject),
      );
    },
  );
}
async function runGuardedModel(o: Options): Promise<{
  result: any;
  threadId?: string;
  cleanup?: () => Promise<void>;
}> {
  const invocationStartedAt = o.backend.invocationStartedAt ?? Date.now();
  const legacy = modelLedger(o.backend, o.job, o.prefix, o.environments);
  if (o.job.checkpoint?.model_executor !== 2) {
    const pool = await legacy.preflight(o.manifest, o.task);
    if (pool.executor_version !== 2) {
      // Reuse the already checked pool for the first legacy invocation.
      const prepare = legacy.preflight;
      let prepared = true;
      legacy.preflight = async (manifest, task) => {
        if (prepared) {
          prepared = false;
          return pool;
        }
        return prepare(manifest, task);
      };
      const result = await executeModel(
        o.task,
        o.context,
        o.evidence,
        o.requiredIds,
        o.manifest,
        o.environments,
        legacy,
        o.language,
        o.repair,
        o.fetcher,
      );
      o.validate?.(result);
      return { result, cleanup: legacy.cleanup };
    }
  }
  const validateWithGrounding = o.validate;
  o = {
    ...o,
    validate: (result) =>
      validateWithGrounding?.(result, { independentGrounding: true }),
  };
  const inputHash = await sha256(
    JSON.stringify({
      version: 1,
      task: o.task,
      context: o.context,
      evidence: o.evidence,
      requiredIds: o.requiredIds,
      manifest: o.manifest,
      language: o.language,
    }),
  );
  const threadId = await sha256(`${o.job.id}:${o.prefix}:${inputHash}`);
  const store = new ModelGraphStore(o.backend, o.job, threadId);
  const thread = await store.action("init", {
    input_hash: inputHash,
    task: o.task,
    graph_version: 1,
  });
  if (thread.status === "accepted") {
    const result = (await store.action("result_get", { id: thread.result_id }))
      .value;
    o.validate?.(result);
    return { result, threadId };
  }
  let release: (() => Promise<void>) | undefined;
  const ledgerFor = (operation: string, unit: string, repair = false) => {
    const original = modelLedger(
      o.backend,
      o.job,
      `${o.prefix}:${operation}`,
      o.environments,
      repair ? o.task : undefined,
    );
    // LangGraph must commit its pending writes while the lease is still valid.
    // executeModel normally releases it before throwing ModelDeferred.
    const ledger: Ledger = {
      ...original,
      beforeSend: async () => {
        await store.action("candidate_budget", { unit });
      },
      candidateReceived: async (usage_id) => {
        await store.action("candidate_received", { usage_id, unit });
      },
      saveRound: async (progress, releaseJob) => {
        await original.saveRound!(progress, false);
        if (releaseJob) release = () => original.saveRound!(progress, true);
      },
      defer: async (reservation, retryAfter, healthyPoll) => {
        release = () => original.defer!(reservation, retryAfter, healthyPoll);
      },
    };
    return ledger;
  };
  const cachedCall = async (
    key: string,
    task: Options["task"] | "repair_result" | "verify_grounding",
    context: any,
    unit: string,
    validate?: (result: any) => void,
    writerModel?: string,
    requiredIds = o.requiredIds,
  ) => {
    const cached = await store.action("result_get", { key });
    if (cached) return cached;
    const operationKey = key.includes("-v3-")
      ? `verification-v3:${await sha256(key)}`
      : key;
    const ledger = ledgerFor(operationKey, unit, task === "repair_result");
    if (key.startsWith("verification-repair-")) {
      ledger.beforeSend = async () => {
        const budget = await store.action("candidate_budget", { unit });
        if (budget.count >= 1)
          throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
      };
    }
    ledger.validateCandidate = validate;
    if (writerModel) {
      const preflight = ledger.preflight;
      ledger.preflight = async (manifest, task) => {
        const pool = await preflight(manifest, task);
        if (!pool.pending_model_config_id)
          pool.providers.sort(
            (a, b) =>
              Number(a.model_config_id === writerModel) -
              Number(b.model_config_id === writerModel),
          );
        return pool;
      };
    }
    if (task === "verify_grounding" && !context.verification_scope)
      context = await verificationContext(store, ledger, context, o.manifest);
    const verificationRevision =
      task === "verify_grounding"
        ? await pinVerificationPrompt({
            backend: o.backend,
            store,
            job: o.job,
            requestPrefix: `${o.prefix}:${operationKey}`,
            context,
            evidence: o.evidence,
            requiredIds,
            language: o.language,
            repair: o.repair,
          })
        : 1;
    const semanticRevision = await pinSemanticPrompt({
      backend: o.backend,
      store,
      job: o.job,
      requestPrefix: `${o.prefix}:${operationKey}`,
      task,
      context,
      evidence: o.evidence,
      requiredIds,
      language: o.language,
      repair: task === "repair_result" || o.repair,
      verificationRevision,
    });
    let producer: Record<string, unknown> | undefined;
    let preparedRequest: StructuredRequest | undefined;
    let receivedUsage: string | undefined;
    const received = ledger.candidateReceived;
    ledger.candidateReceived = async (usageId) => {
      await received?.(usageId);
      receivedUsage = usageId;
    };
    const prepared = ledger.requestPrepared;
    ledger.requestPrepared = async (request) => {
      producer = request.target;
      preparedRequest = request;
      receivedUsage = undefined;
      await prepared?.(request);
    };
    if (task === "verify_grounding") {
      ledger.invalidCandidate = (result, code) =>
        retainInvalidVerification(store, key, result, code, producer);
    } else {
      ledger.invalidCandidate = async (result, code) => {
        if (!receivedUsage || !preparedRequest) return;
        await retainInvalidWriter(store, {
          usage_id: receivedUsage,
          request_prefix: `${o.prefix}:${operationKey}`,
          request_input_hash: preparedRequest.inputHash,
          task,
          result,
          code,
          producer: producer ?? null,
        });
      };
    }
    const result = await executeModel(
      task,
      context,
      o.evidence,
      requiredIds,
      o.manifest,
      o.environments,
      ledger,
      o.language,
      task === "repair_result" || o.repair,
      o.fetcher,
      verificationRevision,
      { independentGrounding: true, semanticRevision },
    );
    // Persist the result before returning the node output/checkpoint. A replay
    // after this write never submits the same completed candidate again.
    const saved = await store.action("result_put", {
      key,
      value: { result, producer: producer ?? null },
    });
    await ledger
      .cleanup?.()
      .catch(() => console.warn("provider_request_cleanup_pending"));
    return saved;
  };
  const correctionMarker = async (key: string) =>
    `verification-correction-ready-${await sha256(key)}`;
  const markCorrectionReady = async (key: string) =>
    store.action("result_put", {
      key: await correctionMarker(key),
      value: { version: 1 },
    });
  const correctionFor = async (
    key: string,
    repairKey: string,
    unit: string,
    contextFor: (invalid: any) => any,
    requiredIds: string[],
  ) => {
    const invalid = await store.action("result_get", { key: `invalid-${key}` });
    if (!invalid) return null;
    if (await store.action("result_get", { key: await correctionMarker(key) }))
      return invalid;
    // An invalid candidate from provider A does not end the normal round:
    // provider B may already be running with the original request identity.
    // Preserve legacy accepted corrective requests too, before they had markers.
    const operationKey = repairKey.includes("-v3-")
      ? `verification-v3:${await sha256(repairKey)}`
      : repairKey;
    const ledger = ledgerFor(operationKey, unit);
    let context = contextFor(invalid);
    if (!context.verification_scope)
      context = await verificationContext(store, ledger, context, o.manifest);
    const verificationRevision = await pinVerificationPrompt({
      backend: o.backend,
      store,
      job: o.job,
      requestPrefix: `${o.prefix}:${operationKey}`,
      context,
      evidence: o.evidence,
      requiredIds,
      language: o.language,
      repair: o.repair,
    });
    const semanticRevision = await pinSemanticPrompt({
      backend: o.backend,
      store,
      job: o.job,
      requestPrefix: `${o.prefix}:${operationKey}`,
      task: "verify_grounding",
      context,
      evidence: o.evidence,
      requiredIds,
      language: o.language,
      repair: o.repair,
      verificationRevision,
    });
    const inputHash = await sha256(
      modelPrompt(
        "verify_grounding",
        context,
        o.evidence,
        requiredIds,
        o.language,
        o.repair,
        verificationRevision,
        semanticRevision,
      ),
    );
    const round = o.job.checkpoint?.model_round;
    if (round) {
      if (round.input_hash !== inputHash) return null;
    } else {
      const pool = await ledger.preflight(o.manifest, "verify_grounding");
      if (pool.pending_model_config_id) {
        const config = pool.providers.find(
          (p) => p.model_config_id === pool.pending_model_config_id,
        );
        // This also handles a crash after provider-ID persistence but before
        // the round checkpoint. A matching phase is resumed, never resubmitted.
        if (
          !config ||
          !(await ledger.resume?.(
            config.provider,
            inputHash,
            o.manifest,
            config,
          ))
        )
          return null;
      }
    }
    await markCorrectionReady(key);
    return invalid;
  };
  const deferVerifierCorrection = async (
    error: unknown,
    key: string,
    correcting: boolean,
  ) => {
    if (
      !correcting &&
      error instanceof ModelError &&
      [
        "EVIDENCE_REFERENCE_INVALID",
        "MODEL_COVERAGE_INCOMPLETE",
        "MODEL_ROUND_EXHAUSTED",
        "MODEL_CORRECTION_EXHAUSTED",
      ].includes(error.code) &&
      (await store.action("result_get", { key: `invalid-${key}` }))
    ) {
      // Only a completed unsuccessful round can switch to the one corrective
      // request. Persist that transition before releasing its queue lease.
      await markCorrectionReady(key);
      release = () => store.action("yield").then(() => {});
      throw new ModelDeferred();
    }
    throw error;
  };
  const recoverVerification = async (
    key: string,
    repairKey: string,
    unit: string,
    candidate: unknown,
    hash: string,
    requiredIds: string[],
    scope?: Parameters<typeof validateGroundingReport>[5],
  ) => {
    // Revised deterministic guards can recover either whole reports or a
    // scoped batch. Keep the latest corrective report's semantic findings.
    for (const retainedKey of [`invalid-${repairKey}`, `invalid-${key}`]) {
      const retained = await store.action("result_get", { key: retainedKey });
      if (!retained) continue;
      try {
        validateGroundingReport(
          retained.value.result,
          candidate,
          hash,
          o.evidence,
          requiredIds,
          scope,
        );
      } catch {
        continue;
      }
      const pool = await ledgerFor(key, unit).preflight(
        o.manifest,
        "verify_grounding",
      );
      // Finish an accepted remote request before recovery; never leave its
      // reservation behind merely because an older report is now valid.
      if (pool.pending_model_config_id) return null;
      return store.action("result_put", {
        key,
        value: {
          result: retained.value.result,
          producer: retained.value.producer ?? null,
        },
      });
    }
    return null;
  };
  const graph = new StateGraph(State)
    .addNode("produce", async (state) => {
      let task: Options["task"] | "repair_result" = o.task,
        context = o.context;
      if (state.repairCount) {
        const candidate = (
          await store.action("result_get", { id: state.candidateRef })
        ).value.result;
        const report = (
          await store.action("result_get", { id: state.reportRef })
        ).value.result;
        task = "repair_result";
        context = {
          target_task: o.task,
          original_context: o.context,
          candidate,
          findings: groundingDefects(report),
        };
      }
      const candidate = await cachedCall(
        `candidate-${state.repairCount}`,
        task,
        context,
        "writer",
        (value) =>
          o.validate?.(task === "repair_result" ? value.result : value),
      );
      return { candidateRef: candidate.id };
    })
    .addNode("verify", async (state) => {
      const stored = (
        await store.action("result_get", { id: state.candidateRef })
      ).value;
      const candidate = state.repairCount
        ? stored.result.result
        : stored.result;
      const hash = await sha256(JSON.stringify(candidate));
      const units = candidateContent(candidate);
      const reportKey = `verification-${hash}`;
      const existingReport = await store.action("result_get", {
        key: reportKey,
      });
      if (existingReport) return { reportRef: existingReport.id };
      const recovered = await recoverVerification(
        reportKey,
        `verification-repair-${hash}`,
        `verifier-${hash}`,
        candidate,
        hash,
        o.requiredIds,
      );
      if (recovered) return { reportRef: recovered.id };
      let batches = verificationBatches(candidate);
      if (batches.length) {
        const formatKey = `verification-batches-${hash}`;
        const pinned = await store.action("result_get", { key: formatKey });
        if (!pinned) {
          const pool = await ledgerFor(reportKey, `verifier-${hash}`).preflight(
            o.manifest,
            "verify_grounding",
          );
          if (pool.pending_model_config_id) batches = [];
          else
            await store.action("result_put", {
              key: formatKey,
              value: { version: 3 },
            });
        }
      }
      if (batches.length) {
        const reports: any[] = [];
        const scopes = [
          ...batches.map((units, i) => ({
            units,
            key: `content-${i}`,
            requiredIds: [] as string[],
            requirementsOnly: false,
          })),
          {
            units,
            key: "requirements",
            requiredIds: o.requiredIds,
            requirementsOnly: true,
          },
        ];
        for (const scope of scopes) {
          let completedNow = false;
          const key = `verification-v3-${hash}-${scope.key}`;
          const repairKey = `verification-repair-v3-${hash}-${scope.key}`;
          let report = await store.action("result_get", { key });
          if (!report)
            report = await recoverVerification(
              key,
              repairKey,
              `v3-${hash}-${scope.key}`,
              candidate,
              hash,
              scope.requiredIds,
              scope,
            );
          if (!report) {
            const contextFor = (invalid: any) => ({
              original_task: o.task,
              original_context: o.context,
              candidate_hash: hash,
              content_units: scope.units,
              verification_scope: scope.requirementsOnly
                ? "requirements_only"
                : "content_batch",
              ...(invalid
                ? {
                    invalid_verification_result: invalid.value.result,
                    validation_error: invalid.value.code,
                    correction_instruction:
                      "Correct only this report with exact candidate/source quotations. Preserve justified defects and all scoped IDs.",
                  }
                : {}),
            });
            const invalid = await correctionFor(
              key,
              repairKey,
              `v3-${hash}-${scope.key}-repair`,
              contextFor,
              scope.requiredIds,
            );
            try {
              report = await cachedCall(
                invalid ? repairKey : key,
                "verify_grounding",
                contextFor(invalid),
                `v3-${hash}-${scope.key}${invalid ? "-repair" : ""}`,
                (value) =>
                  validateGroundingReport(
                    value,
                    candidate,
                    hash,
                    o.evidence,
                    scope.requiredIds,
                    scope,
                  ),
                invalid
                  ? invalid.value.producer?.modelId
                  : stored.producer?.modelId,
                scope.requiredIds,
              );
            } catch (error) {
              return deferVerifierCorrection(error, key, Boolean(invalid));
            }
            if (invalid)
              await store.action("result_put", { key, value: report.value });
            completedNow = true;
          }
          reports.push(report.value.result);
          if (
            !scope.requirementsOnly &&
            groundingDefects(report.value.result).length
          ) {
            const pool = await ledgerFor(
              key,
              `v3-${hash}-${scope.key}`,
            ).preflight(o.manifest, "verify_grounding");
            // A later batch may already be running after a restart or guard
            // update. Retrieve it first instead of orphaning accepted work.
            if (!pool.pending_model_config_id) {
              const partial = mergeVerificationReports(hash, reports);
              validateGroundingReport(
                partial,
                candidate,
                hash,
                o.evidence,
                [],
                { units: batches.slice(0, reports.length).flat() },
                { aggregateVerification: true },
              );
              // This artifact can drive bounded writer repair only. It must
              // never populate the complete verification cache for this hash.
              const saved = await store.action("result_put", {
                key: `verification-repair-only-v3-${hash}-${scope.key}`,
                value: {
                  result: partial,
                  producer: null,
                  coverage: "repair_only",
                },
              });
              return { reportRef: saved.id };
            }
          }
          if (
            completedNow &&
            (!scope.requirementsOnly ||
              (o.backend.invocationBudgetMs ?? 110000) -
                (Date.now() - invocationStartedAt) <
                10000)
          ) {
            // Content batches yield before another provider call. The final
            // coverage batch can merge and commit locally in this lease when
            // at least ten seconds remain; otherwise replay uses its saved result.
            release = () => store.action("yield").then(() => {});
            throw new ModelDeferred();
          }
        }
        const coverage = reports.pop();
        const merged = mergeVerificationReports(hash, reports, coverage);
        validateGroundingReport(
          merged,
          candidate,
          hash,
          o.evidence,
          o.requiredIds,
          undefined,
          { aggregateVerification: true },
        );
        const saved = await store.action("result_put", {
          key: reportKey,
          value: { result: merged, producer: null },
        });
        return { reportRef: saved.id };
      }
      const contextFor = (invalid: any) => ({
        original_task: o.task,
        original_context: o.context,
        candidate,
        candidate_hash: hash,
        candidate_text: units.map((u) => u.text).join("\n"),
        content_units: units,
        ...(invalid
          ? {
              invalid_verification_result: invalid.value.result,
              validation_error: invalid.value.code,
              correction_instruction:
                "Correct this verification report, not the original candidate. Recheck every citation against the supplied evidence and every candidate quote against content_units. Copy exact contiguous quotations, without paraphrase or ellipses. Keep unsupported/contradicted findings where justified; never change a verdict merely to pass validation. Return complete coverage IDs and the same candidate hash.",
            }
          : {}),
      });
      const invalid = await correctionFor(
        reportKey,
        `verification-repair-${hash}`,
        `verifier-repair-${hash}`,
        contextFor,
        o.requiredIds,
      );
      let report;
      try {
        report = await cachedCall(
          invalid ? `verification-repair-${hash}` : reportKey,
          "verify_grounding",
          contextFor(invalid),
          invalid ? `verifier-repair-${hash}` : `verifier-${hash}`,
          (value) =>
            validateGroundingReport(
              value,
              candidate,
              hash,
              o.evidence,
              o.requiredIds,
            ),
          invalid ? invalid.value.producer?.modelId : stored.producer?.modelId,
        );
      } catch (error) {
        return deferVerifierCorrection(error, reportKey, Boolean(invalid));
      }
      return { reportRef: report.id };
    })
    .addNode("decide", async (state) => {
      if (o.task === "connection_probe") return { decision: "accept" as const };
      const report = (await store.action("result_get", { id: state.reportRef }))
        .value.result;
      const defects = groundingDefects(report);
      if (!defects.length) return { decision: "accept" as const };
      const defectHash = await sha256(JSON.stringify(defects));
      const decision =
        state.repairCount >= 2 || defectHash === state.defectHash
          ? "needs_review"
          : "repair";
      return {
        decision,
        defectHash,
        repairCount: state.repairCount + (decision === "repair" ? 1 : 0),
      };
    })
    .addNode("accept", async (state) => {
      const stored = (
        await store.action("result_get", { id: state.candidateRef })
      ).value.result;
      const result = state.repairCount ? stored.result : stored;
      if (o.task !== "connection_probe") {
        const report = state.reportRef
          ? await store.action("result_get", { id: state.reportRef })
          : null;
        if (!report || report.value.coverage === "repair_only")
          throw new ModelError("MODEL_COVERAGE_INCOMPLETE");
        validateGroundingReport(
          report.value.result,
          result,
          await sha256(JSON.stringify(result)),
          o.evidence,
          o.requiredIds,
          undefined,
          { aggregateVerification: true },
        );
        if (groundingDefects(report.value.result).length)
          throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
      }
      o.validate?.(result);
      const saved = await store.action("result_put", {
        key: "accepted",
        value: result,
      });
      await store.action("accept", { result_id: saved.id });
    })
    .addNode("needs_review", async () => {
      await store.action("needs_review");
    })
    .addEdge(START, "produce")
    .addConditionalEdges(
      "produce",
      () => (o.task === "connection_probe" ? "decide" : "verify"),
      ["decide", "verify"],
    )
    .addEdge("verify", "decide")
    .addConditionalEdges(
      "decide",
      (state) => (state.decision === "repair" ? "produce" : state.decision!),
      ["produce", "accept", "needs_review"],
    )
    .addEdge("accept", END)
    .addEdge("needs_review", END)
    .compile({ checkpointer: store, interruptAfter: ["produce", "verify"] });
  const config = {
    configurable: { thread_id: threadId },
    durability: "sync" as const,
    recursionLimit: 32,
  };
  try {
    const checkpoint = await store.getTuple(config);
    if (thread.status === "needs_review") {
      const recovered =
        checkpoint &&
        ((await recoverBlockedWriter({
          backend: o.backend,
          store,
          job: o.job,
          threadId,
          prefix: o.prefix,
          task: o.task,
          context: o.context,
          evidence: o.evidence,
          requiredIds: o.requiredIds,
          manifest: o.manifest,
          language: o.language,
          repair: o.repair,
          fetcher: o.fetcher,
          state: await graph.getState(config),
          validate: o.validate,
        })) ||
          (await recoverBlockedVerification({
            backend: o.backend,
            store,
            job: o.job,
            evidence: o.evidence,
            requiredIds: o.requiredIds,
            manifest: o.manifest,
            state: await graph.getState(config),
            validate: o.validate,
            update: (values) => graph.updateState(config, values, "verify"),
          })) ||
          (await recoverAlternatePaidWriter({
            backend: o.backend,
            store,
            job: o.job,
            threadId,
            prefix: o.prefix,
            task: o.task,
            context: o.context,
            evidence: o.evidence,
            requiredIds: o.requiredIds,
            manifest: o.manifest,
            language: o.language,
            repair: o.repair,
            fetcher: o.fetcher,
            state: await graph.getState(config),
            validate: o.validate,
            update: (values) => graph.updateState(config, values, "produce"),
          })));
      if (!recovered) throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
    } else if (checkpoint)
      await recoverUnstartedRepair({
        backend: o.backend,
        store,
        job: o.job,
        prefix: o.prefix,
        task: o.task,
        context: o.context,
        evidence: o.evidence,
        requiredIds: o.requiredIds,
        manifest: o.manifest,
        language: o.language,
        state: await graph.getState(config),
        update: (values) => graph.updateState(config, values, "produce"),
      });
    await graph.invoke(checkpoint ? null : {}, config);
    await store.flush();
    const state = await graph.getState(config);
    // Verification has completed: the small decision/commit phase needs no
    // provider call. If correction is needed, yield before the next model node.
    if (state.next[0] === "decide") {
      const report = state.values.reportRef
        ? (await store.action("result_get", { id: state.values.reportRef }))
            .value.result
        : null;
      if (
        !report ||
        !groundingDefects(report).length ||
        state.values.repairCount >= 2 ||
        (await sha256(JSON.stringify(groundingDefects(report)))) ===
          state.values.defectHash
      )
        await graph.invoke(null, config);
    }
    await store.flush();
    const accepted = await store.action("result_get", { key: "accepted" });
    if (accepted) return { result: accepted.value, threadId };
    const current = await store.action("init", {
      input_hash: inputHash,
      task: o.task,
      graph_version: 1,
    });
    if (current.status === "needs_review")
      throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
    await store.action("yield");
    throw new ModelDeferred();
  } catch (error) {
    await store.flush();
    if (release) await release();
    if ((error as any)?.code === "MODEL_CORRECTION_EXHAUSTED")
      await store.action("needs_review");
    throw error;
  }
}
