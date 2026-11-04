// @vitest-environment node
import { batchWire } from "./fixtures/batchWire.ts";
import { expect, it, vi } from "vitest";
import { createApiHandler } from "../../supabase/functions/api/handler";
import { AppError } from "../../supabase/functions/_shared/http";
import { postgrestBatchBody } from "../../supabase/functions/_shared/batchTransport";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";

const actor = "00000000-0000-4000-8000-000000000001";
const artifact = "00000000-0000-4000-8000-000000000002";
const env: BackendEnvironment = {
  url: "https://example.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-private",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic-worker",
  models: modelEnvironments(() => undefined),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function request(
  path = `export-artifacts/${artifact}/download`,
  signal?: AbortSignal,
) {
  return new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
    headers: {
      origin: env.allowedOrigins[0],
      authorization: "Bearer synthetic-user",
    },
    signal,
  });
}
async function fixture() {
  const bytes = new TextEncoder().encode("Synthetic saved bytes");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const context = {
    artifact: {
      id: artifact,
      kind: "generated",
      status: "ready",
      storage_key: "synthetic/file",
      expected_size: bytes.length,
      content_hash: hash,
      mime_type: "application/octet-stream",
    },
    package: { id: actor, revision: 1 },
  };
  const backend = {
    authenticate: vi.fn(async () => ({ id: actor })),
    membership: vi.fn(async () => ({ workspace_id: actor, role: "Owner" })),
    userRpc: vi.fn(
      async (_token: string, _name: string, _args?: unknown): Promise<any> =>
        context,
    ),
    internal: vi.fn(async (_name: string, _args?: unknown): Promise<any> => ({
      authorized: true,
    })),
    deliveryObject: vi.fn(
      async (_key: string, _signal?: AbortSignal): Promise<Blob | null> =>
        new Blob([bytes]),
    ),
    object: vi.fn(
      async (_key: string, _signal?: AbortSignal): Promise<Blob> =>
        new Blob([bytes]),
    ),
    status: vi.fn(async () => ({ available: true })),
    list: vi.fn(async () => ({ records: [], next_cursor: null })),
    batchStream: vi.fn(
      async (
        _token: string,
        _commands: unknown[],
        _key: string,
        _signal: AbortSignal,
      ): Promise<ReadableStream<Uint8Array>> => new Response("[]").body!,
    ),
  };
  return {
    backend,
    bytes,
    context,
    handle: createApiHandler(env, () => backend as unknown as Backend),
  };
}

it("admits one authenticated heavy flow before context/blob reads and immediately rejects excess", async () => {
  const f = await fixture();
  const storage = deferred<Blob>(),
    entered = deferred<void>();
  f.backend.deliveryObject.mockImplementation(async () => {
    entered.resolve();
    return storage.promise;
  });
  const first = f.handle(request());
  await entered.promise;
  const second = f.handle(request()),
    third = f.handle(request());
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The old handler starts all three context/Blob loads. Ordinary saved
    // downloads do not enter a verifier FIFO; admission must protect this
    // actual handler boundary independently of native child limits.
    expect(f.backend.userRpc).toHaveBeenCalledTimes(1);
    expect(f.backend.deliveryObject).toHaveBeenCalledTimes(1);
    for (const pending of [second, third]) {
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "FILE_PROCESSING_BUSY", retryable: true },
      });
    }
  } finally {
    storage.resolve(new Blob([f.bytes]));
    for (const response of await Promise.all([first, second, third])) {
      if (!response.bodyUsed) await response.arrayBuffer();
    }
  }
  expect(f.backend.internal).toHaveBeenCalledExactlyOnceWith(
    "authorize_artifact_download",
    {
      artifact_id: artifact,
      actor_id: actor,
      actual_hash: f.context.artifact.content_hash,
    },
  );
});

it("keeps a completed download admitted until the consumer drains EOF", async () => {
  const f = await fixture();
  const first = await f.handle(request());
  expect(first.status).toBe(200);
  const reader = first.body!.getReader();
  const blocked = async () => {
    const response = await f.handle(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("FILE_PROCESSING_BUSY");
  };
  await blocked();
  expect(await reader.read()).toEqual({ done: false, value: f.bytes });
  await blocked();
  expect(f.backend.userRpc).toHaveBeenCalledTimes(1);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  expect(new Uint8Array(await next.arrayBuffer())).toEqual(f.bytes);
});

it.each(["body_cancel", "request_abort"] as const)(
  "releases an unused successful download on %s",
  async (mode) => {
    const f = await fixture(),
      abort = new AbortController();
    const first = await f.handle(request(undefined, abort.signal));
    expect(first.status).toBe(200);
    if (mode === "body_cancel") await first.body!.cancel();
    else {
      abort.abort(new Error("client closed"));
      await expect(first.arrayBuffer()).rejects.toThrow("client closed");
      await Promise.resolve();
    }
    const next = await f.handle(request());
    expect(next.status).toBe(200);
    await next.arrayBuffer();
  },
);

it("holds canceled noncooperative Storage work until settled and prevents late authorization", async () => {
  const f = await fixture(),
    abort = new AbortController();
  const storage = deferred<Blob>(),
    entered = deferred<void>();
  f.backend.deliveryObject.mockImplementationOnce(
    async (_key, observedSignal) => {
      expect(observedSignal?.aborted).toBe(false);
      entered.resolve();
      return storage.promise;
    },
  );
  const first = f.handle(request(undefined, abort.signal));
  await entered.promise;
  abort.abort();
  const busy = await f.handle(request());
  expect((await busy.json()).error.code).toBe("FILE_PROCESSING_BUSY");
  expect(f.backend.userRpc).toHaveBeenCalledTimes(1);
  storage.resolve(new Blob([f.bytes]));
  expect((await first).status).toBe(503);
  expect(f.backend.internal).not.toHaveBeenCalled();
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  await next.arrayBuffer();
});

it("performs final currentness authorization and releases on its refusal", async () => {
  const f = await fixture();
  f.backend.internal.mockRejectedValueOnce(
    new AppError(403, "ROLE_FORBIDDEN", "Membership revoked"),
  );
  const denied = await f.handle(request());
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.code).toBe("ROLE_FORBIDDEN");
  expect(f.backend.internal).toHaveBeenCalledExactlyOnceWith(
    "authorize_artifact_download",
    {
      artifact_id: artifact,
      actor_id: actor,
      actual_hash: f.context.artifact.content_hash,
    },
  );
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  await next.arrayBuffer();
});

it("authenticates and checks membership before busy admission while light status remains responsive", async () => {
  const f = await fixture(),
    response = await f.handle(request());
  f.backend.membership.mockRejectedValueOnce(
    new AppError(403, "ACCESS_PENDING", "Membership required"),
  );
  const denied = await f.handle(request());
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.code).toBe("ACCESS_PENDING");
  const status = await f.handle(request("status"));
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ data: { available: true } });
  const health = await f.handle(request("health"));
  expect(health.status).toBe(200);
  expect(f.backend.userRpc).toHaveBeenCalledTimes(1);
  await response.body!.cancel();
});

it("releases early context failure without reaching Storage", async () => {
  const f = await fixture();
  f.backend.userRpc.mockRejectedValueOnce(
    new AppError(403, "ROLE_FORBIDDEN", "No access"),
  );
  expect((await f.handle(request())).status).toBe(403);
  expect(f.backend.deliveryObject).not.toHaveBeenCalled();
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  await next.arrayBuffer();
});

it.each([
  [
    "GET",
    `delivery-artifacts/${artifact}/download`,
    "internal",
    "delivery_artifact_context",
  ],
  [
    "POST",
    `export-artifacts/${artifact}/complete`,
    "userRpc",
    "artifact_context",
  ],
  ["GET", `exports/${artifact}/context`, "userRpc", "export_context"],
  [
    "GET",
    `delivery-snapshots/${artifact}/package`,
    "userRpc",
    "delivery_package",
  ],
] as const)(
  "admits %s %s before its first large context RPC",
  async (method, path, transport, rpc) => {
    const f = await fixture(),
      gate = deferred<any>(),
      entered = deferred<void>();
    const invoke = () =>
      f.handle(
        new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
          method,
          headers: {
            authorization: "Bearer synthetic-user",
            origin: env.allowedOrigins[0],
          },
        }),
      );
    if (transport === "internal")
      f.backend.internal.mockImplementation(async (name) => {
        expect(name).toBe(rpc);
        entered.resolve();
        return gate.promise;
      });
    else
      f.backend.userRpc.mockImplementation(async (_token, name) => {
        expect(name).toBe(rpc);
        entered.resolve();
        return gate.promise;
      });
    const first = invoke();
    await entered.promise;
    try {
      for (const response of await Promise.all([invoke(), invoke()])) {
        expect(response.status).toBe(503);
        expect((await response.json()).error.code).toBe("FILE_PROCESSING_BUSY");
      }
      expect(f.backend[transport]).toHaveBeenCalledOnce();
      expect(f.backend.object).not.toHaveBeenCalled();
      expect(f.backend.deliveryObject).not.toHaveBeenCalled();
    } finally {
      gate.reject(
        new AppError(
          409,
          "SYNTHETIC_CONTEXT_STOP",
          "End controlled context fixture",
        ),
      );
      expect((await first).status).toBe(409);
    }
  },
);

it("does not serialize a late generic context after request cancellation", async () => {
  const f = await fixture(),
    gate = deferred<any>(),
    entered = deferred<void>(),
    abort = new AbortController();
  const serialized = vi.fn(() => {
    throw Error("Canceled context was serialized");
  });
  f.backend.userRpc.mockImplementationOnce(async () => {
    entered.resolve();
    return gate.promise;
  });
  const first = f.handle(
    request(`delivery-snapshots/${artifact}/context`, abort.signal),
  );
  await entered.promise;
  abort.abort();
  gate.resolve({ toJSON: serialized });
  expect((await first).status).toBe(503);
  expect(serialized).not.toHaveBeenCalled();
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  await next.arrayBuffer();
});

it("streams command results without changing envelope, ordering or idempotency and holds admission through the body", async () => {
  const f = await fixture();
  const result = [
    { id: actor, required: false, amount: 0 },
    { text: "شرط أصلي", amount: null },
  ];
  const source = new Response(JSON.stringify(result)).body!;
  f.backend.batchStream.mockResolvedValueOnce(source);
  const commands = [
    {
      operation: "notification.read",
      input: { id: actor, expected_revision: 1 },
    },
  ];
  const input = new Request(
    "https://edge.example.test/functions/v1/api/v1/commands",
    {
      method: "POST",
      headers: {
        origin: env.allowedOrigins[0],
        authorization: "Bearer synthetic-user",
        "content-type": "application/json",
        "idempotency-key": "same-authorized-operation",
      },
      body: JSON.stringify({ commands }),
    },
  );
  const response = await f.handle(input);
  expect(response.status).toBe(200);
  expect(f.backend.batchStream).toHaveBeenCalledExactlyOnceWith(
    "synthetic-user",
    commands,
    "same-authorized-operation",
    input.signal,
  );
  const busy = await f.handle(request());
  expect((await busy.json()).error.code).toBe("FILE_PROCESSING_BUSY");
  expect(f.backend.userRpc).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({
    data: result,
    meta: { request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
  });
  const next = await f.handle(request());
  expect(next.status).toBe(200);
  await next.arrayBuffer();
});

it.each(["request_abort", "consumer_cancel"] as const)(
  "keeps streamed batch admission until upstream %s actually stops",
  async (mode) => {
    const f = await fixture(),
      stopped = deferred<void>(),
      abort = new AbortController();
    const upstreamCancel = vi.fn(() => stopped.promise);
    const upstream = new Response(
      new ReadableStream<Uint8Array>(
        { cancel: upstreamCancel },
        { highWaterMark: 0 },
      ),
      {
        headers: { "content-type": "application/json" },
      },
    );
    const wire = batchWire(["null"]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(wire.manifest))
      .mockResolvedValueOnce(upstream);
    f.backend.batchStream.mockImplementation((token, commands, key, signal) =>
      postgrestBatchBody({
        url: env.url,
        publishableKey: env.publishableKey,
        token,
        commands,
        idempotencyKey: key,
        signal,
        fetch: fetcher,
      }),
    );
    const input = new Request(
      "https://edge.example.test/functions/v1/api/v1/commands",
      {
        method: "POST",
        signal: abort.signal,
        headers: {
          origin: env.allowedOrigins[0],
          authorization: "Bearer synthetic-user",
          "content-type": "application/json",
          "idempotency-key": "same-batch-once",
        },
        body: JSON.stringify({
          commands: [
            {
              operation: "notification.read",
              input: { id: actor, expected_revision: 1 },
            },
          ],
        }),
      },
    );
    const response = await f.handle(input);
    const reader = response.body!.getReader();
    await reader.read(); // API envelope.
    await reader.read(); // Batch array start; no chunk is prefetched.
    const pendingRead = reader.read().catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    let completion: Promise<unknown>;
    if (mode === "request_abort") {
      abort.abort(new Error("client left"));
      completion = pendingRead;
    } else completion = reader.cancel("consumer left");
    const busy = await f.handle(request());
    expect((await busy.json()).error.code).toBe("FILE_PROCESSING_BUSY");
    expect(f.backend.userRpc).not.toHaveBeenCalled();
    expect(upstreamCancel).toHaveBeenCalledOnce();
    stopped.resolve();
    await completion;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = await f.handle(request());
    expect(next.status).toBe(200);
    await next.arrayBuffer();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
