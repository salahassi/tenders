// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  Backend,
  modelEnvironments,
} from "../../supabase/functions/_shared/backend";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const backend = () =>
  new Backend({
    url: "https://synthetic.test",
    publishableKey: "synthetic-public",
    serviceKey: "synthetic-private",
    workerSecret: "synthetic-worker",
    allowedOrigins: [],
    models: modelEnvironments(() => undefined),
  });

it("propagates caller cancellation through the real legacy Storage download client", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let observed: AbortSignal | undefined;
  const fetcher = vi.fn(async (_url, init) => {
    observed = init.signal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      observed!.addEventListener("abort", () => reject(observed!.reason), {
        once: true,
      });
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const abort = new AbortController();
  const work = backend().object("synthetic/known-original", abort.signal);
  const failed = expect(work).rejects.toThrow("Synthetic caller cancellation");
  await began;
  abort.abort(new Error("Synthetic caller cancellation"));
  await failed;
  expect(observed?.aborted).toBe(true);
  expect(observed).not.toBe(abort.signal);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("does not start a Storage read for an already canceled caller", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const abort = new AbortController();
  abort.abort();
  await expect(
    backend().object("synthetic/original", abort.signal),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains the existing bounded Storage read duration for calls without a caller signal", async () => {
  const timeout = new AbortController();
  const duration = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(timeout.signal);
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.signal).toBe(timeout.signal);
    return new Response("synthetic original");
  });
  vi.stubGlobal("fetch", fetcher);
  const blob = await backend().object("synthetic/original");
  expect(await blob.text()).toBe("synthetic original");
  expect(duration).toHaveBeenCalledWith(20000);
  expect(fetcher).toHaveBeenCalledOnce();
});
