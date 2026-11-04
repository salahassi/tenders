import { processDeliveryExport } from "../../supabase/functions/_shared/deliveryWorker.ts";
import { renderDeliveryIsolated } from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
import type { Backend } from "../../supabase/functions/_shared/backend.ts";
import type { RenderModel } from "../../supabase/functions/_shared/export.ts";
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import {
  FreeModelProvider,
  validateModelResult,
} from "../../supabase/functions/_shared/model.ts";
import { environment } from "../../supabase/functions/_shared/backend.ts";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";

type Runtime = {
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Actual native worker CPU and local readback proof, with explicitly emulated
 * SQL/Storage transport. Database lease/authority races require separate real-PG
 * evidence. This fixture never represents an approved or substantive proposal. */
export async function measureDeliveryWorker(runtime: Runtime, folder: string) {
  const original = JSON.parse(
    await runtime.readTextFile(
      `${folder}/dense-minimal-sparse-body-limit-authored.json`,
    ),
  ) as RenderModel;
  const content: Array<
    | { type: "paragraph"; text: string }
    | { type: "table"; headers: string[]; rows: string[][] }
  > = [];
  for (const block of original.blocks) {
    if (block.type === "table") content.push(block);
    else if (block.type !== "toc" && block.type !== "placeholder")
      content.push({ type: "paragraph", text: block.text });
  }
  const tableHash = async (model: RenderModel) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(model.blocks.filter((block) => block.type === "table")),
    );
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
  };
  const expectedTables = await tableHash(original);
  const health = createApiHandler(
    environment(() => undefined),
    () => {
      throw Error("Health checks must not create a database connection");
    },
  );
  const envelope = (candidate: unknown) =>
    JSON.stringify({
      id: "synthetic-transport",
      choices: [
        {
          message: { content: JSON.stringify(candidate) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  const candidate = (content_blocks: unknown[]) => ({
    key: "synthetic",
    title: "Synthetic response validation",
    content_blocks,
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  });
  const paragraphs = Array.from({ length: 100 }, () => ({
    type: "paragraph",
    text: "Z".repeat(10000),
  }));
  let remaining =
    1048576 - new TextEncoder().encode(envelope(candidate(paragraphs))).length;
  for (const block of paragraphs) {
    const added = Math.min(remaining, 20000 - block.text.length);
    block.text += "Z".repeat(added);
    remaining -= added;
  }
  if (remaining !== 0)
    throw Error(
      "Wire-boundary fixture does not fit the actual paragraph schema",
    );
  const wires = [
    {
      name: "exact-1MiB-provider-envelope",
      wire: envelope(candidate(paragraphs)),
    },
    {
      name: "100-tables-50000-cells-provider-envelope",
      wire: envelope(
        candidate(
          Array.from({ length: 100 }, () => ({
            type: "table",
            headers: Array(10).fill("X"),
            rows: Array.from({ length: 50 }, () => Array(10).fill("X")),
          })),
        ),
      ),
    },
  ].map((item) => ({ ...item, bytes: new TextEncoder().encode(item.wire) }));
  if (wires[0].bytes.length !== 1048576 || wires[1].bytes.length > 1048576)
    throw Error(
      "The synthetic provider envelopes do not match transport admission",
    );
  const readProvider = async (wire: Uint8Array) => {
    const provider = new FreeModelProvider(
      {
        provider: "qwen_free",
        model: "synthetic-model",
        projectRef: "synthetic-project",
        key: "synthetic-placeholder",
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < wire.length; i += 4096)
                controller.enqueue(wire.slice(i, i + 4096));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const value = await provider.generate(
      "draft_section",
      "Synthetic offline boundary fixture",
      {},
    );
    if (!value.complete)
      throw Error("Synthetic bounded transport result is incomplete");
    return validateModelResult("draft_section", JSON.parse(value.text), []);
  };
  let oversizedRejected = false;
  try {
    await readProvider(new TextEncoder().encode(wires[0].wire + " "));
  } catch (error) {
    oversizedRejected =
      (error as { code?: string }).code === "MODEL_OUTPUT_TOO_LARGE";
  }
  if (!oversizedRejected)
    throw Error("Actual transport accepted more than1MiB");
  const cases: Record<string, unknown>[] = [];
  for (const [jobIndex, expired] of [false, false, true].entries()) {
    const jobId = id(10 + jobIndex * 100),
      leaseId = id(11 + jobIndex * 100),
      issuanceId = id(12 + jobIndex * 100);
    const accepted = Date.now(),
      started = performance.now();
    const leaseUntil = new Date(accepted + 180_000).toISOString();
    const deadlineAt = new Date(
      accepted + (expired ? 100 : 600_000),
    ).toISOString();
    const snapshot = {
      id: id(1 + jobIndex * 100),
      ordinal: 1,
      created_at: new Date(accepted).toISOString(),
      payload: {
        version: 1,
        title: "Synthetic native worker capacity proof",
        language: original.language,
        template: {},
        separate_volumes: true,
        input_state: "available",
        content_state: "source_draft",
        assurance_state: "unreviewed",
        substantive_complete: false,
        approval_state: "draft",
        notice:
          "Synthetic structural fixture; source and response review remain required.",
        source_manifest: [],
        input_materials: {},
        gaps: [],
        sections: [
          {
            section_key: "capacity",
            title: "Synthetic capacity source",
            volume: "shared",
            kind: "source_extract",
            content_blocks: content,
            source_ids: [],
            provenance: null,
          },
        ],
      },
    };
    const artifacts = ["technical", "financial"].map((volume, index) => ({
      id: id(index + 2 + jobIndex * 100),
      volume,
      snapshot_id: snapshot.id,
      storage_key: `synthetic/job-${jobIndex}/${expired ? "expired" : "active"}/${volume}.docx`,
      status: "pending",
      write_state: "unstarted",
      content_hash: null,
      expected_size: null,
    }));
    const objects = new Map<string, Blob>();
    const intents = new Map<string, { hash: string; size: number }>();
    const rpc: { name: string; elapsed_ms: number }[] = [];
    let stores = 0,
      reads = 0,
      complete = 0,
      failure: string | null = null;
    const active = () => {
      if (Date.now() >= Date.parse(deadlineAt))
        throw new AppError(
          409,
          "PROPOSAL_ISSUANCE_TIMEOUT",
          "Synthetic fixed deadline",
        );
      if (Date.now() >= Date.parse(leaseUntil))
        throw new AppError(409, "STALE_LEASE", "Synthetic fixed lease");
    };
    const backend = {
      async internal(name: string, args: Record<string, any>) {
        if (args.job_id !== jobId || args.lease !== leaseId)
          throw Error("Synthetic worker identity changed");
        rpc.push({ name, elapsed_ms: Math.round(performance.now() - started) });
        phase = name;
        await persistTelemetry();
        if (name === "fail_delivery_export") {
          failure = args.error_code;
          return {};
        }
        active();
        if (name === "delivery_export_context")
          return structuredClone({
            snapshot,
            artifacts,
            renderer_version: "1",
            server_now: new Date().toISOString(),
            lease_until: leaseUntil,
          });
        if (name === "proposal_issuance_job_state")
          return {
            id: issuanceId,
            outcome: "active",
            server_now: new Date().toISOString(),
            lease_until: leaseUntil,
            deadline_at: deadlineAt,
          };
        if (name === "begin_render_storage_write") {
          const send = !intents.has(args.storage_key);
          if (send)
            intents.set(args.storage_key, {
              hash: args.expected_hash,
              size: args.expected_size,
            });
          const artifact = artifacts.find(
            (item) => item.storage_key === args.storage_key,
          )!;
          artifact.write_state = "unknown";
          return { send, state: "unknown", intent_id: id(20 + intents.size) };
        }
        if (name === "complete_delivery_artifact") {
          const artifact = artifacts.find(
            (item) => item.id === args.artifact_id,
          )!;
          const intent = intents.get(artifact.storage_key);
          if (
            !intent ||
            intent.hash !== args.actual_hash ||
            intent.size !== args.actual_size
          )
            throw Error("Completion lacks the exact authorized storage write");
          Object.assign(artifact, {
            status: "ready",
            write_state: "observed",
            content_hash: args.actual_hash,
            expected_size: args.actual_size,
          });
          complete++;
          return {};
        }
        if (name === "finish_delivery_export") {
          if (
            complete !== 2 ||
            artifacts.some((item) => item.status !== "ready")
          )
            throw Error("Incomplete required volume set");
          return { processed: true };
        }
        throw Error(`Unexpected worker RPC: ${name}`);
      },
      async deliveryObject(path: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        phase = `read:${path}`;
        await persistTelemetry();
        reads++;
        return objects.get(path) ?? null;
      },
      async storeDeliveryObject(
        path: string,
        bytes: Uint8Array,
        _mime: string,
        signal?: AbortSignal,
      ) {
        signal?.throwIfAborted();
        phase = `write:${path}`;
        await persistTelemetry();
        active();
        if (!intents.has(path) || objects.has(path))
          throw Error("Unclaimed or duplicate upload");
        objects.set(path, new Blob([new Uint8Array(bytes)]));
        stores++;
        await runtime.writeFile(
          `/outputs/worker-${path.replaceAll("/", "-")}`,
          bytes,
        );
      },
    } as unknown as Backend;
    let healthRequests = 0,
      validations = 0,
      activeBackground = false;
    let backgroundError: unknown, heldValidation: unknown;
    let previousSample = performance.now(),
      maxSampleGap = 0;
    const memoryPeaks = {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      old_space_used: 0,
    };
    let oldSpaceAvailable = false;
    let currentSpaces: ReturnType<typeof getHeapSpaceStatistics> = [];
    let phase = "fixture_ready",
      writeTelemetry: Promise<void> | undefined;
    const sampleMemory = () => {
      const now = performance.now();
      maxSampleGap = Math.max(maxSampleGap, now - previousSample);
      previousSample = now;
      const memory = runtime.memoryUsage();
      for (const name of ["rss", "heapTotal", "heapUsed", "external"] as const)
        memoryPeaks[name] = Math.max(memoryPeaks[name], memory[name]);
      try {
        currentSpaces = getHeapSpaceStatistics();
        const old = currentSpaces.find(
          (space) => space.space_name === "old_space",
        );
        if (old) {
          oldSpaceAvailable = true;
          memoryPeaks.old_space_used = Math.max(
            memoryPeaks.old_space_used,
            old.space_used_size,
          );
        }
      } catch {
        /* Deno versions may not expose V8 space-specific telemetry. */
      }
    };
    const persistTelemetry = async () => {
      sampleMemory();
      const telemetry = {
        phase,
        elapsed_ms: Math.round(performance.now() - started),
        parent_memory: runtime.memoryUsage(),
        parent_memory_peaks: memoryPeaks,
        parent_v8_spaces: currentSpaces,
        parent_heap_size_limit_bytes: getHeapStatistics().heap_size_limit,
        rpc,
        stores,
        reads,
        complete,
        health_requests: healthRequests,
        validations,
      };
      const operation = (writeTelemetry ?? Promise.resolve()).then(() =>
        runtime.writeFile(
          `/outputs/worker-job-${jobIndex}-${expired ? "expired" : "active"}-telemetry.json`,
          new TextEncoder().encode(JSON.stringify(telemetry, null, 2)),
        ),
      );
      writeTelemetry = operation;
      await operation;
      if (writeTelemetry === operation) writeTelemetry = undefined;
    };
    const background = async () => {
      if (activeBackground || expired) return;
      activeBackground = true;
      try {
        const response = await health(
          new Request("https://synthetic.invalid/v1/health"),
        );
        if (response.status !== 200)
          throw Error("Health check failed during native rendering");
        await response.arrayBuffer();
        healthRequests++;
        heldValidation = await readProvider(
          wires[validations % wires.length].bytes,
        );
        validations++;
      } catch (error) {
        backgroundError = error;
      } finally {
        activeBackground = false;
      }
    };
    let backgroundTask: Promise<void> | undefined;
    const scheduleBackground = () => {
      if (!backgroundTask) {
        const task = background().finally(() => {
          if (backgroundTask === task) backgroundTask = undefined;
        });
        backgroundTask = task;
      }
      return backgroundTask;
    };
    sampleMemory();
    const sampleTimer = setInterval(sampleMemory, 250);
    const telemetryTimer = setInterval(() => void persistTelemetry(), 1000);
    const backgroundTimer = setInterval(() => void scheduleBackground(), 1000);
    let result;
    try {
      await scheduleBackground();
      result = await processDeliveryExport(
        backend,
        {
          id: jobId,
          lease_token: leaseId,
          checkpoint: { issuance_request_id: issuanceId },
        },
        async (model, signal) => {
          if ((await tableHash(model)) !== expectedTables)
            throw Error(
              "The actual worker projection changed or withheld an admitted table",
            );
          phase = `render_start:${model.volume}`;
          await persistTelemetry();
          const bytes = await renderDeliveryIsolated(
            model,
            undefined,
            30000,
            signal,
          );
          phase = `render_complete_verification_pending:${model.volume}`;
          await persistTelemetry();
          return bytes;
        },
      );
    } finally {
      clearInterval(sampleTimer);
      clearInterval(backgroundTimer);
      clearInterval(telemetryTimer);
      if (backgroundTask) await backgroundTask;
      sampleMemory();
      await persistTelemetry();
    }
    if (backgroundError) throw backgroundError;
    const elapsed = Math.round(performance.now() - started);
    if (expired) {
      if (
        failure !== "PROPOSAL_ISSUANCE_TIMEOUT" ||
        stores ||
        intents.size ||
        complete
      )
        throw Error("Expired worker produced storage side effects");
    } else if (
      !(result as { processed?: boolean }).processed ||
      failure ||
      stores !== 2 ||
      reads !== 4 ||
      elapsed >= 130_000
    )
      throw Error(
        "The real native two-volume worker exceeded its runtime or content contract: " +
          JSON.stringify({
            result,
            failure,
            stores,
            reads,
            complete,
            elapsed,
            memoryPeaks,
          }),
      );
    const postHealth = await health(
      new Request("https://synthetic.invalid/v1/health"),
    );
    if (postHealth.status !== 200)
      throw Error("Parent did not serve health after completion/expiry");
    await postHealth.arrayBuffer();
    cases.push({
      name: expired
        ? "worker-request-expiry"
        : `worker-job-${jobIndex}-two-required-dense-volumes`,
      outcome: expired
        ? "cancelled_without_storage"
        : "verified_worker_completed",
      code: failure,
      elapsed_ms: elapsed,
      accepted_at: new Date(accepted).toISOString(),
      lease_until: leaseUntil,
      deadline_at: deadlineAt,
      job_id: jobId,
      lease_token: leaseId,
      issuance_id: issuanceId,
      fixed_lease_ms: 180_000,
      fixed_issuance_ms: expired ? 100 : 600_000,
      runtime_acceptance_bound_ms: 130_000,
      table_input_hash: expectedTables,
      artifacts: structuredClone(artifacts),
      storage_puts: stores,
      storage_reads: reads,
      completed_volumes: complete,
      rpc,
      database_and_storage: "emulated; no hosted calls",
      post_completion_health_status: postHealth.status,
      concurrent_work: {
        health_requests: healthRequests,
        validated_results: validations,
        provider_envelopes: wires.map(({ name, bytes }) => ({
          name,
          wire_bytes: bytes.length,
        })),
        oversized_1MiB_plus_one_rejected: oversizedRejected,
        transport:
          "actual FreeModelProvider parser; local response stub; no provider call",
        held_current_result: !!heldValidation,
        maximum_inflight_results: 1,
      },
      parent_memory_peaks: memoryPeaks,
      parent_memory_at_completion: runtime.memoryUsage(),
      parent_v8_spaces_at_completion: currentSpaces,
      parent_heap_size_limit_bytes: getHeapStatistics().heap_size_limit,
      old_space_stats_available: oldSpaceAvailable,
      memory_sample_interval_ms: 250,
      maximum_sample_gap_ms: Math.round(maxSampleGap),
      model_calls: 0,
    });
  }
  return cases;
}
