import { createHash } from "node:crypto";
import { AppError, databaseError } from "./http.ts";

// Wire-frame bounds, not business/result-size quotas. Complete results are
// never truncated and may contain any number of fixed-size chunks.
const ERROR_BODY_LIMIT = 64 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
const CHUNK_BODY_LIMIT = 512 * 1024;
export const BATCH_CHUNK_BYTES = 256 * 1024;
const encoder = new TextEncoder();
type ResultDescriptor = {
  ordinal: number;
  byte_length: number;
  chunk_count: number;
  sha256: string;
};
type Manifest = {
  version: 1;
  receipt_id: string;
  result_count: number;
  chunk_bytes: number;
  results: ResultDescriptor[];
};
export interface BatchTransportOptions {
  url: string;
  publishableKey: string;
  token: string;
  commands: unknown[];
  idempotencyKey: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}
function unavailable(): AppError {
  // A mutation may have committed before its response was lost. Read failures
  // never authorize replay of that mutation, even for SQLSTATE 57014.
  return new AppError(
    503,
    "DATABASE_RESPONSE_UNAVAILABLE",
    "The database response could not be completed.",
    null,
    false,
  );
}
function rpcUrl(configured: string, rpc: string): URL {
  try {
    const base = new URL(configured.trim());
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error();
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const endpoint = new URL(`rest/v1/rpc/${rpc}`, base);
    if (endpoint.origin !== base.origin) throw new Error();
    return endpoint;
  } catch {
    throw new AppError(
      503,
      "SETUP_REQUIRED",
      "The database connection is not configured.",
      null,
      false,
    );
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function manifestFrom(value: unknown, expectedCount: number): Manifest {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "receipt_id",
      "result_count",
      "chunk_bytes",
      "results",
    ]) ||
    value.version !== 1 ||
    typeof value.receipt_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.receipt_id,
    ) ||
    expectedCount < 1 ||
    expectedCount > 100 ||
    value.result_count !== expectedCount ||
    value.chunk_bytes !== BATCH_CHUNK_BYTES ||
    !Array.isArray(value.results) ||
    value.results.length !== expectedCount
  )
    throw unavailable();
  for (const [ordinal, result] of value.results.entries()) {
    if (
      !record(result) ||
      !exactKeys(result, ["ordinal", "byte_length", "chunk_count", "sha256"]) ||
      result.ordinal !== ordinal ||
      !positive(result.byte_length) ||
      !positive(result.chunk_count) ||
      result.chunk_count !==
        Math.ceil(result.byte_length / BATCH_CHUNK_BYTES) ||
      !digest(result.sha256)
    )
      throw unavailable();
  }
  return value as Manifest;
}
function chunkFrom(
  value: unknown,
  manifest: Manifest,
  result: ResultDescriptor,
  index: number,
): Uint8Array {
  const size = Math.min(
    BATCH_CHUNK_BYTES,
    result.byte_length - index * BATCH_CHUNK_BYTES,
  );
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "receipt_id",
      "result_ordinal",
      "chunk_index",
      "byte_length",
      "sha256",
      "data_base64",
    ]) ||
    value.version !== 1 ||
    value.receipt_id !== manifest.receipt_id ||
    value.result_ordinal !== result.ordinal ||
    value.chunk_index !== index ||
    value.byte_length !== size ||
    !digest(value.sha256) ||
    typeof value.data_base64 !== "string" ||
    value.data_base64.length !== 4 * Math.ceil(size / 3)
  )
    throw unavailable();
  // PostgreSQL encode(bytea,'base64') inserts LF; the versioned SQL contract
  // removes separators. Reject whitespace and alternate encodings here.
  const base64 = value.data_base64,
    padding = (3 - (size % 3)) % 3;
  for (let i = 0; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    const valid =
      i >= base64.length - padding
        ? code === 61
        : (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) ||
          code === 43 ||
          code === 47;
    if (!valid) throw unavailable();
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw unavailable();
  }
  if (binary.length !== size || btoa(binary) !== base64) throw unavailable();
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (createHash("sha256").update(bytes).digest("hex") !== value.sha256)
    throw unavailable();
  return bytes;
}

/** One atomic mutation followed by authenticated immutable chunk reads.
 * Neither API nor PostgREST constructs the aggregate result. No retries. */
export async function postgrestBatchBody(
  options: BatchTransportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const prepareUrl = rpcUrl(options.url, "app_batch_prepare"),
    chunkUrl = rpcUrl(options.url, "app_batch_result_chunk");
  const abort = new AbortController(),
    fetcher = options.fetch ?? fetch;
  let current: Promise<unknown> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readerCancellation: Promise<void> | undefined,
    cancellation: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const detach = () => options.signal.removeEventListener("abort", onAbort);
  const cancelReader = () => {
    if (!reader) return Promise.resolve();
    const source = reader;
    return (readerCancellation ??= source
      .cancel()
      .catch(() => {})
      .finally(() => source.releaseLock()));
  };
  const stop = () =>
    (cancellation ??= (async () => {
      abort.abort();
      await cancelReader();
      // A fetch may ignore cancellation and resolve late. Its finally owns that
      // late body; retain admission until that body has been canceled.
      await current?.catch(() => {});
    })());
  const onAbort = () => {
    if (finished) return;
    finished = true;
    detach();
    void stop().then(() => output?.error(unavailable()));
  };
  const rpc = async (
    url: URL,
    payload: unknown,
    limit: number,
    mutation: boolean,
  ) => {
    const task = (async () => {
      if (options.signal.aborted || abort.signal.aborted) throw unavailable();
      try {
        const response = await fetcher(url, {
          method: "POST",
          redirect: "error",
          signal: abort.signal,
          headers: {
            apikey: options.publishableKey,
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "content-profile": "public",
            accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
        reader = response.body?.getReader();
        readerCancellation = undefined;
        if (
          options.signal.aborted ||
          abort.signal.aborted ||
          !reader ||
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            .trim()
            .toLowerCase() !== "application/json"
        )
          throw unavailable();
        const bound = response.ok ? limit : ERROR_BODY_LIMIT;
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > bound)
        )
          throw unavailable();
        const bytes = new Uint8Array(bound);
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (options.signal.aborted || abort.signal.aborted)
            throw unavailable();
          if (next.done) break;
          if (next.value.byteLength > bound - size) throw unavailable();
          bytes.set(next.value, size);
          size += next.value.byteLength;
        }
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(0, size),
            ),
          );
        } catch {
          throw unavailable();
        }
        if (!response.ok) {
          if (!mutation || !record(value) || typeof value.message !== "string")
            throw unavailable();
          throw databaseError({
            message: value.message,
            code: typeof value.code === "string" ? value.code : undefined,
            details:
              typeof value.details === "string" ? value.details : undefined,
          });
        }
        return value;
      } finally {
        await cancelReader();
        reader = undefined;
        readerCancellation = undefined;
      }
    })();
    current = task;
    try {
      return await task;
    } finally {
      current = undefined;
    }
  };
  if (options.signal.aborted || abort.signal.aborted) throw unavailable();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const manifest = manifestFrom(
      await rpc(
        prepareUrl,
        { commands: options.commands, idempotency_key: options.idempotencyKey },
        MANIFEST_LIMIT,
        true,
      ),
      options.commands.length,
    );
    if (options.signal.aborted || abort.signal.aborted) throw unavailable();
    let stage: "open" | "chunk" | "comma" | "close" = "open";
    let ordinal = 0,
      index = 0,
      resultHash = createHash("sha256");
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        async pull(controller) {
          try {
            if (finished) return;
            if (stage === "open" || stage === "comma") {
              controller.enqueue(encoder.encode(stage === "open" ? "[" : ","));
              stage = "chunk";
              return;
            }
            if (stage === "close") {
              finished = true;
              detach();
              controller.enqueue(encoder.encode("]"));
              controller.close();
              return;
            }
            const result = manifest.results[ordinal];
            const value = await rpc(
              chunkUrl,
              {
                receipt_id: manifest.receipt_id,
                result_ordinal: ordinal,
                chunk_index: index,
              },
              CHUNK_BODY_LIMIT,
              false,
            );
            if (finished || options.signal.aborted) return;
            const bytes = chunkFrom(value, manifest, result, index);
            resultHash.update(bytes);
            index++;
            if (index === result.chunk_count) {
              if (resultHash.digest("hex") !== result.sha256)
                throw unavailable();
              ordinal++;
              index = 0;
              resultHash = createHash("sha256");
              stage = ordinal === manifest.result_count ? "close" : "comma";
            }
            controller.enqueue(bytes);
          } catch {
            if (finished) return;
            finished = true;
            detach();
            await stop();
            controller.error(unavailable());
          }
        },
        async cancel() {
          if (finished) return cancellation;
          finished = true;
          detach();
          await stop();
        },
      },
      { highWaterMark: 0 },
    );
  } catch (error) {
    finished = true;
    detach();
    await stop();
    throw error instanceof AppError ? error : unavailable();
  }
}

/** Preserve the API envelope without another copy of the complete result. */
export function batchEnvelopeResponse(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  headers: Headers,
): Response {
  const reader = body.getReader();
  let prefix = true;
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () =>
    (cancellation ??= reader
      .cancel()
      .catch(() => {})
      .finally(() => reader.releaseLock()));
  const responseBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (prefix) {
            prefix = false;
            controller.enqueue(encoder.encode('{"data":'));
            return;
          }
          const { value, done } = await reader.read();
          if (finished) return;
          if (done) {
            finished = true;
            reader.releaseLock();
            controller.enqueue(
              encoder.encode(
                `,"meta":${JSON.stringify({ request_id: requestId })}}`,
              ),
            );
            controller.close();
          } else controller.enqueue(value);
        } catch {
          if (finished) return;
          finished = true;
          await cancel();
          controller.error(unavailable());
        }
      },
      async cancel() {
        if (finished) return cancellation;
        finished = true;
        await cancel();
      },
    },
    { highWaterMark: 0 },
  );
  // Headers come from corsHeaders, never from the upstream response. In
  // particular, its Content-Length does not describe the added JSON envelope.
  return new Response(responseBody, { status: 200, headers });
}
