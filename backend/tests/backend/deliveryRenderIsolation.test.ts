import { afterEach, expect, it, vi } from "vitest";
import {
  renderDeliveryIsolated,
  type RendererProcess,
} from "../../supabase/functions/_shared/deliveryRenderIsolation.ts";
import type { RenderModel } from "../../supabase/functions/_shared/export.ts";
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
