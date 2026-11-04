// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  batchEnvelopeResponse,
  postgrestBatchBody,
  type BatchTransportOptions,
} from "../../supabase/functions/_shared/batchTransport.ts";
import { HeavyFileAdmission } from "../../supabase/functions/api/heavyFileAdmission.ts";
import { corsHeaders } from "../../supabase/functions/_shared/http.ts";
import {
  batchWire,
  batchChunkBytes,
  batchReceipt,
} from "./fixtures/batchWire.ts";

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const settings = {
  url: "https://synthetic.invalid/gateway/",
  publishableKey: "synthetic-key",
  token: "synthetic-caller-jwt",
  idempotencyKey: "same-operation",
};
const unavailable = {
  code: "DATABASE_RESPONSE_UNAVAILABLE",
  retryable: false,
  details: null,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(raw = ['{"revision":2,"text":"عربي"}', "null"]) {
  const wire = batchWire(raw);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/app_batch_prepare")) return json(wire.manifest);
    const request = JSON.parse(init!.body as string);
    return json(wire.chunk(request.result_ordinal, request.chunk_index));
  });
  const options = {
    ...settings,
    commands: raw.map((_, index) => ({
      operation: "synthetic",
      input: { index },
    })),
    signal: new AbortController().signal,
    fetch: fetcher,
  };
  return {
    ...wire,
    raw,
    fetcher,
    options,
    start: (overrides: Partial<BatchTransportOptions> = {}) =>
      postgrestBatchBody({ ...options, ...overrides }),
  };
}

it.each([
  "https://synthetic.invalid",
  "http://private-gateway:8000/",
  "https://synthetic.invalid/gateway",
])(
  "uses fixed locally configured RPCs and caller authority: %s",
  async (url) => {
    const f = fixture();
    const body = await f.start({ url });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await new Response(body).json()).toEqual(
      f.raw.map((value) => JSON.parse(value)),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const prefix = url.replace(/\/$/, "");
    for (const [index, [endpoint, init]] of f.fetcher.mock.calls.entries()) {
      expect(String(endpoint)).toBe(
        `${prefix}/rest/v1/rpc/${index === 0 ? "app_batch_prepare" : "app_batch_result_chunk"}`,
      );
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      expect(Object.fromEntries(new Headers(init!.headers))).toEqual({
        accept: "application/json",
        apikey: settings.publishableKey,
        authorization: `Bearer ${settings.token}`,
        "content-type": "application/json",
        "content-profile": "public",
      });
    }
    expect(JSON.parse(f.fetcher.mock.calls[0][1]!.body as string)).toEqual({
      commands: f.options.commands,
      idempotency_key: settings.idempotencyKey,
    });
  },
);
it.each([
  "https://synthetic.invalid/?other=1",
  "https://synthetic.invalid/#other",
  "https://user:secret@synthetic.invalid",
  "file:///tmp/database",
  "//other.invalid",
])("rejects configured URL ambiguity before fetch: %s", async (url) => {
  const f = fixture();
  await expect(f.start({ url })).rejects.toMatchObject({
    code: "SETUP_REQUIRED",
    retryable: false,
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("preserves exact result bytes, scalar/null/types, escaped text and split UTF-8 with the existing envelope", async () => {
  // The Arabic character's second UTF-8 byte crosses the fixed chunk boundary.
  const long = '"' + "Z".repeat(batchChunkBytes - 2) + 'ب\\n\\"\\\\tail"';
  const raw = [
    long,
    '{ "zero":0, "required":false, "nullable":null }',
    "null",
    "true",
    "123.4500",
    '"آخر"',
  ];
  const f = fixture(raw),
    headers = corsHeaders(
      new Request("https://api.invalid", {
        headers: { origin: "https://client.invalid" },
      }),
      ["https://client.invalid"],
    );
  const response = batchEnvelopeResponse(await f.start(), 'id"عربي', headers);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://client.invalid",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("content-length")).toBe(false);
  const text = await response.text();
  expect(text).toBe(
    `{"data":[${raw.join(",")}],"meta":${JSON.stringify({ request_id: 'id"عربي' })}}`,
  );
  expect(JSON.parse(text).data).toEqual(raw.map((value) => JSON.parse(value)));
  expect(f.fetcher).toHaveBeenCalledTimes(
    1 + f.manifest.results.reduce((n, result) => n + result.chunk_count, 0),
  );
});
it("starts no chunk read before demand and never prefetches a paused result", async () => {
  const f = fixture(['"' + "a".repeat(batchChunkBytes) + '"', "false"]);
  const body = await f.start(),
    reader = body.getReader();
  await tick();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(decoder.decode((await reader.read()).value)).toBe("[");
  await tick();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect((await reader.read()).value!.length).toBe(batchChunkBytes);
  await tick();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  await reader.cancel();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  [
    "version",
    (m: any) => {
      m.version = 2;
    },
  ],
  [
    "foreign count",
    (m: any) => {
      m.result_count = 1;
    },
  ],
  [
    "missing result",
    (m: any) => {
      m.results.pop();
    },
  ],
  [
    "reversed ordinal",
    (m: any) => {
      m.results[0].ordinal = 1;
    },
  ],
  [
    "negative length",
    (m: any) => {
      m.results[0].byte_length = -1;
    },
  ],
  [
    "unsafe length",
    (m: any) => {
      m.results[0].byte_length = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "extra chunk",
    (m: any) => {
      m.results[0].chunk_count++;
    },
  ],
  [
    "zero chunks",
    (m: any) => {
      m.results[0].chunk_count = 0;
    },
  ],
  [
    "invalid hash",
    (m: any) => {
      m.results[0].sha256 = "bad";
    },
  ],
  [
    "foreign URL",
    (m: any) => {
      m.url = "https://other.invalid";
    },
  ],
  [
    "frame size",
    (m: any) => {
      m.chunk_bytes = 1;
    },
  ],
  [
    "invalid receipt",
    (m: any) => {
      m.receipt_id = "other/path";
    },
  ],
])(
  "rejects a malformed manifest before result reads: %s",
  async (_, mutate) => {
    const f = fixture();
    mutate(f.manifest);
    await expect(f.start()).rejects.toMatchObject(unavailable);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [
    "foreign receipt",
    (c: any) => {
      c.receipt_id = "aaebfb9a-5633-48e0-b08a-ce889cb25d1a";
    },
  ],
  [
    "wrong ordinal",
    (c: any) => {
      c.result_ordinal++;
    },
  ],
  [
    "duplicate index",
    (c: any) => {
      c.chunk_index++;
    },
  ],
  [
    "length",
    (c: any) => {
      c.byte_length--;
    },
  ],
  [
    "digest",
    (c: any) => {
      c.sha256 = "0".repeat(64);
    },
  ],
  [
    "missing bytes",
    (c: any) => {
      c.data_base64 = "";
    },
  ],
  [
    "base64 LF",
    (c: any) => {
      c.data_base64 = "\n" + c.data_base64.slice(1);
    },
  ],
  [
    "base64 alphabet",
    (c: any) => {
      c.data_base64 = "!" + c.data_base64.slice(1);
    },
  ],
  [
    "unknown field",
    (c: any) => {
      c.extra = true;
    },
  ],
])(
  "rejects corrupt chunk framing without closing a success envelope: %s",
  async (_, mutate) => {
    const f = fixture();
    f.fetcher
      .mockImplementationOnce(async () => json(f.manifest))
      .mockImplementationOnce(async () => {
        const c = f.chunk(0, 0);
        mutate(c);
        return json(c);
      });
    const response = batchEnvelopeResponse(
      await f.start(),
      "id",
      new Headers(),
    );
    await expect(response.text()).rejects.toMatchObject(unavailable);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  },
);
it("rejects noncanonical base64 padding bits even when decoded bytes/hash match", async () => {
  const f = fixture(["0"]);
  const c = f.chunk(0, 0);
  expect(c.data_base64).toBe("MA==");
  c.data_base64 = "MB==";
  f.fetcher
    .mockImplementationOnce(async () => json(f.manifest))
    .mockImplementationOnce(async () => json(c));
  await expect(new Response(await f.start()).text()).rejects.toMatchObject(
    unavailable,
  );
});
it("checks the independent whole-result hash before another result/completion", async () => {
  const f = fixture(['"' + "a".repeat(batchChunkBytes) + '"', "null"]);
  f.manifest.results[0].sha256 = "0".repeat(64);
  const reader = (await f.start()).getReader();
  await reader.read();
  await reader.read();
  await expect(reader.read()).rejects.toMatchObject(unavailable);
  expect(f.fetcher).toHaveBeenCalledTimes(3); // prepare + exactly two chunks, no next result.
});
it.each(["manifest", "chunk", "error"])(
  "bounds %s response bytes before parsing",
  async (stage) => {
    const f = fixture();
    const oversized = new Response(
      " ".repeat(stage === "chunk" ? 524289 : 65537),
      {
        status: stage === "error" ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    );
    if (stage === "chunk") {
      f.fetcher
        .mockImplementationOnce(async () => json(f.manifest))
        .mockImplementationOnce(async () => oversized);
      await expect(new Response(await f.start()).text()).rejects.toMatchObject(
        unavailable,
      );
    } else {
      f.fetcher.mockImplementationOnce(async () => oversized);
      await expect(f.start()).rejects.toMatchObject(unavailable);
    }
  },
);
it.each(["text/html", "application/json-bad", ""])(
  "rejects unexpected upstream content type: %s",
  async (type) => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(
      async () => new Response("{}", { headers: { "content-type": type } }),
    );
    await expect(f.start()).rejects.toMatchObject(unavailable);
  },
);
it("retains known mutation errors, but never retries read-time SQL57014 after commit", async () => {
  const failed = fixture();
  failed.fetcher.mockImplementationOnce(async () =>
    json({ message: "REVISION_CONFLICT", code: "P0001" }, 400),
  );
  await expect(failed.start()).rejects.toMatchObject({
    code: "REVISION_CONFLICT",
  });
  expect(failed.fetcher).toHaveBeenCalledOnce();
  const committed = fixture();
  committed.fetcher
    .mockImplementationOnce(async () => json(committed.manifest))
    .mockImplementationOnce(async () =>
      json(
        {
          message: "canceling statement due to statement timeout",
          code: "57014",
        },
        500,
      ),
    );
  await expect(
    new Response(await committed.start()).text(),
  ).rejects.toMatchObject(unavailable);
  expect(committed.fetcher).toHaveBeenCalledTimes(2);
});
it.each(["before headers", "during body"])(
  "treats an ambiguous mutation failure %s as nonretryable",
  async (stage) => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => {
      if (stage === "before headers")
        throw new Error("private gateway/token diagnostic");
      return new Response(
        new ReadableStream({
          pull(c) {
            c.error(new Error("private"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    await expect(f.start()).rejects.toMatchObject(unavailable);
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);
it("does not fetch for an already-aborted caller", async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(f.start({ signal: abort.signal })).rejects.toMatchObject(
    unavailable,
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["request", "consumer"])(
  "holds admission until %s cancellation settles an active chunk source",
  async (kind) => {
    const f = fixture(),
      abort = new AbortController(),
      stopped = deferred<void>();
    const cancel = vi.fn(() => stopped.promise);
    f.fetcher
      .mockImplementationOnce(async () => json(f.manifest))
      .mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
            { headers: { "content-type": "application/json" } },
          ),
      );
    const admission = new HeavyFileAdmission(),
      permit = admission.acquire(abort.signal);
    const response = permit.retainThrough(
      batchEnvelopeResponse(
        await f.start({ signal: abort.signal }),
        "id",
        new Headers(),
      ),
    );
    permit.finishWork();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    const pending = reader.read().catch(() => undefined);
    await tick();
    let settled = false;
    const completion =
      kind === "request" ? (abort.abort(), pending) : reader.cancel();
    void completion.then(() => {
      settled = true;
    });
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
    // Request abort is visible immediately, but admission still waits.
    if (kind === "consumer") expect(settled).toBe(false);
    expect(() => admission.acquire(new AbortController().signal)).toThrow(
      expect.objectContaining({ code: "FILE_PROCESSING_BUSY" }),
    );
    stopped.resolve();
    await completion;
    await tick();
    admission.acquire(new AbortController().signal).finishWork();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  },
);
it("waits for a noncooperative fetch and cancels its late body before releasing", async () => {
  const f = fixture(),
    response = deferred<Response>(),
    stopped = deferred<void>();
  const cancel = vi.fn(() => stopped.promise),
    pull = vi.fn();
  f.fetcher
    .mockImplementationOnce(async () => json(f.manifest))
    .mockImplementationOnce(() => response.promise);
  const reader = (await f.start()).getReader();
  await reader.read();
  const pending = reader.read();
  await tick();
  let complete = false;
  const cancellation = reader.cancel().then(() => {
    complete = true;
  });
  await tick();
  expect(complete).toBe(false);
  response.resolve(
    new Response(
      new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await tick();
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(complete).toBe(false);
  stopped.resolve();
  await cancellation;
  await pending;
  expect(complete).toBe(true);
});
it("cancels between chunks without requesting the next one", async () => {
  const f = fixture(['"' + "a".repeat(batchChunkBytes) + '"']);
  const reader = (await f.start()).getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it("returns every result at the existing 100-command boundary without an aggregate result allocation", async () => {
  const raw = Array.from({ length: 100 }, (_, index) =>
    JSON.stringify({
      ordinal: index,
      value: index === 0 ? null : index,
      flag: index % 2 === 0,
    }),
  );
  const f = fixture(raw);
  expect(await new Response(await f.start()).text()).toBe(`[${raw.join(",")}]`);
  expect(f.fetcher).toHaveBeenCalledTimes(101);
  expect(
    f.fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/app_batch_prepare"),
    ),
  ).toHaveLength(1);
});
it.each(["null", "[]", "false", "broken JSON"])(
  "rejects invalid manifest root %s without result reads",
  async (value) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(value, { headers: { "content-type": "application/json" } }),
    );
    await expect(f.start()).rejects.toMatchObject(unavailable);
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);
it("rejects invalid UTF-8 before JSON parsing", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(
    new Response(Uint8Array.of(0xff), {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(f.start()).rejects.toMatchObject(unavailable);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("does not finish an envelope when an earlier chunk is repeated in place of the last chunk", async () => {
  const f = fixture(['"' + "a".repeat(batchChunkBytes) + '"']);
  f.fetcher
    .mockResolvedValueOnce(json(f.manifest))
    .mockResolvedValueOnce(json(f.chunk(0, 0)))
    .mockResolvedValueOnce(json(f.chunk(0, 0)));
  const reader = batchEnvelopeResponse(
    await f.start(),
    "id",
    new Headers(),
  ).body!.getReader();
  const prefix: string[] = [];
  prefix.push(decoder.decode((await reader.read()).value));
  prefix.push(decoder.decode((await reader.read()).value));
  prefix.push(decoder.decode((await reader.read()).value));
  await expect(reader.read()).rejects.toMatchObject(unavailable);
  expect(prefix.join("")).not.toContain('"meta"');
  expect(prefix.join("")).not.toContain("]}");
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it("awaits a late mutation response and its cancellation after request abort without retry", async () => {
  const f = fixture(),
    response = deferred<Response>(),
    stopped = deferred<void>(),
    abort = new AbortController();
  const cancel = vi.fn(() => stopped.promise),
    pull = vi.fn();
  f.fetcher.mockImplementationOnce(() => response.promise);
  let settled = false;
  const pending = f.start({ signal: abort.signal }).catch((error) => {
    settled = true;
    return error;
  });
  abort.abort();
  await tick();
  expect(settled).toBe(false);
  response.resolve(
    new Response(
      new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await tick();
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  stopped.resolve();
  expect(await pending).toMatchObject(unavailable);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
