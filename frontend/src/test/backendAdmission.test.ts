// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackendClient } from "../lib/backendClient";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth }) }));
vi.mock("../lib/deployment", () => ({ deployment: {} }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const envelope = (data: unknown) => ({
  data,
  meta: { request_id: "synthetic" },
});
const response = (data: unknown) =>
  new Response(JSON.stringify(envelope(data)));
const session = (user = 1, token = "synthetic-token") => ({
  data: { session: { access_token: token, user: { id: id(user) } } },
  error: null,
});
let client: BackendClient;
beforeEach(() => {
  auth.getSession.mockResolvedValue(session());
  client = new BackendClient("https://api.example.test", "synthetic-public");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("holds the lane through JSON consumption while light status passes, preserving queued command body and key", async () => {
  const body = deferred<unknown>();
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) =>
    url.includes("/documents?")
      ? ({ ok: true, status: 200, json: () => body.promise } as Response)
      : response({ complete: true }),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = client.request("/v1/documents?limit=100");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const command = {
    commands: [
      {
        operation: "delivery.snapshot.prepare",
        input: { opportunity_id: id(8), expected_revision: 4 },
      },
    ],
  };
  const second = client.request("/v1/commands", {
    method: "POST",
    body: command,
    idempotencyKey: "same-key",
  });
  await client.request("/v1/status");
  expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/functions/v1/api/v1/documents",
    "/functions/v1/api/v1/status",
  ]);
  body.resolve(
    envelope({
      records: [{ id: id(3), extracted_text: "يجب تسليم 12 وحدة" }],
      next_cursor: null,
    }),
  );
  await first;
  await second;
  const options = fetcher.mock.calls[2][1]!;
  expect(JSON.parse(options.body as string)).toEqual(command);
  expect(options.headers).toMatchObject({ "Idempotency-Key": "same-key" });
});

it("serializes artifact downloads through blob consumption", async () => {
  const bytes = deferred<Blob>();
  const fetcher = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        blob: () =>
          fetcher.mock.calls.length === 1
            ? bytes.promise
            : Promise.resolve(new Blob(["financial"])),
      }) as Response,
  );
  vi.stubGlobal("fetch", fetcher);
  const a = client.downloadDeliveryArtifact(id(2));
  const b = client.downloadDeliveryArtifact(id(3));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  bytes.resolve(new Blob(["technical"]));
  expect(await (await a).text()).toBe("technical");
  expect(await (await b).text()).toBe("financial");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not send an aborted queued request and releases the lane", async () => {
  const body = deferred<unknown>();
  const fetcher = vi.fn(async (_url: string) =>
    fetcher.mock.calls.length === 1
      ? ({ ok: true, json: () => body.promise } as Response)
      : response({}),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = client.request("/v1/documents");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const controller = new AbortController();
  const aborted = client.request("/v1/knowledge", {
    signal: controller.signal,
  });
  const rejected = expect(aborted).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  const last = client.request("/v1/review-inputs");
  body.resolve(envelope({}));
  await first;
  await rejected;
  await last;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain("/review-inputs");
});

it.each(["busy", "invalid JSON"])(
  "surfaces %s once and releases the lane without retry",
  async (kind) => {
    const failed =
      kind === "busy"
        ? new Response(
            JSON.stringify({
              error: {
                code: "FILE_PROCESSING_BUSY",
                message:
                  "A file request is already running. Try again when it finishes.",
                retryable: true,
                details: null,
              },
            }),
            { status: 503 },
          )
        : new Response("invalid");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetcher);
    const first = client.request("/v1/documents");
    const second = client.request("/v1/knowledge");
    await expect(first).rejects.toMatchObject(
      kind === "busy"
        ? {
            code: "FILE_PROCESSING_BUSY",
            status: 503,
            message:
              "A file request is already running. Try again when it finishes.",
          }
        : { code: "INVALID_RESPONSE" },
    );
    await second;
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true])(
  "binds queued authority while allowing same-user token refresh: %s",
  async (sameUser) => {
    const body = deferred<unknown>();
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) =>
      fetcher.mock.calls.length === 1
        ? ({ ok: true, json: () => body.promise } as Response)
        : response({ saved: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = client.request("/v1/documents");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = client.request("/v1/commands", {
      method: "POST",
      body: { commands: [] },
      idempotencyKey: "unchanged",
    });
    auth.getSession.mockResolvedValue(session(sameUser ? 1 : 9, "new-token"));
    const outcome = sameUser
      ? expect(second).resolves.toMatchObject({ data: { saved: true } })
      : expect(second).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    body.resolve(envelope({}));
    await first;
    await outcome;
    expect(fetcher).toHaveBeenCalledTimes(sameUser ? 2 : 1);
    if (sameUser)
      expect(fetcher.mock.calls[1][1]!.headers).toMatchObject({
        Authorization: "Bearer new-token",
      });
  },
);

it("retains complete one-record pages and the final empty continuation", async () => {
  const rows = [
    {
      id: id(2),
      original: {
        clauses: ["لا يجوز التعاقد من الباطن", "12 units"],
        amount: 0,
      },
    },
    { id: id(3), original: { clauses: ["Complete final page"], amount: null } },
  ];
  const request = vi
    .spyOn(client, "request")
    .mockImplementation(async (path) => {
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      const n = cursor === id(2) ? 1 : cursor === id(3) ? 2 : 0;
      return envelope({
        records: n < rows.length ? [rows[n]] : [],
        next_cursor: n < rows.length ? rows[n].id : null,
      });
    });
  expect(await client.list("documents")).toEqual(rows);
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps more than ten thousand one-record pages without an aggregate limit", async () => {
  const request = vi
    .spyOn(client, "request")
    .mockImplementation(async (path) => {
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      const n = cursor ? parseInt(cursor.slice(-12), 16) : 0;
      return envelope({
        records:
          n < 10001 ? [{ id: id(n + 1), exact_text: `Source ${n + 1}` }] : [],
        next_cursor: n < 10001 ? id(n + 1) : null,
      });
    });
  const rows = await client.list<{ id: string; exact_text: string }>(
    "knowledge",
  );
  expect(rows).toHaveLength(10001);
  expect(rows.at(-1)).toEqual({ id: id(10001), exact_text: "Source 10001" });
  expect(request).toHaveBeenCalledTimes(10002);
});

it.each([
  { records: [], next_cursor: id(2) },
  { records: [{ id: id(2) }], next_cursor: id(3) },
])("rejects invalid continuation without partial success", async (page) => {
  vi.spyOn(client, "request").mockResolvedValue(envelope(page));
  await expect(client.list("documents")).rejects.toThrow(
    "pagination did not advance",
  );
});

it("preserves lossless descending model-activity sequence pagination", async () => {
  const rows = ["9007199254740993123", "9007199254740993122", "90", "9"].map(
    (id) => ({ id, provider: "synthetic", result_code: null, sent: false }),
  );
  const request = vi
    .spyOn(client, "request")
    .mockImplementation(async (path) => {
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      const n = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      return envelope({
        records: [rows[n]],
        next_cursor: n < rows.length - 1 ? rows[n].id : null,
      });
    });
  expect(await client.list("model-activity")).toEqual(rows);
  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls[1][0]).toContain("cursor=9007199254740993123");
});

it("rejects repeated or increasing model-activity sequences", async () => {
  for (const second of ["90", "91"]) {
    vi.spyOn(client, "request")
      .mockResolvedValueOnce(
        envelope({ records: [{ id: "90" }], next_cursor: "90" }),
      )
      .mockResolvedValueOnce(
        envelope({ records: [{ id: second }], next_cursor: null }),
      );
    await expect(client.list("model-activity")).rejects.toThrow(
      "pagination did not advance",
    );
    vi.restoreAllMocks();
  }
});

it.each([true, false])(
  "pins one identity across a whole list, including final publication (continuation=%s)",
  async (continuation) => {
    const fetcher = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            auth.getSession.mockResolvedValue(session(9, "other-token"));
            return envelope({
              records: [{ id: id(2), text: "Original user's source" }],
              next_cursor: continuation ? id(2) : null,
            });
          },
        }) as Response,
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(client.list("documents")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each(["knowledge", "opportunity-discovery"])(
  "pins a whole repository load across identity change at %s",
  async (changedResource) => {
    const { ConnectedRepository } = await import("../lib/connectedRepository");
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname.split("/api")[1];
      if (path === "/v1/bootstrap")
        return response({
          membership: { workspace_id: id(10), user_id: id(1), role: "Owner" },
          workspace: {
            id: id(10),
            revision: 1,
            name: "Original user workspace",
            settings: {},
          },
          operations: null,
        });
      if (path === `/v1/${changedResource}`)
        return {
          ok: true,
          status: 200,
          json: async () => {
            auth.getSession.mockResolvedValue(session(9, "other-token"));
            return envelope(
              changedResource === "knowledge"
                ? {
                    records: [
                      { id: id(2), revision: 1, content: "Old source" },
                    ],
                    next_cursor: id(2),
                  }
                : { records: [], next_cursor: null },
            );
          },
        } as Response;
      return response({ records: [], next_cursor: null });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(new ConnectedRepository(client).load()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(
      fetcher.mock.calls.filter(([url]) =>
        new URL(url).pathname.endsWith(`/v1/${changedResource}`),
      ),
    ).toHaveLength(1);
  },
);
