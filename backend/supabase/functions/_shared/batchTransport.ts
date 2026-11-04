import { AppError, databaseError } from "./http.ts";

// This bounds diagnostics only. Successful app_batch results have no transport
// size quota and are never decoded, parsed, or accumulated in this process.
const ERROR_BODY_LIMIT = 64 * 1024;
const encoder = new TextEncoder();

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
  // The transaction may have committed before a transport failure. Never retry
  // it automatically or expose URLs, credentials, or raw upstream diagnostics.
  return new AppError(
    503,
    "DATABASE_RESPONSE_UNAVAILABLE",
    "The database response could not be completed.",
    null,
    false,
  );
}

function batchUrl(configured: string): URL {
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
    // Match the pinned SDK's relative rest/v1 URL, including private gateway
    // path prefixes. No caller-controlled path or public API origin is used.
    const endpoint = new URL("rest/v1/rpc/app_batch", base);
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

/** One authenticated POST and one database transaction; no fetch retries. */
export async function postgrestBatchBody(
  options: BatchTransportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const url = batchUrl(options.url);
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let cancellation: Promise<void> | undefined;

  const detach = () => options.signal.removeEventListener("abort", onAbort);
  const cancelSource = () => {
    if (!cancellation) {
      abort.abort();
      const current = reader;
      cancellation = current
        ? current
            .cancel()
            .catch(() => {})
            .finally(() => current.releaseLock())
        : Promise.resolve();
    }
    return cancellation;
  };
  const onAbort = () => {
    if (finished) return;
    finished = true;
    detach();
    // Keep downstream completion (and its admission permit) pending until the
    // source acknowledges cancellation. Erroring first loses that promise.
    void cancelSource().then(() => output?.error(unavailable()));
  };

  if (options.signal.aborted) throw unavailable();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const fetcher = options.fetch ?? fetch;
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        apikey: options.publishableKey,
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "content-profile": "public",
        accept: "application/json",
      },
      body: JSON.stringify({
        commands: options.commands,
        idempotency_key: options.idempotencyKey,
      }),
      signal: abort.signal,
      redirect: "error",
    });
    reader = response.body?.getReader();
    // A fetch implementation may resolve after cancellation. Do not expose its
    // body, and cancel it even when the earlier abort had no reader yet.
    if (options.signal.aborted) {
      cancellation = undefined;
      throw unavailable();
    }
    if (!response.ok) {
      if (!reader) throw unavailable();
      const bytes = new Uint8Array(ERROR_BODY_LIMIT);
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (options.signal.aborted) throw unavailable();
        if (done) break;
        if (value.byteLength > ERROR_BODY_LIMIT - size) throw unavailable();
        bytes.set(value, size);
        size += value.byteLength;
      }
      let diagnostic: unknown;
      try {
        diagnostic = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        );
      } catch {
        throw unavailable();
      }
      if (
        !diagnostic ||
        typeof diagnostic !== "object" ||
        !("message" in diagnostic) ||
        typeof diagnostic.message !== "string"
      )
        throw unavailable();
      throw databaseError({
        message: diagnostic.message,
        code:
          "code" in diagnostic && typeof diagnostic.code === "string"
            ? diagnostic.code
            : undefined,
        details:
          "details" in diagnostic && typeof diagnostic.details === "string"
            ? diagnostic.details
            : undefined,
      });
    }
    if (
      !reader ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      throw unavailable();

    const source = reader;
    let received = false;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        async pull(controller) {
          try {
            const { done, value } = await source.read();
            if (finished) return;
            if (done) {
              if (!received) throw unavailable();
              finished = true;
              detach();
              source.releaseLock();
              controller.close();
            } else {
              received ||= value.byteLength > 0;
              controller.enqueue(value);
            }
          } catch {
            if (finished) return;
            finished = true;
            detach();
            await cancelSource();
            controller.error(unavailable());
          }
        },
        async cancel() {
          if (finished) return cancellation;
          finished = true;
          detach();
          await cancelSource();
        },
      },
      { highWaterMark: 0 },
    );
  } catch (error) {
    finished = true;
    detach();
    await cancelSource();
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
