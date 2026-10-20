// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";

const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-service",
  allowedOrigins: [],
  workerSecret: "synthetic-worker",
  models: modelEnvironments(() => undefined),
};

it("authenticates before accepting and keeps background work alive after the caller disconnects", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const internal = vi.fn(async (name: string) => {
    if (name === "maintenance_tick") await waiting;
    return name === "claim_storage_cleanup" ? [] : null;
  });
  const backend = { internal, claim: vi.fn(async () => null) };
  const tasks: Promise<void>[] = [];
  const handler = createWorkerHandler(
    env,
    async () => [],
    () => backend as unknown as Backend,
    fetch,
    (task) => tasks.push(task),
  );
  const controller = new AbortController();
  const request = (key: string) =>
    new Request("https://synthetic.test/worker", {
      method: "POST",
      headers: { "x-worker-secret": key },
      signal: controller.signal,
    });
  expect((await handler(request("wrong"))).status).toBe(401);
  expect(tasks).toHaveLength(0);
  const response = await handler(request(env.workerSecret));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ data: { accepted: true } });
  expect(backend.claim).not.toHaveBeenCalled();
  controller.abort();
  release();
  await tasks[0];
  expect(backend.claim).toHaveBeenCalledTimes(1);
});

it("handles detached errors without an unhandled promise or invented success", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tasks: Promise<void>[] = [];
  const backend = {
    internal: vi.fn(async () => {
      throw new Error("private failure");
    }),
  };
  const handler = createWorkerHandler(
    env,
    async () => [],
    () => backend as unknown as Backend,
    fetch,
    (task) => tasks.push(task),
  );
  expect(
    (
      await handler(
        new Request("https://synthetic.test/worker", {
          method: "POST",
          headers: { "x-worker-secret": env.workerSecret },
        }),
      )
    ).status,
  ).toBe(202);
  await tasks[0];
  expect(warning).toHaveBeenCalledWith("background_dispatch_failed");
  expect(warning).not.toHaveBeenCalledWith("private failure");
  warning.mockRestore();
});
