import { expect, it, vi } from "vitest";
import {
  acquireNativeDocxProcess,
  renderDeliveryIsolated,
  type RendererProcess,
} from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import {
  verifyDeliveryIsolated,
  hasNativeVerifierRuntime,
  verifyOwnedDeliverySnapshot,
} from "../../supabase/functions/_shared/deliveryVerifyIsolation.ts";
import {
  acceptVerificationVerdict,
  docxDigest,
  frameHeader,
  readVerificationFrame,
  DOCX_FRAME_LIMIT,
} from "../../supabase/functions/_shared/deliveryVerifyProtocol.ts";
import type { RenderModel } from "../../supabase/functions/_shared/export.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
const encoder = new TextEncoder();
const model = { id: "synthetic" } as RenderModel;
const document = new Uint8Array([1, 2, 3]);
const stream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
const expected = {
  model_hash: "a".repeat(64),
  document_hash: "b".repeat(64),
  size: 3,
};
const verdict = { version: 1, verified: true, ...expected };
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
function fixture(auto = false) {
  let out!: ReadableStreamDefaultController<Uint8Array>,
    err!: ReadableStreamDefaultController<Uint8Array>,
    resolve!: (value: { success: boolean }) => void;
  let ended = false;
  const chunks: Uint8Array[] = [];
  const process: RendererProcess = {
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      async close() {
        if (!auto) return;
        const frame = await readVerificationFrame(stream(chunks));
        finish(
          true,
          encode({
            version: 1,
            verified: true,
            model_hash: await docxDigest(frame.model),
            document_hash: await docxDigest(frame.bytes),
            size: frame.bytes.length,
          }),
        );
      },
    }),
    stdout: new ReadableStream({
      start(c) {
        out = c;
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        err = c;
      },
    }),
    status: new Promise((r) => {
      resolve = r;
    }),
    kill: vi.fn(() => finish(false)),
  };
  function finish(success: boolean, bytes?: Uint8Array) {
    if (ended) return;
    ended = true;
    if (bytes) out.enqueue(bytes);
    out.close();
    err.close();
    resolve({ success });
  }
  return { process, chunks, finish, output: () => out, error: () => err };
}
it("reads byte-fragmented exact frames and requires EOF", async () => {
  const header = frameHeader(2, 3),
    all = new Uint8Array([...header, 10, 11, 1, 2, 3]);
  const value = await readVerificationFrame(
    stream(Array.from(all, (b) => new Uint8Array([b]))),
  );
  expect([...value.model]).toEqual([10, 11]);
  expect([...value.bytes]).toEqual([1, 2, 3]);
  await expect(
    readVerificationFrame(stream([all, new Uint8Array([9])])),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_FAILED" });
  await expect(
    readVerificationFrame(stream([all.subarray(0, -1)])),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_FAILED" });
});
it.each([0, DOCX_FRAME_LIMIT + 1, 0xffffffff])(
  "rejects declared out-of-bound frames %s before body allocation",
  async (size) => {
    const bytes = new Uint8Array(8),
      view = new DataView(bytes.buffer);
    view.setUint32(0, size);
    view.setUint32(4, 1);
    await expect(readVerificationFrame(stream([bytes]))).rejects.toMatchObject({
      code: "FILE_SIZE_INVALID",
      status: 413,
    });
  },
);
it("accepts only the exact canonical positive receipt", () => {
  expect(acceptVerificationVerdict(encode(verdict), true, expected)).toBe(true);
  for (const change of [
    { model_hash: "c".repeat(64) },
    { document_hash: "d".repeat(64) },
    { size: 4 },
    { verified: false },
    { version: 2 },
    { extra: "ignored" },
  ])
    expect(() =>
      acceptVerificationVerdict(
        encode({ ...verdict, ...change }),
        true,
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code: "DELIVERY_RENDER_FAILED" }));
  expect(() =>
    acceptVerificationVerdict(encode(verdict), false, expected),
  ).toThrowError(expect.objectContaining({ code: "DELIVERY_RENDER_FAILED" }));
  for (const raw of [
    JSON.stringify(verdict) + "\n",
    JSON.stringify(verdict).replace('"version":1', '"version":0,"version":1'),
    "null",
    "[]",
  ])
    expect(() =>
      acceptVerificationVerdict(encoder.encode(raw), true, expected),
    ).toThrow();
});
it("preserves canonical content errors only on failed child exits", () => {
  for (const [code, status] of [
    ["EXPORT_CONTENT_MISMATCH", 422],
    ["EXPORT_UNSAFE_CONTENT", 422],
    ["FILE_SIZE_INVALID", 413],
  ] as const)
    expect(() =>
      acceptVerificationVerdict(
        encode({ version: 1, code, status }),
        false,
        expected,
      ),
    ).toThrowError(expect.objectContaining({ code, status }));
  for (const value of [
    { version: 1, code: "UNTRUSTED", status: 422 },
    { version: 1, code: "EXPORT_CONTENT_MISMATCH", status: 500 },
    {
      version: 1,
      code: "EXPORT_CONTENT_MISMATCH",
      status: 422,
      secret: "hidden",
    },
  ])
    expect(() =>
      acceptVerificationVerdict(encode(value), false, expected),
    ).toThrowError(expect.objectContaining({ code: "DELIVERY_RENDER_FAILED" }));
  expect(() =>
    acceptVerificationVerdict(
      encode({ version: 1, code: "EXPORT_CONTENT_MISMATCH", status: 422 }),
      true,
      expected,
    ),
  ).toThrow();
});
it("frames exact call-time input snapshots and returns only a verified boolean", async () => {
  const release = await acquireNativeDocxProcess(1000),
    f = fixture(true);
  const mutable = { id: "before" } as RenderModel,
    bytes = new Uint8Array([1, 2, 3]);
  const result = verifyDeliveryIsolated(
    bytes,
    mutable,
    undefined,
    () => f.process,
  );
  mutable.id = "after";
  bytes[0] = 9;
  release();
  await expect(result).resolves.toBe(true);
  const frame = await readVerificationFrame(stream(f.chunks));
  expect(JSON.parse(new TextDecoder().decode(frame.model))).toEqual({
    id: "before",
  });
  expect([...frame.bytes]).toEqual([1, 2, 3]);
  expect(f.process.kill).not.toHaveBeenCalled();
});
it("frames an already-owned serialized snapshot without reparsing its object graph", async () => {
  const f = fixture(true),
    snapshot = JSON.stringify({
      id: "owned",
      rows: Array.from({ length: 100 }, () => []),
    });
  const parse = JSON.parse;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text === snapshot)
      throw Error("Owned model must not be reconstructed in the parent");
    return parse(text, reviver);
  });
  try {
    await expect(
      verifyOwnedDeliverySnapshot(
        new Uint8Array(document),
        snapshot,
        undefined,
        () => f.process,
      ),
    ).resolves.toBe(true);
    const frame = await readVerificationFrame(stream(f.chunks));
    expect(new TextDecoder().decode(frame.model)).toBe(snapshot);
    expect(frame.bytes).toEqual(document);
  } finally {
    spy.mockRestore();
  }
});
it("does not fall back when a Deno runtime has no usable command implementation", async () => {
  vi.stubGlobal("Deno", {});
  try {
    expect(hasNativeVerifierRuntime()).toBe(true);
    await expect(verifyDeliveryIsolated(document, model)).rejects.toMatchObject(
      { code: "DELIVERY_RENDER_FAILED" },
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
it("shares the physical lane with rendering and removes an expired queued verifier", async () => {
  const first = fixture(),
    create = vi.fn(() => fixture(true).process);
  const render = renderDeliveryIsolated(model, () => first.process);
  const queued = verifyDeliveryIsolated(document, model, undefined, create, 10);
  await expect(queued).rejects.toMatchObject({
    code: "DELIVERY_RENDER_TIMEOUT",
  });
  expect(create).not.toHaveBeenCalled();
  first.finish(true, new Uint8Array([4]));
  await render;
  const next = fixture(true);
  await expect(
    verifyDeliveryIsolated(document, model, undefined, () => next.process),
  ).resolves.toBe(true);
});
it("includes synchronous preprocessing in the total admission deadline", async () => {
  const create = vi.fn(() => fixture(true).process);
  const slow = {
    toJSON() {
      const end = performance.now() + 8;
      while (performance.now() < end) {}
      return { id: "late" };
    },
  } as unknown as RenderModel;
  await expect(
    verifyDeliveryIsolated(document, slow, undefined, create, 1),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_TIMEOUT" });
  expect(create).not.toHaveBeenCalled();
});
it("kills and reaps a verifier timeout using the established retry code", async () => {
  const f = fixture();
  await expect(
    verifyDeliveryIsolated(document, model, undefined, () => f.process, 20),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_TIMEOUT" });
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.process.status).resolves.toEqual({ success: false });
});
it("preserves request expiry before queue, while queued, and during active verification", async () => {
  const reason = new AppError(409, "STALE_LEASE", "Synthetic expiry"),
    before = new AbortController();
  before.abort(reason);
  const create = vi.fn(() => fixture(true).process);
  await expect(
    verifyDeliveryIsolated(document, model, before.signal, create),
  ).rejects.toBe(reason);
  expect(create).not.toHaveBeenCalled();
  const release = await acquireNativeDocxProcess(1000),
    queued = new AbortController();
  const waiting = verifyDeliveryIsolated(
    document,
    model,
    queued.signal,
    create,
  );
  queued.abort(reason);
  await expect(waiting).rejects.toBe(reason);
  expect(create).not.toHaveBeenCalled();
  release();
  const active = new AbortController(),
    f = fixture();
  const result = verifyDeliveryIsolated(
    document,
    model,
    active.signal,
    () => f.process,
  );
  await vi.waitFor(() => expect(f.chunks.length).toBe(3));
  active.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
});
it.each(["stdout", "stderr"] as const)(
  "kills bounded %s overflow without exposing exception text",
  async (channel) => {
    const f = fixture();
    const result = verifyDeliveryIsolated(
      document,
      model,
      undefined,
      () => f.process,
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "DELIVERY_RENDER_FAILED",
    });
    (channel === "stdout" ? f.output() : f.error()).enqueue(
      new Uint8Array(channel === "stdout" ? 2049 : 65537),
    );
    await assertion;
    expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
  },
);
it("releases the shared lane after factory failure and detaches success cancellation", async () => {
  await expect(
    verifyDeliveryIsolated(document, model, undefined, () => {
      throw Error("secret");
    }),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_FAILED" });
  const f = fixture(true),
    controller = new AbortController();
  await verifyDeliveryIsolated(
    document,
    model,
    controller.signal,
    () => f.process,
  );
  controller.abort(new Error("later"));
  expect(f.process.kill).not.toHaveBeenCalled();
});
it("rejects oversize input before spawning", async () => {
  const create = vi.fn(() => fixture(true).process);
  await expect(
    verifyDeliveryIsolated(
      new Uint8Array(DOCX_FRAME_LIMIT + 1),
      model,
      undefined,
      create,
    ),
  ).rejects.toMatchObject({ code: "FILE_SIZE_INVALID" });
  expect(create).not.toHaveBeenCalled();
});
it("retains physical admission until the killed child is actually reaped", async () => {
  const first = fixture(),
    second = fixture(true),
    controller = new AbortController();
  first.process.kill = vi.fn();
  const one = verifyDeliveryIsolated(
    document,
    model,
    controller.signal,
    () => first.process,
  );
  const reason = new AppError(409, "STALE_LEASE", "Synthetic lease expired");
  const assertion = expect(one).rejects.toBe(reason);
  await vi.waitFor(() => expect(first.chunks.length).toBe(3));
  const create = vi.fn(() => second.process);
  const two = verifyDeliveryIsolated(document, model, undefined, create);
  controller.abort(reason);
  await Promise.resolve();
  expect(first.process.kill).toHaveBeenCalledWith("SIGKILL");
  expect(create).not.toHaveBeenCalled();
  first.finish(false);
  await assertion;
  await expect(two).resolves.toBe(true);
  expect(create).toHaveBeenCalledOnce();
});
it("kills and reaps failed input writes before releasing the lane", async () => {
  const f = fixture();
  f.process.stdin = new WritableStream({
    write() {
      throw Error("Private OS failure");
    },
  });
  await expect(
    verifyDeliveryIsolated(document, model, undefined, () => f.process),
  ).rejects.toMatchObject({ code: "DELIVERY_RENDER_FAILED" });
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.process.status).resolves.toEqual({ success: false });
  const next = fixture(true);
  await expect(
    verifyDeliveryIsolated(document, model, undefined, () => next.process),
  ).resolves.toBe(true);
});
it.each([
  ["worker", 128],
  ["api", 64],
  ["source-browser", 64],
  [undefined, 64],
] as const)(
  "binds the child budget to trusted service %s only",
  async (service, budget) => {
    const f = fixture(true);
    let executable: string | undefined, options: any;
    vi.stubGlobal("Deno", {
      env: {
        get: (name: string) =>
          name === "APP_RUNTIME_SERVICE" ? service : undefined,
      },
      Command: class {
        constructor(path: string, value: unknown) {
          executable = path;
          options = value;
        }
        spawn() {
          return f.process;
        }
      },
    });
    try {
      await expect(
        verifyDeliveryIsolated(document, {
          ...model,
          mode: "worker",
          volume: "worker",
        }),
      ).resolves.toBe(true);
      expect(executable).toBe("/bin/deno");
      expect(options.args).toContain(
        `--v8-flags=--max-old-space-size=${budget}${budget === 64 ? ",--max-semi-space-size=4" : ""}`,
      );
      expect(options.args).not.toContain("--allow-net");
      expect(options.clearEnv).toBe(true);
      expect(options.env).toEqual({ DENO_DIR: "/deno-dir" });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it("hashes only the supplied byte view and defensively handles shared backing buffers", async () => {
  const ordinary = new Uint8Array([9, 1, 2, 3, 8]);
  const expectedHash = await docxDigest(new Uint8Array([1, 2, 3]));
  expect(await docxDigest(ordinary.subarray(1, 4))).toBe(expectedHash);
  const shared = new Uint8Array(new SharedArrayBuffer(5));
  shared.set(ordinary);
  expect(await docxDigest(shared.subarray(1, 4))).toBe(expectedHash);
});
