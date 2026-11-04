import {
  renderDeliveryIsolated,
  type RendererProcess,
} from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import * as exportContract from "../../supabase/functions/_shared/export.ts";
import type { RenderModel } from "../../supabase/functions/_shared/export.ts";
// Match the runtime entrypoint's loaded application graph without starting its
// HTTP server, scheduler, database clients or any network call.
import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import { createWorkerHandler } from "../../supabase/functions/worker/handler.ts";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
const runtime = (
  globalThis as unknown as {
    Deno: {
      args: string[];
      version: { deno: string; v8: string };
      readTextFile(path: string): Promise<string>;
      writeFile(path: string, bytes: Uint8Array): Promise<void>;
      exit(code: number): never;
      Command: new (
        path: string,
        options: unknown,
      ) => { spawn(): RendererProcess };
    };
  }
).Deno;
const cases: Record<string, unknown>[] = [];
async function verifyArtifact(bytes: Uint8Array, model: RenderModel) {
  const verifier = (exportContract as unknown as { verifyExportDocxAsync?: (bytes: Uint8Array, model: RenderModel) => Promise<true> }).verifyExportDocxAsync;
  if (!verifier) throw Error("The actual asynchronous export verifier is required for this qualification");
  return await verifier(bytes, model);
}
const applicationGraphLoaded = [
  createApiHandler,
  createWorkerHandler,
  createBrowserGateway,
].every((value) => typeof value === "function");
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
async function run(name: string, model: RenderModel, required = true) {
  const start = performance.now(),
    input = new TextEncoder().encode(JSON.stringify(model));
  try {
    const bytes = await renderDeliveryIsolated(model);
    await verifyArtifact(bytes, model);
    cases.push({
      name,
      outcome: "verified",
      input_bytes: input.length,
      input_hash: await hash(input),
      artifact_bytes: bytes.length,
      artifact_hash: await hash(bytes),
      elapsed_ms: Math.round(performance.now() - start),
      required,
      model_calls: 0,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    cases.push({
      name,
      outcome: "bounded_error",
      code,
      input_bytes: input.length,
      input_hash: await hash(input),
      elapsed_ms: Math.round(performance.now() - start),
      required,
      released_artifacts: 0,
    });
    if (
      required ||
      ![
        "DELIVERY_RENDER_FAILED",
        "DELIVERY_RENDER_TIMEOUT",
        "DELIVERY_ARTIFACT_INVALID",
      ].includes(code ?? "")
    )
      throw error;
  }
}
const folder = runtime.args[0];
if (!folder) throw Error("Synthetic model directory is required");
if (
  [
    "final-capacity",
    "dense-heap-matrix",
    "streamed-capacity",
    "streamed-render-only",
    "concurrent-capacity",
    "density-edges",
    "density-render-only",
    "sparse-capacity",
    "sparse-render-only",
    "direction-capacity",
    "direction-render-only",
  ].includes(runtime.args[1])
) {
  const mode = runtime.args[1];
  let active = 0,
    maximumActive = 0;
  async function measure(name: string, heap: number, suffix = "") {
    const model = JSON.parse(
      await runtime.readTextFile(`${folder}/${name}.json`),
    ) as RenderModel;
    const input = new TextEncoder().encode(JSON.stringify(model));
    const start = performance.now();
    const diagnostic = {
      stderr_bytes: 0,
      v8_heap_exhausted: false,
      code: null as number | null,
      signal: null as string | null,
      kill_requested_by_guard: false,
      queue_wait_ms: null as number | null,
    };
    const create = () => {
      diagnostic.queue_wait_ms = Math.round(performance.now() - start);
      const child = new runtime.Command("/bin/deno", {
        args: [
          "run",
          "--no-prompt",
          `--v8-flags=--max-old-space-size=${heap}`,
          "--cached-only",
          "--frozen",
          "--config=/app/backend/supabase/functions/deno.json",
          "--allow-read=/app/frontend/public/fonts,/deno-dir",
          "/app/backend/supabase/functions/_shared/deliveryRender.process.ts",
        ],
        clearEnv: true,
        env: { DENO_DIR: "/deno-dir" },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      maximumActive = Math.max(maximumActive, ++active);
      let tail = "";
      const decoder = new TextDecoder();
      const stderr = child.stderr.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            diagnostic.stderr_bytes += chunk.length;
            const text = tail + decoder.decode(chunk, { stream: true });
            diagnostic.v8_heap_exhausted ||=
              /out of memory|heap limit|Allocation failed/iu.test(text);
            tail = text.slice(-100);
            controller.enqueue(chunk);
          },
        }),
      );
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr,
        status: child.status.then((status) => {
          active--;
          const details = status as {
            success: boolean;
            code?: number;
            signal?: string;
          };
          diagnostic.code = details.code ?? null;
          diagnostic.signal = details.signal ?? null;
          return status;
        }),
        kill(signal: "SIGKILL") {
          diagnostic.kill_requested_by_guard = true;
          child.kill(signal);
        },
      };
    };
    try {
      const bytes = await renderDeliveryIsolated(model, create);
      const renderedMs = Math.round(performance.now() - start);
      await runtime.writeFile(`/outputs/${name}-${heap}${suffix}.docx`, bytes);
      if (!mode.endsWith("render-only")) await verifyArtifact(bytes, model);
      cases.push({
        name: name + suffix,
        heap_mebibytes: heap,
        outcome: mode.endsWith("render-only")
          ? "rendered_pending_verification"
          : "verified",
        artifact_bytes: bytes.length,
        artifact_hash: await hash(bytes),
        input_hash: await hash(input),
        input_bytes: input.length,
        diagnostic,
        render_elapsed_ms: renderedMs,
        elapsed_ms: Math.round(performance.now() - start),
      });
    } catch (error) {
      cases.push({
        name: name + suffix,
        heap_mebibytes: heap,
        outcome: "bounded_error",
        code: (error as { code?: string }).code,
        input_hash: await hash(input),
        input_bytes: input.length,
        diagnostic,
        elapsed_ms: Math.round(performance.now() - start),
        released_artifacts: 0,
      });
    }
  }
  if (mode === "concurrent-capacity") {
    await Promise.all([
      measure("dense-short-authored", 128, "-parallel-a"),
      measure("dense-short-authored", 128, "-parallel-b"),
    ]);
    await Promise.all([
      measure("dense-body-limit-authored", 128, "-parallel-a"),
      measure("dense-body-limit-authored", 128, "-parallel-b"),
    ]);
    await measure(
      "dense-body-limit-authored",
      128,
      "-retry-after-queue-deadline",
    );
  } else {
    for (const name of mode === "final-capacity" ? ["dense-minimal-sparse-body-limit-authored","dense-direction-runs-authored","dense-ragged-authored","dense-empty-body-limit-authored","dense-paragraph-authored","dense-short-authored","dense-body-limit-authored"] : mode === "dense-heap-matrix"
      ? ["dense-authored"]
      : mode.startsWith("direction-") ? ["dense-direction-runs-authored"] : mode.startsWith("sparse-")
        ? ["dense-sparse-body-limit-authored"]
        : mode.startsWith("density-")
          ? ["dense-empty-body-limit-authored", "dense-paragraph-authored"]
          : ["dense-short-authored", "dense-body-limit-authored"])
      for (const heap of mode === "dense-heap-matrix" ? [128, 256, 384] : [128])
        await measure(name, heap);
  }
  console.log(
    JSON.stringify({
      scope: "offline actual Deno authenticated authoring payload capacity",
      mode,
      hosted_acceptance: false,
      production_slo_qualified: false,
      runtime: runtime.version,
      application_graph_loaded: applicationGraphLoaded,
      verifier: mode.endsWith("render-only") ? "not_run" : "verifyExportDocxAsync",
      attempt_timeout_ms: 30000,
      maximum_simultaneous_children: maximumActive,
      active_children_after: active,
      cases,
    }),
  );
  runtime.exit(0);
}
const models = await Promise.all(
  ["en-4000", "en-100000", "ar-1000000"].map(async (name) => ({
    name,
    model: JSON.parse(
      await runtime.readTextFile(`${folder}/${name}.json`),
    ) as RenderModel,
  })),
);
for (const item of models) await run(`serial-${item.name}`, item.model);
await Promise.all(
  models.slice(1).map((item) => run(`concurrent2-${item.name}`, item.model)),
);
// A deliberately dense, schema-shaped synthetic table workload. A bounded
// failure is recorded as a capacity finding, never as successful content output.
const dense: RenderModel = {
  ...models[0].model,
  id: "synthetic-dense-tables",
  blocks: [
    { type: "title", text: "Synthetic dense table capacity case" },
    ...Array.from({ length: 20 }, (_, table) => ({
      type: "table" as const,
      headers: Array.from({ length: 10 }, (_, col) => `Column ${col}`),
      rows: Array.from({ length: 50 }, (_, row) =>
        Array.from(
          { length: 10 },
          (_, col) =>
            `Cell ${table}/${row}/${col}: required acceptance evidence remains pending. مراجعة المصدر مطلوبة.`,
        ),
      ),
    })),
    {
      type: "placeholder",
      gap_id: "dense-review",
      text: "Required: source review remains pending",
    },
  ],
};
await run("adverse-20-tables-10000-cells", dense, false);
let spawned = 0;
try {
  await renderDeliveryIsolated(
    {
      ...models[0].model,
      blocks: [{ type: "paragraph", text: "S".repeat(10 * 1024 * 1024) }],
    },
    () => {
      spawned++;
      throw Error("Over-limit input must not start a process");
    },
  );
  throw Error("Over-limit input was accepted");
} catch (error) {
  if (
    (error as { code?: string }).code !== "DELIVERY_ARTIFACT_INVALID" ||
    spawned !== 0
  )
    throw error;
  cases.push({
    name: "over-10MiB-input",
    outcome: "rejected_before_process",
    code: "DELIVERY_ARTIFACT_INVALID",
    spawned,
    released_artifacts: 0,
  });
}
let killed = false;
const overflowStart = performance.now();
try {
  await renderDeliveryIsolated(models[0].model, () => {
    const child = new runtime.Command("/bin/deno", {
      args: [
        "eval",
        "const bytes=new Uint8Array(10485761);let n=0;while(n<bytes.length)n+=await Deno.stdout.write(bytes.subarray(n));await new Promise(()=>{});",
      ],
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      killed = true;
      kill(signal);
    };
    return child;
  });
  throw Error("Over-limit stdout was accepted");
} catch (error) {
  if (
    (error as { code?: string }).code !== "DELIVERY_ARTIFACT_INVALID" ||
    !killed
  )
    throw error;
  cases.push({
    name: "over-10MiB-child-output",
    outcome: "killed_and_reaped",
    code: "DELIVERY_ARTIFACT_INVALID",
    elapsed_ms: Math.round(performance.now() - overflowStart),
    released_artifacts: 0,
  });
}
// Failure did not poison the parent or leave the subsequent render unusable.
const controller = new AbortController();
const cancellationReason = new AppError(
  409,
  "PROPOSAL_ISSUANCE_TIMEOUT",
  "Synthetic request expiry",
);
let cancelledChild: RendererProcess | undefined;
const cancelAt = setTimeout(() => controller.abort(cancellationReason), 100);
const cancellationStart = performance.now();
try {
  await renderDeliveryIsolated(
    models[0].model,
    () => {
      cancelledChild = new runtime.Command("/bin/deno", {
        args: ["eval", "while(true){}"],
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      return cancelledChild;
    },
    30_000,
    controller.signal,
  );
  throw Error("Expired request continued rendering");
} catch (error) {
  if (
    error !== cancellationReason ||
    !cancelledChild ||
    (await cancelledChild.status).success
  )
    throw error;
  cases.push({
    name: "request-expiry-infinite-cpu",
    outcome: "killed_and_reaped",
    code: cancellationReason.code,
    elapsed_ms: Math.round(performance.now() - cancellationStart),
    released_artifacts: 0,
  });
} finally {
  clearTimeout(cancelAt);
}
await run("after-adverse-parent-liveness", models[0].model);
console.log(
  JSON.stringify({
    scope:
      "offline real Deno subprocess renderer, frozen synthetic API-generated models",
    hosted_acceptance: false,
    production_slo_qualified: false,
    runtime: runtime.version,
    application_graph_loaded: applicationGraphLoaded,
    verifier: "verifyExportDocxAsync",
    child_heap_mebibytes: 128,
    attempt_timeout_ms: 30000,
    input_and_output_limit_bytes: 10485760,
    cases,
  }),
);
