import { afterEach, expect, it, vi } from "vitest";
import {
  renderDeliveryIsolated,
  type RendererProcess,
} from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import type { RenderModel } from "../../supabase/functions/_shared/export.ts";
import { AppError } from "../../supabase/functions/_shared/http.ts";
const model = { id: "synthetic" } as RenderModel;
afterEach(() => vi.useRealTimers());
function fixture() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let resolve!: (status: { success: boolean }) => void;
  let ended = false;
  const process: RendererProcess = {
    stdin: new WritableStream(),
    stdout: new ReadableStream({
      start: (c) => {
        out = c;
      },
    }),
    stderr: new ReadableStream({
      start: (c) => {
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
  return { process, finish, out: () => out };
}
it("kills and reaps an unresponsive renderer without requiring a response", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = renderDeliveryIsolated(model, () => f.process, 30_000);
  const assertion = expect(result).rejects.toMatchObject({
    code: "DELIVERY_RENDER_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.process.status).resolves.toEqual({ success: false });
});
it("returns successful bytes and cancels the deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = renderDeliveryIsolated(model, () => f.process);
  f.finish(true, new Uint8Array([1, 2]));
  await expect(result).resolves.toEqual(new Uint8Array([1, 2]));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.process.kill).not.toHaveBeenCalled();
});
it("rejects unsuccessful exit without exposing child exception text", async () => {
  const f = fixture();
  const result = renderDeliveryIsolated(model, () => f.process);
  f.finish(false);
  await expect(result).rejects.toMatchObject({
    code: "DELIVERY_RENDER_FAILED",
  });
});
it("kills a process exceeding the existing artifact byte limit while streaming", async () => {
  const f = fixture();
  const result = renderDeliveryIsolated(model, () => f.process);
  f.out().enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
  await expect(result).rejects.toMatchObject({
    code: "DELIVERY_ARTIFACT_INVALID",
  });
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
});
it("serializes concurrent invocations and spends queue wait from the same attempt deadline", async () => {
  vi.useFakeTimers();
  const first = fixture(),
    second = fixture();
  const firstCreate = vi.fn(() => first.process),
    secondCreate = vi.fn(() => second.process);
  const one = renderDeliveryIsolated(model, firstCreate, 30_000);
  const two = renderDeliveryIsolated(model, secondCreate, 30_000);
  const secondAssertion = expect(two).rejects.toMatchObject({
    code: "DELIVERY_RENDER_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(firstCreate).toHaveBeenCalledOnce();
  expect(secondCreate).not.toHaveBeenCalled();
  first.finish(true, new Uint8Array([1]));
  await expect(one).resolves.toEqual(new Uint8Array([1]));
  await vi.advanceTimersByTimeAsync(9_999);
  expect(secondCreate).toHaveBeenCalledOnce();
  expect(second.process.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await secondAssertion;
  expect(second.process.kill).toHaveBeenCalledWith("SIGKILL");
});
it("removes expired waiters without spawning and admits the next live request", async () => {
  vi.useFakeTimers();
  const first = fixture(),
    third = fixture();
  const createExpired = vi.fn(() => {
    throw Error("Expired render must not start");
  });
  const one = renderDeliveryIsolated(model, () => first.process, 30_000);
  const two = renderDeliveryIsolated(model, createExpired, 5_000);
  const twoAssertion = expect(two).rejects.toMatchObject({
    code: "DELIVERY_RENDER_TIMEOUT",
  });
  const three = renderDeliveryIsolated(model, () => third.process, 30_000);
  await vi.advanceTimersByTimeAsync(5_000);
  await twoAssertion;
  expect(createExpired).not.toHaveBeenCalled();
  first.finish(true, new Uint8Array([1]));
  await one;
  third.finish(true, new Uint8Array([3]));
  await expect(three).resolves.toEqual(new Uint8Array([3]));
});
it("releases admission when process creation throws", async () => {
  await expect(
    renderDeliveryIsolated(model, () => {
      throw Error("Unavailable runtime");
    }),
  ).rejects.toThrow("Unavailable runtime");
  const next = fixture();
  const result = renderDeliveryIsolated(model, () => next.process);
  next.finish(true, new Uint8Array([4]));
  await expect(result).resolves.toEqual(new Uint8Array([4]));
});
it("propagates an already expired request without claiming renderer admission", async () => {
  const controller = new AbortController();
  const reason = new AppError(
    409,
    "PROPOSAL_ISSUANCE_TIMEOUT",
    "Expired synthetic request",
  );
  controller.abort(reason);
  const create = vi.fn(() => {
    throw Error("Must not spawn");
  });
  await expect(
    renderDeliveryIsolated(model, create, 30_000, controller.signal),
  ).rejects.toBe(reason);
  expect(create).not.toHaveBeenCalled();
  const f = fixture(),
    next = renderDeliveryIsolated(model, () => f.process);
  f.finish(true, new Uint8Array([1]));
  await expect(next).resolves.toEqual(new Uint8Array([1]));
});
it("removes an aborted queued request and preserves its lease-specific reason", async () => {
  const first = fixture(),
    next = fixture(),
    controller = new AbortController();
  const reason = new AppError(409, "STALE_LEASE", "Expired synthetic lease");
  const one = renderDeliveryIsolated(model, () => first.process);
  const create = vi.fn(() => {
    throw Error("Queued cancelled request must not spawn");
  });
  const two = renderDeliveryIsolated(model, create, 30_000, controller.signal);
  const assertion = expect(two).rejects.toBe(reason);
  const three = renderDeliveryIsolated(model, () => next.process);
  controller.abort(reason);
  await assertion;
  expect(create).not.toHaveBeenCalled();
  first.finish(true, new Uint8Array([1]));
  await one;
  next.finish(true, new Uint8Array([3]));
  await expect(three).resolves.toEqual(new Uint8Array([3]));
});
it("kills and reaps active work on request expiry, preserving the supplied reason", async () => {
  const controller = new AbortController(),
    f = fixture();
  const reason = new AppError(
    409,
    "PROPOSAL_ISSUANCE_TIMEOUT",
    "Expired synthetic request",
  );
  const result = renderDeliveryIsolated(
    model,
    () => f.process,
    30_000,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(f.process.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(f.process.status).resolves.toEqual({ success: false });
});
it("detaches the cancellation listener after successful completion", async () => {
  const controller = new AbortController(),
    f = fixture();
  const result = renderDeliveryIsolated(
    model,
    () => f.process,
    30_000,
    controller.signal,
  );
  f.finish(true, new Uint8Array([1]));
  await result;
  controller.abort(new Error("Later unrelated cancellation"));
  expect(f.process.kill).not.toHaveBeenCalled();
});
