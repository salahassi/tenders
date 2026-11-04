/** Synthetic-only, offline actual HTTP-handler qualification. Auth/RPC/Storage
 * authority is emulated; the saved v2 payload comes from the migrated API test.
 * No upstream/PostgREST/hosted-auth or production throughput claim follows. */
import { createHash } from "node:crypto";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend.ts";
import { DOCX_MIME } from "../../supabase/functions/_shared/deliveryExport.ts";

interface NativeRuntime {
  readTextFile(path: string): Promise<string>;
  open(path: string): Promise<{ readable: ReadableStream<Uint8Array> }>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const actor = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const environment: BackendEnvironment = {
  url: "https://synthetic.example.test",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-service",
  workerSecret: "synthetic-worker",
  allowedOrigins: ["https://app.example.test"],
  models: modelEnvironments(() => undefined),
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function fileDigest(path: string) {
  const source = await runtime.open(path),
    reader = source.readable.getReader(),
    hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, hash: hash.digest("hex") };
}

export async function measureApiHandler(folder: string, passes = 2) {
  const name = "dense-minimal-sparse-body-limit-authored";
  const snapshotPath = `${folder}/${name}.snapshot.json`,
    artifactPath = `${folder}/verification.docx`;
  // Keep only the serialized transport fixture between requests, like a remote
  // response source. Each RPC parses one fresh response, never structuredClones
  // a second permanently retained full snapshot object.
  const serializedSnapshot = await runtime.readTextFile(snapshotPath);
  const saved = await fileDigest(artifactPath);
  const counters = {
    authenticate: 0,
    membership: 0,
    context: 0,
    storage: 0,
    authorize: 0,
    list: 0,
  };
  let releaseContext: (() => void) | undefined;
  let contextEntered: (() => void) | undefined;
  let holdContext = false;
  let phase = "starting",
    healthCalls = 0,
    healthFailure: unknown;
  const started = performance.now();
  const peak = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
  const phases: Record<string, unknown>[] = [];
  const sample = () => {
    const memory = runtime.memoryUsage();
    for (const key of Object.keys(peak) as Array<keyof typeof peak>)
      peak[key] = Math.max(peak[key], memory[key]);
    return memory;
  };
  let persist: Promise<void> | undefined;
  const telemetry = () => {
    sample();
    if (!persist)
      persist = runtime
        .writeFile(
          "/outputs/api-handler-telemetry.json",
          new TextEncoder().encode(
            JSON.stringify({
              phase,
              elapsed_ms: Math.round(performance.now() - started),
              counters,
              parent_memory: runtime.memoryUsage(),
              parent_memory_peaks: peak,
              phases,
            }),
          ),
        )
        .finally(() => {
          persist = undefined;
        });
  };
  const backend = {
    authenticate: async () => {
      counters.authenticate++;
      return { id: actor };
    },
    membership: async () => {
      counters.membership++;
      return { workspace_id: actor, role: "Owner" };
    },
    internal: async (operation: string, args: Record<string, unknown>) => {
      assert(
        args.actor_id === actor && args.artifact_id === artifactId,
        "Canonical authenticated artifact identity changed",
      );
      if (operation === "delivery_artifact_context") {
        counters.context++;
        if (holdContext) {
          contextEntered?.();
          await new Promise<void>((resolve) => {
            releaseContext = resolve;
          });
        }
        const snapshot = JSON.parse(serializedSnapshot);
        assert(
          snapshot.payload.version === 2,
          "Expected actual persisted authored v2 snapshot",
        );
        return {
          snapshot,
          artifact: {
            id: artifactId,
            status: "ready",
            storage_key: "synthetic/current.docx",
            volume: "combined",
            content_hash: saved.hash,
            expected_size: saved.size,
            original_name: "synthetic-admitted-proposal.docx",
            mime_type: DOCX_MIME,
          },
        };
      }
      assert(
        operation === "authorize_delivery_artifact_download" &&
          args.actual_hash === saved.hash,
        "Final currentness/hash authorization not called",
      );
      counters.authorize++;
      return { authorized: true };
    },
    deliveryObject: async (_key: string, signal?: AbortSignal) => {
      counters.storage++;
      signal?.throwIfAborted();
      // File-backed streaming transport creates the same Blob required by the
      // actual backend. No permanent byte-array/Blob copy is retained by this fixture.
      const file = await runtime.open(artifactPath),
        reader = file.readable.getReader();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              signal?.throwIfAborted();
              const value = await reader.read();
              if (value.done) {
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(value.value);
            } catch (error) {
              await reader.cancel(error);
              reader.releaseLock();
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            reader.releaseLock();
          },
        },
        { highWaterMark: 0 },
      );
      return await new Response(stream).blob();
    },
    list: async () => {
      counters.list++;
      return {
        records: [{ id: actor, title: "Synthetic small liveness control" }],
        next_cursor: null,
      };
    },
  };
  const handle = createApiHandler(
    environment,
    () => backend as unknown as Backend,
  );
  const request = (
    path = `/v1/delivery-artifacts/${artifactId}/download`,
    signal?: AbortSignal,
  ) =>
    new Request(`https://edge.example.test/functions/v1/api${path}`, {
      signal,
      headers: {
        authorization: "Bearer synthetic-user-token",
        origin: environment.allowedOrigins[0],
      },
    });
  const busy = async () => {
    const before = {
      context: counters.context,
      storage: counters.storage,
      list: counters.list,
    };
    const response = await handle(request());
    const body = await response.json();
    assert(
      response.status === 503 &&
        body.error.code === "FILE_PROCESSING_BUSY" &&
        body.error.retryable === true,
      "Concurrent heavy request was not refused with retryable busy",
    );
    assert(
      counters.context === before.context &&
        counters.storage === before.storage &&
        counters.list === before.list,
      "Busy request allocated a context or storage object",
    );
    return {
      status: response.status,
      code: body.error.code,
      context_and_storage_skipped: true,
    };
  };
  const health = setInterval(() => {
    void handle(request("/v1/health"))
      .then(async (response) => {
        assert(response.status === 200, "Health unavailable");
        await response.text();
        healthCalls++;
      })
      .catch((error) => {
        healthFailure = error;
      });
  }, 500);
  const monitoring = setInterval(telemetry, 250);
  const cases: Record<string, unknown>[] = [];
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  const controllers = new Set<AbortController>();
  try {
    for (let pass = 0; pass < passes; pass++) {
      const accepted = performance.now(),
        controller = new AbortController();
      controllers.add(controller);
      // Mirrors the reviewed gateway ceiling for this test. This is not an
      // actual NGINX/network test and cannot establish its disconnect behavior.
      const deadline = setTimeout(
        () =>
          controller.abort(
            new Error("Synthetic 150-second gateway deadline exceeded"),
          ),
        150_000,
      );
      deadlines.add(deadline);
      holdContext = true;
      const entered = new Promise<void>((resolve) => {
        contextEntered = resolve;
      });
      phase = `request-${pass}-context`;
      telemetry();
      const pending = handle(request(undefined, controller.signal));
      await entered;
      const burst = await Promise.all([busy(), busy()]);
      holdContext = false;
      releaseContext?.();
      phase = `request-${pass}-native-verification`;
      telemetry();
      const response = await pending;
      const headerMs = Math.round(performance.now() - accepted);
      assert(
        response.status === 200,
        `Admitted download failed with HTTP ${response.status}: ${await (response.status === 200 ? Promise.resolve("") : response.text())}`,
      );
      assert(
        response.headers.get("content-length") === String(saved.size),
        "Download length changed",
      );
      phase = `request-${pass}-slow-consumer`;
      telemetry();
      await pause(1000);
      const slowBusy = await busy();
      const reader = response.body!.getReader(),
        hash = createHash("sha256");
      let size = 0,
        chunks = 0,
        cancelled = false;
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        chunks++;
        hash.update(value.value);
        if (pass === passes - 1 && size === saved.size) {
          // All bytes are compared but EOF has not been consumed; the permit
          // must still be held until explicit downstream cancellation settles.
          await busy();
          await reader.cancel(
            "synthetic downstream cancellation after last byte",
          );
          cancelled = true;
          break;
        }
      }
      reader.releaseLock();
      clearTimeout(deadline);
      deadlines.delete(deadline);
      controllers.delete(controller);
      assert(
        size === saved.size && hash.digest("hex") === saved.hash,
        "Actual handler returned altered or incomplete document bytes",
      );
      const liveness = await handle(request("/v1/documents"));
      assert(
        liveness.status === 200,
        "Heavy lane did not release after response consumption/cancel",
      );
      await liveness.text();
      const result = {
        name: `actual-handler-admitted-download-${pass}`,
        outcome: "verified",
        elapsed_ms: Math.round(performance.now() - accepted),
        response_headers_ms: headerMs,
        artifact_bytes: size,
        artifact_hash: saved.hash,
        response_chunks: chunks,
        burst,
        slow_consumer_busy: slowBusy,
        response_cancelled_after_last_byte: cancelled,
        subsequent_heavy_read_status: liveness.status,
        parent_memory_after: sample(),
      };
      cases.push(result);
      phases.push(result);
      telemetry();
    }
    assert(
      counters.context === passes &&
        counters.storage === passes &&
        counters.authorize === passes,
      "Accepted download/currentness inventory changed",
    );
    if (healthFailure) throw healthFailure;
    return {
      scope:
        "offline actual createApiHandler delivery downloads with migrated API-admitted v2 fixture and emulated Auth/RPC/Storage",
      hosted_acceptance: false,
      actual_upstream_postgrest: false,
      actual_gateway: false,
      production_slo_qualified: false,
      forced_gc: false,
      parent_restarted_between_requests: false,
      accepted_requests: passes,
      snapshot_source: snapshotPath,
      artifact_source: artifactPath,
      health_calls: healthCalls,
      counters,
      parent_memory_peaks: peak,
      parent_memory_final: runtime.memoryUsage(),
      cases,
    };
  } finally {
    for (const timer of deadlines) clearTimeout(timer);
    for (const controller of controllers)
      controller.abort(new Error("Synthetic harness terminated"));
    clearInterval(health);
    clearInterval(monitoring);
    releaseContext?.();
    if (persist) await persist;
    telemetry();
    if (persist) await persist;
  }
}
