import type { RenderModel } from "./export.ts";
import {
  acquireNativeDocxProcess,
  type RendererProcess,
} from "./deliveryRenderIsolation.ts";
import {
  acceptVerificationVerdict,
  DOCX_VERDICT_LIMIT,
  DOCX_FRAME_LIMIT,
  docxDigest,
  frameHeader,
  verificationFailure,
  verificationTimeout,
} from "./deliveryVerifyProtocol.ts";
import { AppError } from "./http.ts";

export function hasNativeVerifierRuntime() {
  return (
    typeof (globalThis as unknown as { Deno?: unknown }).Deno !== "undefined"
  );
}
function createVerifier(): RendererProcess {
  const runtime = (
    globalThis as unknown as {
      Deno: {
        env?: { get(name: string): string | undefined };
        Command: new (
          path: string,
          options: unknown,
        ) => { spawn(): RendererProcess };
      };
    }
  ).Deno;
  // The server service identity is deployment-owned, never a request/model field.
  // The worker has 640 MiB; other services use the smaller verifier budget.
  const oldSpace =
    runtime.env?.get("APP_RUNTIME_SERVICE") === "worker" ? 128 : 64;
  return new runtime.Command("/bin/deno", {
    args: [
      "run",
      "--no-prompt",
      `--v8-flags=--max-old-space-size=${oldSpace}`,
      "--cached-only",
      "--frozen",
      `--config=${new URL("../deno.json", import.meta.url).pathname}`,
      "--allow-read=/deno-dir",
      new URL("./deliveryVerify.process.ts", import.meta.url).pathname,
    ],
    clearEnv: true,
    env: { DENO_DIR: "/deno-dir" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw verificationFailure();
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
  return bytes;
}
/** Every runtime verification physically releases its inflater allocations when
 * this fixed child exits. Canonical caller cancellation/lease may end it earlier
 * than the existing 180-second worker-lease ceiling, including while queued. */
export async function verifyDeliveryIsolated(
  document: Uint8Array,
  model: RenderModel,
  signal?: AbortSignal,
  createProcess: () => RendererProcess = createVerifier,
  timeoutMs = 180_000,
): Promise<true> {
  const started = performance.now();
  signal?.throwIfAborted();
  if (!document.length || document.length > DOCX_FRAME_LIMIT)
    throw new AppError(
      413,
      "FILE_SIZE_INVALID",
      "The Word document is outside the supported size.",
    );
  // Preserve call-time input identity even if a caller mutates its objects while
  // waiting. No untrusted or historical receipt can bypass this proof.
  const modelJson = JSON.stringify(model),
    bytes = new Uint8Array(document);
  const queueBudget = timeoutMs - (performance.now() - started);
  if (queueBudget <= 0) throw verificationTimeout();
  const release = await acquireNativeDocxProcess(
    queueBudget,
    signal,
    verificationTimeout,
  );
  let child: RendererProcess | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* Already reaped. */
    }
  };
  try {
    signal?.throwIfAborted();
    const encoded = new TextEncoder().encode(modelJson),
      header = frameHeader(encoded.length, bytes.length);
    const expected = {
      model_hash: await docxDigest(encoded),
      document_hash: await docxDigest(bytes),
      size: bytes.length,
    };
    signal?.throwIfAborted();
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) throw verificationTimeout();
    child = createProcess();
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        stop();
        reject(signal?.reason ?? verificationTimeout());
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop();
        reject(verificationTimeout());
      }, remaining);
    });
    const write = (async () => {
      const writer = child!.stdin.getWriter();
      try {
        await writer.write(header);
        await writer.write(encoded);
        await writer.write(bytes);
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    })();
    const [, verdict, , status] = await Promise.race([
      Promise.all([
        write,
        readBounded(child.stdout, DOCX_VERDICT_LIMIT),
        readBounded(child.stderr, 65536),
        child.status,
      ]),
      cancelled,
      deadline,
    ]);
    signal?.throwIfAborted();
    return acceptVerificationVerdict(verdict, status.success, expected);
  } catch (error) {
    stop();
    if (signal?.aborted) throw signal.reason;
    throw error instanceof AppError ? error : verificationFailure();
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    await child?.status.catch(() => undefined);
    release();
  }
}
