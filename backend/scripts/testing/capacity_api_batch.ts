/** Synthetic local handler qualification against actual PostgreSQL/PostgREST.
 * Only Auth user lookup is emulated. Membership, commands, chunks and row policy
 * run through the real caller JWT. This replaces runtime/main.ts in the retained
 * immutable image entrypoint; it is not hosted Auth or gateway qualification. */
import { createHash } from "node:crypto";
import {
  Backend,
  modelEnvironments,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend.ts";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import { createWorkerHandler } from "../../supabase/functions/worker/handler.ts";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway.ts";
import { DurableScheduler, runScheduler } from "../runtime/scheduler.ts";
import {
  batchStreamOracle,
  type BatchResultDescriptor,
} from "./batchStreamOracle.ts";

const runtime = (
  globalThis as unknown as {
    Deno: {
      args: string[];
      readTextFile(path: string): Promise<string>;
      writeTextFile(path: string, value: string): Promise<void>;
      memoryUsage(): {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        external: number;
      };
      serve(
        options: { hostname: string; port: number; onListen(): void },
        handler: (request: Request) => Promise<Response>,
      ): { shutdown(): Promise<void> };
    };
  }
).Deno;
const config = JSON.parse(await runtime.readTextFile(runtime.args[0]));
// runtime/main.ts imports all these modules even when the chosen service is API.
// Keep the actual module graph resident without invoking other services.
const applicationGraphLoaded = [
  createApiHandler,
  createWorkerHandler,
  createBrowserGateway,
  DurableScheduler,
  runScheduler,
].every((value) => typeof value === "function");
if (!applicationGraphLoaded) throw Error("Incomplete runtime module graph");
if (
  config.commands?.length !== 100 ||
  !/^[0-9a-f-]{36}$/.test(config.actor) ||
  !config.token ||
  !config.key
)
  throw Error("Exact synthetic capacity fixture required");
const environment: BackendEnvironment = {
  url: "http://127.0.0.1:3002",
  publishableKey: "synthetic-local-publishable",
  serviceKey: "synthetic-local-service",
  workerSecret: "synthetic-local-worker",
  allowedOrigins: ["https://synthetic.example.test"],
  models: modelEnvironments(() => undefined),
};
const counters = {
  auth: 0,
  membership: 0,
  prepare: 0,
  chunks: 0,
  documents: 0,
  health: 0,
};
let manifest:
  | {
      receipt_id: string;
      result_count: number;
      results: BatchResultDescriptor[];
    }
  | undefined;
const manifestHashes: string[] = [];
let phase = "starting",
  healthError: unknown,
  persisted: Promise<void> | undefined;
const started = performance.now(),
  parentPeaks = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const sample = () => {
  const current = runtime.memoryUsage();
  for (const key of Object.keys(parentPeaks) as Array<keyof typeof parentPeaks>)
    parentPeaks[key] = Math.max(parentPeaks[key], current[key]);
  if (!persisted)
    persisted = runtime
      .writeTextFile(
        "/outputs/api-batch-telemetry.json",
        JSON.stringify({
          phase,
          elapsed_ms: Math.round(performance.now() - started),
          counters,
          parentPeaks,
          current,
        }),
      )
      .finally(() => {
        persisted = undefined;
      });
};
// PostgREST's bare /rpc prefix differs from the production gateway's /rest/v1.
// This real loopback HTTP adapter only strips that prefix and observes bounded
// prepare metadata. It neither fabricates nor edits database response bytes.
const prefix = runtime.serve(
  { hostname: "127.0.0.1", port: 3002, onListen() {} },
  async (request) => {
    const incoming = new URL(request.url);
    assert(
      request.headers.get("authorization") === `Bearer ${config.token}`,
      "Caller JWT changed in transit",
    );
    const path = incoming.pathname.replace(/^\/rest\/v1\//, "");
    assert(
      [
        "rpc/current_membership",
        "rpc/app_batch_prepare",
        "rpc/app_batch_result_chunk",
        "documents",
        "jobs",
      ].includes(path),
      "Unexpected database route",
    );
    if (path === "rpc/current_membership") counters.membership++;
    if (path === "rpc/app_batch_prepare") counters.prepare++;
    if (path === "rpc/app_batch_result_chunk") counters.chunks++;
    if (path === "documents") counters.documents++;
    const response = await fetch(
      new Request(`http://127.0.0.1:3000/${path}${incoming.search}`, request),
    );
    if (path === "rpc/app_batch_prepare" && response.ok) {
      const reader = response.clone().body!.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          assert(size <= 65536, "Prepare exceeded manifest bound");
          parts.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        observed = JSON.parse(text);
      assert(
        observed.version === 1 &&
          observed.result_count === 100 &&
          observed.results?.length === 100,
        "Wrong immutable manifest",
      );
      manifest = observed;
      manifestHashes.push(hash(text));
    }
    return response;
  },
);
class SyntheticAuthBackend extends Backend {
  override async authenticate(token: string) {
    counters.auth++;
    assert(token === config.token, "Wrong synthetic Auth identity");
    return { id: config.actor } as Awaited<ReturnType<Backend["authenticate"]>>;
  }
}
const handle = createApiHandler(
  environment,
  () => new SyntheticAuthBackend(environment),
);
const commandRequest = (signal?: AbortSignal) =>
  new Request("https://edge.example.test/functions/v1/api/v1/commands", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${config.token}`,
      origin: environment.allowedOrigins[0],
      "content-type": "application/json",
      "idempotency-key": config.key,
    },
    body: JSON.stringify({ commands: config.commands }),
  });
const getRequest = (path: string) =>
  new Request(`https://edge.example.test/functions/v1/api${path}`, {
    headers: {
      authorization: `Bearer ${config.token}`,
      origin: environment.allowedOrigins[0],
    },
  });
async function busy() {
  const before = {
    prepare: counters.prepare,
    chunks: counters.chunks,
    documents: counters.documents,
  };
  const response = await handle(commandRequest()),
    body = await response.json();
  assert(
    response.status === 503 &&
      body.error?.code === "FILE_PROCESSING_BUSY" &&
      body.error.retryable === true,
    "Busy request was admitted",
  );
  assert(
    counters.prepare === before.prepare &&
      counters.chunks === before.chunks &&
      counters.documents === before.documents,
    "Busy request reached heavy database work",
  );
  return {
    status: response.status,
    code: body.error.code,
    heavy_upstream_skipped: true,
  };
}
async function reacquire() {
  const response = await handle(getRequest("/v1/documents"));
  assert(response.status === 200, "Heavy admission not released");
  await response.text();
  return response.status;
}
const controller = new AbortController();
const timeout = setTimeout(
  () =>
    controller.abort(new Error("Synthetic API request exceeded 150 seconds")),
  150000,
);
const health = setInterval(() => {
  void handle(getRequest("/v1/health"))
    .then(async (response) => {
      assert(response.status === 200, "Health failed");
      await response.text();
      counters.health++;
    })
    .catch((error) => {
      healthError = error;
    });
}, 500);
const monitoring = setInterval(sample, 250);
try {
  phase = "prepare";
  sample();
  const accepted = performance.now(),
    response = await handle(commandRequest(controller.signal));
  assert(
    response.status === 200,
    `Batch failed: ${response.status} ${response.status !== 200 ? await response.text() : ""}`,
  );
  const headersMs = Math.round(performance.now() - accepted);
  assert(manifest, "No actual database manifest observed");
  assert(
    counters.prepare === 1 && counters.chunks === 0,
    "Prefetch before downstream consumption",
  );
  phase = "slow-consumer";
  sample();
  await pause(1000);
  const slowBusy = await busy();
  assert(counters.chunks === 0, "Paused consumer prefetched result bytes");
  const expected = manifest.results,
    receiptId = manifest.receipt_id;
  const oracle = batchStreamOracle(expected),
    reader = response.body!.getReader();
  phase = "streaming-100-results";
  sample();
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      oracle.write(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const complete = oracle.finish();
  clearTimeout(timeout);
  const fullMs = Math.round(performance.now() - accepted);
  assert(
    counters.chunks ===
      expected.reduce((sum, value) => sum + value.chunk_count, 0),
    "Chunk read count changed",
  );
  const eofReacquire = await reacquire();
  phase = "same-key-replay-cancel";
  sample();
  const replayController = new AbortController();
  const replayTimeout = setTimeout(
    () => replayController.abort(new Error("Replay control timeout")),
    30000,
  );
  let canceledBytes = 0;
  const chunkBefore = counters.chunks;
  try {
    const replay = await handle(commandRequest(replayController.signal));
    assert(
      replay.status === 200 &&
        manifestHashes.length === 2 &&
        manifestHashes[0] === manifestHashes[1],
      "Same-key replay changed manifest",
    );
    const replayReader = replay.body!.getReader();
    try {
      while (counters.chunks === chunkBefore) {
        const next = await replayReader.read();
        assert(!next.done, "Replay ended before a result chunk");
        canceledBytes += next.value.length;
      }
      await busy();
      await replayReader.cancel(
        "Synthetic downstream cancellation after first real result chunk",
      );
    } finally {
      replayReader.releaseLock();
    }
  } finally {
    clearTimeout(replayTimeout);
    replayController.abort();
  }
  const chunksAtCancel = counters.chunks;
  await pause(100);
  assert(
    counters.chunks === chunksAtCancel,
    "Cancellation continued result reads",
  );
  const cancelReacquire = await reacquire();
  if (healthError) throw healthError;
  phase = "job-summary-pagination";
  let summaryCursor: string | null = null,
    summaryRequests = 0,
    summaryRows = 0,
    fixtureRows = 0;
  const summaryIds = new Set<string>();
  do {
    const response = await handle(
      new Request(
        `https://edge.example.test/functions/v1/api/v1/job-summaries?limit=500${summaryCursor ? `&cursor=${summaryCursor}` : ""}`,
        {
          headers: {
            origin: environment.allowedOrigins[0],
            authorization: `Bearer ${config.token}`,
          },
        },
      ),
    );
    assert(response.status === 200, `Summary API failed: HTTP ${response.status}`);
    const text = await response.text();
    assert(
      !text.includes("PRIVATE_CHECKPOINT_") && text.length < 1024 * 1024,
      "Summary included full checkpoint data",
    );
    const { data } = JSON.parse(text);
    assert(
      Array.isArray(data.records) && data.records.length <= 500,
      "Summary page exceeded bound",
    );
    for (const row of data.records) {
      assert(
        !summaryIds.has(row.id) &&
          (!summaryCursor || row.id > summaryCursor) &&
          !("checkpoint" in row) &&
          !("lease_token" in row),
        "Summary row identity or projection changed",
      );
      summaryIds.add(row.id);
      if (row.model_round === 3 && row.routing_mode === "round_robin")
        fixtureRows++;
    }
    summaryRows += data.records.length;
    summaryRequests++;
    summaryCursor = data.next_cursor;
    assert(
      summaryRequests <= Math.ceil(config.summary_count / 500),
      "Summary pagination amplified requests",
    );
  } while (summaryCursor);
  assert(
    summaryRows === config.summary_count && fixtureRows === 1201,
    "Job summary history was truncated",
  );
  phase = "complete";
  sample();
  const result = {
    scope:
      "Actual immutable-image createApiHandler and Backend.batchStream with real local PostgreSQL/PostgREST; synthetic Auth user lookup and loopback prefix adapter",
    hosted_acceptance: false,
    actual_production_gateway: false,
    actual_auth_service: false,
    actual_membership_and_sql_authorization: true,
    aggregate_json_materialized: false,
    runtime_main_replaced_by_qualification_harness: true,
    application_graph_loaded: applicationGraphLoaded,
    product_code_overrides: false,
    request_id: config.key,
    receipt_id: receiptId,
    result_count: 100,
    job_summary: {
      records: summaryRows,
      requests: summaryRequests,
      large_checkpoint_fixtures: fixtureRows,
      full_checkpoint_fields_returned: 0,
    },
    headers_ms: headersMs,
    full_stream_ms: fullMs,
    slow_consumer_busy: slowBusy,
    eof_reacquire: eofReacquire,
    replay_manifest_identical: true,
    cancellation: {
      bytes: canceledBytes,
      chunks: chunksAtCancel - chunkBefore,
      no_further_chunk_reads: true,
      heavy_reacquire: cancelReacquire,
    },
    complete,
    counters,
    parent_memory_peaks: parentPeaks,
    parent_memory_final: runtime.memoryUsage(),
  };
  await runtime.writeTextFile(
    "/outputs/api-batch-result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timeout);
  controller.abort();
  clearInterval(health);
  clearInterval(monitoring);
  await prefix.shutdown();
  if (persisted) await persisted;
  for (const name of [
    "memory.peak",
    "memory.max",
    "memory.events",
    "memory.stat",
    "memory.swap.current",
    "memory.swap.peak",
  ]) {
    try {
      await runtime.writeTextFile(
        `/outputs/cgroup_${name.replaceAll(".", "_")}`,
        await runtime.readTextFile(`/sys/fs/cgroup/${name}`),
      );
    } catch {
      /* parent monitor retains independent observations */
    }
  }
}
