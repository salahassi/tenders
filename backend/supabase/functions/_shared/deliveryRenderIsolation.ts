import type { RenderModel } from "./export.ts";
import { AppError } from "./http.ts";

const BYTE_LIMIT = 10 * 1024 * 1024;
let rendererActive = false;
const waitingRenderers: Array<() => void> = [];
const timeoutError = () =>
  new AppError(
    503,
    "DELIVERY_RENDER_TIMEOUT",
    "The draft renderer exceeded this attempt's time limit.",
  );
/** HTTP invocations share one process. A single replica is not a child-count
 * limit: reserve one slot before allocating input or starting a subprocess.
 * FIFO waiting consumes the same attempt deadline and never spawns late work. */
const abortReason = (signal: AbortSignal) => signal.reason ?? timeoutError();
async function acquireRenderer(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw abortReason(signal);
  if (rendererActive)
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const remove = () => {
        const index = waitingRenderers.indexOf(admit);
        if (index >= 0) waitingRenderers.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        remove();
        reject(abortReason(signal!));
      };
      const timer = setTimeout(() => {
        remove();
        reject(timeoutError());
      }, timeoutMs);
      waitingRenderers.push(admit);
      signal?.addEventListener("abort", abort, { once: true });
    });
  else rendererActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingRenderers.shift();
    if (next) next();
    else rendererActive = false;
  };
}
export interface RendererProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<{ success: boolean }>;
  kill(signal: "SIGKILL"): void;
}
function createRendererProcess(): RendererProcess {
  const runtime = (
    globalThis as unknown as {
      Deno: {
        Command: new (
          executable: string,
          options: unknown,
        ) => { spawn(): RendererProcess };
      };
    }
  ).Deno;
  return new runtime.Command("/bin/deno", {
    args: [
      "run",
      "--no-prompt",
      "--v8-flags=--max-old-space-size=128",
      "--cached-only",
      "--frozen",
      `--config=${new URL("../deno.json", import.meta.url).pathname}`,
      "--allow-read=/app/frontend/public/fonts,/deno-dir",
      new URL("./deliveryRender.process.ts", import.meta.url).pathname,
    ],
    clearEnv: true,
    env: { DENO_DIR: "/deno-dir" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}
async function boundedRead(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw new AppError(
          422,
          "DELIVERY_ARTIFACT_INVALID",
          "The draft renderer exceeded its output limit.",
        );
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
/** A fixed, offline subprocess can be killed even when its JavaScript thread
 * never yields. Reap it before recording a retry; never return its stderr. */
export async function renderDeliveryIsolated(
  model: RenderModel,
  createProcess: () => RendererProcess = createRendererProcess,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const started = performance.now();
  const release = await acquireRenderer(timeoutMs, signal);
  try {
    if (signal?.aborted) throw abortReason(signal);
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) throw timeoutError();
    return await renderAdmitted(model, createProcess, remaining, signal);
  } finally {
    release();
  }
}

async function renderAdmitted(
  model: RenderModel,
  createProcess: () => RendererProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const input = new TextEncoder().encode(JSON.stringify(model));
  if (input.length > BYTE_LIMIT)
    throw new AppError(
      422,
      "DELIVERY_ARTIFACT_INVALID",
      "The draft render input exceeds the supported size.",
    );
  if (signal?.aborted) throw abortReason(signal);
  const child = createProcess();
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortListener = () => {
      stop();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop();
      reject(timeoutError());
    }, timeoutMs);
  });
  const inputWritten = (async () => {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(input);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  })();
  try {
    const [, bytes, , status] = await Promise.race([
      Promise.all([
        inputWritten,
        boundedRead(child.stdout, BYTE_LIMIT),
        boundedRead(child.stderr, 65536),
        child.status,
      ]),
      deadline,
      cancelled,
    ]);
    if (!status.success || !bytes.length)
      throw new AppError(
        503,
        "DELIVERY_RENDER_FAILED",
        "The draft renderer could not complete this attempt.",
      );
    return bytes;
  } catch (error) {
    stop();
    if (signal?.aborted) throw abortReason(signal);
    throw error instanceof AppError
      ? error
      : new AppError(
          503,
          "DELIVERY_RENDER_FAILED",
          "The draft renderer could not complete this attempt.",
        );
  } finally {
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    await child.status.catch(() => undefined);
  }
}
