import { AsyncLocalStorageProviderSingleton } from "langsmith/singletons/traceable";
import { env as runtimeEnvironment } from "node:process";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { Backend, BackendEnvironment } from "./backend.ts";
import {
  executeModel,
  ModelDeferred,
  ModelError,
  sha256,
  type Evidence,
  type Reference,
  type Ledger,
} from "./model.ts";
import type { PrimaryModelTask } from "./modelSchemas.ts";
import { modelLedger } from "./modelLedger.ts";
import { ModelGraphStore } from "./modelGraphStore.ts";
import {
  candidateContent,
  groundingDefects,
  validateGroundingReport,
} from "./modelGrounding.ts";

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
  validate?: (result: any) => void;
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
  if (thread.status === "needs_review")
    throw new ModelError("MODEL_CORRECTION_EXHAUSTED");
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
      defer: async (reservation, retryAfter) => {
        release = () => original.defer!(reservation, retryAfter);
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
  ) => {
    const cached = await store.action("result_get", { key });
    if (cached) return cached;
    const ledger = ledgerFor(key, unit, task === "repair_result");
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
    if (task === "verify_grounding")
      context = await verificationContext(store, ledger, context, o.manifest);
    let producer: Record<string, unknown> | undefined;
    const prepared = ledger.requestPrepared;
    ledger.requestPrepared = async (request) => {
      producer = request.target;
      await prepared?.(request);
    };
    const result = await executeModel(
      task,
      context,
      o.evidence,
      o.requiredIds,
      o.manifest,
      o.environments,
      ledger,
      o.language,
      task === "repair_result" || o.repair,
      o.fetcher,
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
      const report = await cachedCall(
        `verification-${hash}`,
        "verify_grounding",
        {
          original_task: o.task,
          original_context: o.context,
          candidate,
          candidate_hash: hash,
          candidate_text: units.map((u) => u.text).join("\n"),
          content_units: units,
        },
        `verifier-${hash}`,
        (value) =>
          validateGroundingReport(
            value,
            candidate,
            hash,
            o.evidence,
            o.requiredIds,
          ),
        stored.producer?.modelId,
      );
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
