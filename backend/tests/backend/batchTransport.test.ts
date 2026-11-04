// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  batchEnvelopeResponse,
  postgrestBatchBody,
  type BatchTransportOptions,
} from "../../supabase/functions/_shared/batchTransport.ts";
import { corsHeaders } from "../../supabase/functions/_shared/http.ts";

// Synthetic protocol fixtures only: no Auth, database, Storage, or native
// renderer runs. The database transaction itself remains app_batch's contract.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const settings = {
  url: "https://synthetic.invalid/gateway/",
  publishableKey: "synthetic-publishable-key",
  token: "synthetic-caller-jwt",
  commands: [
    {
      operation: "export.renew",
      input: { id: "synthetic", expected_revision: 1 },
    },
    {
      operation: "export.renew",
      input: { id: "synthetic", expected_revision: 2 },
    },
  ],
  idempotencyKey: "synthetic-batch-key",
};

function upstream(chunks: Uint8Array[]) {
  let index = 0;
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
  );
  const cancel = vi.fn();
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  return { body, pull, cancel };
}

function fetchResponse(
  body: ReadableStream<Uint8Array>,
  status = 200,
  type = "application/json",
) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body, {
        status,
        headers: { "content-type": type },
      }),
  );
}

async function transport(
  fetcher: typeof fetch,
  overrides: Partial<BatchTransportOptions> = {},
) {
  return postgrestBatchBody({
    ...settings,
    signal: new AbortController().signal,
    fetch: fetcher,
    ...overrides,
  });
}

it.each([
  [
    "https://synthetic.invalid",
    "https://synthetic.invalid/rest/v1/rpc/app_batch",
  ],
  [
    "http://private-gateway:8000/",
    "http://private-gateway:8000/rest/v1/rpc/app_batch",
  ],
  [
    "https://synthetic.invalid/gateway",
    "https://synthetic.invalid/gateway/rest/v1/rpc/app_batch",
  ],
])(
  "uses the configured SDK-compatible URL and caller authority: %s",
  async (url, expected) => {
    const source = upstream([encoder.encode("[]")]);
    const fetcher = fetchResponse(source.body);
    const body = await transport(fetcher, { url });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetcher.mock.calls[0];
    expect(String(endpoint)).toBe(expected);
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    const headers = new Headers(request?.headers);
    expect(Object.fromEntries(headers)).toEqual({
      accept: "application/json",
      apikey: settings.publishableKey,
      authorization: `Bearer ${settings.token}`,
      "content-profile": "public",
      "content-type": "application/json",
    });
    expect(JSON.parse(request?.body as string)).toEqual({
      commands: settings.commands,
      idempotency_key: settings.idempotencyKey,
    });
    expect(await new Response(body).json()).toEqual([]);
    expect(source.body.locked).toBe(false);
  },
);

it.each([
  "https://synthetic.invalid/?route=other",
  "https://synthetic.invalid/#other",
  "https://credential:secret@synthetic.invalid/",
  "file:///tmp/database",
  "//unexpected.invalid/",
])("rejects ambiguous configured URLs without fetching: %s", async (url) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(transport(fetcher, { url })).rejects.toMatchObject({
    code: "SETUP_REQUIRED",
    retryable: false,
    details: null,
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves the complete raw JSON, split UTF-8, result order, metadata and CORS", async () => {
  const raw =
    '[{"revision":2,"snapshot":{"title":"عربي","text":"quote\\\" slash\\\\"}},null,{"revision":3}]';
  const bytes = encoder.encode(raw);
  const source = upstream(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  const body = await transport(fetchResponse(source.body));
  const headers = corsHeaders(
    new Request("https://api.invalid", {
      headers: { origin: "https://client.invalid" },
    }),
    ["https://client.invalid"],
  );
  const requestId = 'request"\\معرف';
  const response = batchEnvelopeResponse(body, requestId, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://client.invalid",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("content-length")).toBe(false);
  const text = await response.text();
  expect(text).toBe(
    `{"data":${raw},"meta":${JSON.stringify({ request_id: requestId })}}`,
  );
  expect(JSON.parse(text)).toEqual({
    data: JSON.parse(raw),
    meta: { request_id: requestId },
  });
  expect(source.body.locked).toBe(false);
  expect(source.cancel).not.toHaveBeenCalled();
});

it("does not read upstream before demand or prefetch while the consumer is paused", async () => {
  const source = upstream([
    encoder.encode("["),
    encoder.encode("1"),
    encoder.encode("]"),
  ]);
  const body = await transport(fetchResponse(source.body));
  const response = batchEnvelopeResponse(
    body,
    "synthetic-request",
    new Headers(),
  );
  await Promise.resolve();
  expect(source.pull).not.toHaveBeenCalled();
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toBe('{"data":');
  expect(source.pull).not.toHaveBeenCalled();
  expect(decoder.decode((await reader.read()).value)).toBe("[");
  await Promise.resolve();
  await Promise.resolve();
  expect(source.pull).toHaveBeenCalledTimes(1);
  await reader.cancel();
  expect(source.cancel).toHaveBeenCalledTimes(1);
  expect(source.body.locked).toBe(false);
  expect(body.locked).toBe(false);
});

it("streams an 8 MiB synthetic result without accumulating it or adding an output quota", async () => {
  const block = encoder.encode("a".repeat(64 * 1024));
  const count = 128;
  let index = -1;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === -1) controller.enqueue(encoder.encode('[{"snapshot":"'));
        else if (index < count) controller.enqueue(block);
        else if (index === count) controller.enqueue(encoder.encode('"}]'));
        else controller.close();
        index++;
      },
    },
    { highWaterMark: 0 },
  );
  const response = batchEnvelopeResponse(
    await transport(fetchResponse(source)),
    "large",
    new Headers(),
  );
  const expected = createHash("sha256").update('{"data":[{"snapshot":"');
  for (let i = 0; i < count; i++) expected.update(block);
  expected.update('"}],"meta":{"request_id":"large"}}');
  const actual = createHash("sha256");
  const reader = response.body!.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    expect(value.byteLength).toBeLessThanOrEqual(block.byteLength);
    actual.update(value);
    total += value.byteLength;
  }
  expect(total).toBeGreaterThan(8 * 1024 * 1024);
  expect(actual.digest("hex")).toBe(expected.digest("hex"));
  expect(source.locked).toBe(false);
});

it("passes bounded PostgREST diagnostics through databaseError", async () => {
  const source = upstream([
    encoder.encode(
      JSON.stringify({
        message: "STALE_REVISION",
        details: '{"expected_revision":4}',
        code: "P0001",
      }),
    ),
  ]);
  await expect(
    transport(fetchResponse(source.body, 400)),
  ).rejects.toMatchObject({
    status: 409,
    code: "STALE_REVISION",
    retryable: false,
    details: { expected_revision: 4 },
  });
  expect(source.body.locked).toBe(false);
});

it("preserves the existing retry metadata only for a proven database timeout", async () => {
  const source = upstream([
    encoder.encode(
      JSON.stringify({
        message: "canceling statement due to statement timeout",
        code: "57014",
      }),
    ),
  ]);
  const fetcher = fetchResponse(source.body, 500);
  await expect(transport(fetcher)).rejects.toMatchObject({
    status: 503,
    code: "DATABASE_TEMPORARY_FAILURE",
    retryable: true,
    details: { sqlstate: "57014" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["upstream secret SQL text", '{"message":42}', '{"message":"bad",'])(
  "sanitizes invalid error responses without retries: %s",
  async (message) => {
    const source = upstream([encoder.encode(message)]);
    const fetcher = fetchResponse(source.body, 502, "text/html");
    await expect(transport(fetcher)).rejects.toMatchObject({
      status: 503,
      code: "DATABASE_RESPONSE_UNAVAILABLE",
      retryable: false,
      details: null,
      message: "The database response could not be completed.",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  },
);

it("stops error diagnostics at 64 KiB and cancels the unread remainder", async () => {
  const block = encoder.encode("x".repeat(1024));
  const source = upstream(Array.from({ length: 1000 }, () => block));
  const fetcher = fetchResponse(source.body, 500);
  await expect(transport(fetcher)).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
    retryable: false,
    details: null,
  });
  expect(source.pull).toHaveBeenCalledTimes(65);
  expect(source.cancel).toHaveBeenCalledTimes(1);
  expect(source.body.locked).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["text/html", "text/plain", ""])(
  "rejects a non-JSON successful response before reading it: %s",
  async (type) => {
    const source = upstream([encoder.encode("secret non-json response")]);
    await expect(
      transport(fetchResponse(source.body, 200, type)),
    ).rejects.toMatchObject({
      code: "DATABASE_RESPONSE_UNAVAILABLE",
      retryable: false,
    });
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  },
);

it("rejects missing response bodies and fails an empty body without a success suffix", async () => {
  await expect(
    transport(vi.fn<typeof fetch>(async () => new Response(null))),
  ).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
    retryable: false,
  });
  const source = upstream([]);
  const response = batchEnvelopeResponse(
    await transport(fetchResponse(source.body)),
    "empty",
    new Headers(),
  );
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toBe('{"data":');
  await expect(reader.read()).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
  });
});

it("checks request abort before fetch", async () => {
  const abort = new AbortController();
  abort.abort();
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    transport(fetcher, { signal: abort.signal }),
  ).rejects.toMatchObject({ retryable: false });
  expect(fetcher).not.toHaveBeenCalled();
});

it("aborts fetch while awaiting headers without retrying or exposing its exception", async () => {
  const abort = new AbortController();
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private URL and credentials")),
          { once: true },
        );
      }),
  );
  const pending = transport(fetcher, { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
    retryable: false,
    message: "The database response could not be completed.",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("cancels a body arriving after the request was already aborted", async () => {
  const abort = new AbortController();
  const source = upstream([encoder.encode("[]")]);
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const pending = transport(fetcher, { signal: abort.signal });
  abort.abort();
  resolve(
    new Response(source.body, {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(pending).rejects.toMatchObject({ retryable: false });
  expect(source.pull).not.toHaveBeenCalled();
  expect(source.cancel).toHaveBeenCalledTimes(1);
  expect(source.body.locked).toBe(false);
});

it("keeps request abort attached after headers and while the client is paused", async () => {
  const abort = new AbortController();
  const source = upstream([encoder.encode("["), encoder.encode("]")]);
  const fetcher = fetchResponse(source.body);
  const body = await transport(fetcher, { signal: abort.signal });
  const response = batchEnvelopeResponse(body, "aborted", new Headers());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  abort.abort();
  await expect(reader.read()).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
    retryable: false,
  });
  expect(source.pull).toHaveBeenCalledTimes(1);
  expect(source.cancel).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(source.body.locked).toBe(false);
});

it("cancels a pending upstream read when the downstream reader cancels", async () => {
  let started!: () => void;
  const pulling = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pull = vi.fn(() => started());
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  const fetcher = fetchResponse(source);
  const body = await transport(fetcher);
  const response = batchEnvelopeResponse(body, "cancelled", new Headers());
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  await pulling;
  expect(pull).toHaveBeenCalledTimes(1);
  await reader.cancel();
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(source.locked).toBe(false);
  expect(body.locked).toBe(false);
});

it.each(["error", "cancel"] as const)(
  "keeps downstream %s pending until an aborted source finishes cancelling",
  async (ending) => {
    const abort = new AbortController();
    let finishCancel!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const source = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    const body = await transport(fetchResponse(source), {
      signal: abort.signal,
    });
    const response = batchEnvelopeResponse(
      body,
      "deferred-cancel",
      new Headers(),
    );
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    expect(cancel).toHaveBeenCalledTimes(1);
    let settled = false;
    const pending = (
      ending === "cancel" ? reader.cancel() : reader.read()
    ).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCancel();
    await pending;
    expect(settled).toBe(true);
    expect(source.locked).toBe(false);
    expect(body.locked).toBe(false);
  },
);

it("fails a partial upstream response without metadata, retry or raw diagnostics", async () => {
  let calls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (calls++ === 0)
          controller.enqueue(encoder.encode('[{"snapshot":"partial'));
        else controller.error(new Error("private upstream body failure"));
      },
    },
    { highWaterMark: 0 },
  );
  const fetcher = fetchResponse(source);
  const response = batchEnvelopeResponse(
    await transport(fetcher),
    "failed",
    new Headers(),
  );
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toBe('{"data":');
  expect(decoder.decode((await reader.read()).value)).toBe(
    '[{"snapshot":"partial',
  );
  await expect(reader.read()).rejects.toMatchObject({
    code: "DATABASE_RESPONSE_UNAVAILABLE",
    retryable: false,
    message: "The database response could not be completed.",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(source.locked).toBe(false);
});
