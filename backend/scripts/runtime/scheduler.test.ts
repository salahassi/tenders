import { describe, expect, it, vi } from "vitest";
import { DurableScheduler, runScheduler, validateLease, validateSchedulerConfig } from "./scheduler.ts";

const lease = { lease: "0b97a210-35cd-4c5a-a8a9-6ec5c861702f", generation: 3 };
const config = { gatewayUrl: "http://gateway:8081", serviceKey: "synthetic-service-token",
  workerUrl: "http://worker:8080/functions/v1/worker", workerSecret: "synthetic-worker-secret" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("durable Kubernetes dispatcher", () => {
  it("rejects unbounded generations and malformed lease receipts", () => {
    expect(validateLease(null)).toBeNull();
    for (const value of [{}, { ...lease, generation: 0 }, { ...lease, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...lease, lease: "not-a-lease" }]) expect(() => validateLease(value)).toThrow("DISPATCH_LEASE_INVALID");
  });

  it("requires exact internal worker path and no URL-embedded credentials", () => {
    for (const change of [{ workerUrl: "http://worker:8080/other" },
      { gatewayUrl: "http://user:password@gateway:8081" }, { workerSecret: "" },
      { gatewayUrl: "http://gateway:8081/?token=secret" }])
      expect(() => validateSchedulerConfig({ ...config, ...change })).toThrow();
  });

  it("does not invoke the worker when no due durable wake is claimed", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(null));
    expect(await new DurableScheduler(config, fetcher).tick()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a synchronous completion with its exact lease and generation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json({ data: { claimed: false } })).mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config, fetcher).tick()).toBe(true);
    const requests = fetcher.mock.calls;
    expect(requests[0][1]?.headers).toMatchObject({ apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` });
    expect(requests[1][0]).toBe(config.workerUrl);
    expect(requests[1][1]?.headers).toMatchObject({ "x-worker-secret": config.workerSecret });
    expect(requests[1][1]?.headers).not.toHaveProperty("Authorization");
    expect(requests.every((call) => call[1]?.redirect === "error")).toBe(true);
    expect(JSON.parse(String(requests[2][1]?.body))).toEqual({ dispatch_lease: lease.lease,
      dispatch_generation: lease.generation, succeeded: true });
  });

  it.each([202, 401, 500, 503])("keeps unexpected worker status %i pending for bounded retry", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json({ error: "synthetic" }, status)).mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config, fetcher).tick()).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).succeeded).toBe(false);
  });

  it("retains failed network dispatch in the durable retry path", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockRejectedValueOnce(Error("synthetic network error containing secret"))
      .mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config, fetcher).tick()).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).succeeded).toBe(false);
  });

  it("rejects stale acknowledgements rather than claiming a completed dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json({ data: {} })).mockResolvedValueOnce(json(false));
    await expect(new DurableScheduler(config, fetcher).tick()).rejects.toThrow("DISPATCH_LEASE_EXPIRED");
  });

  it("uses fixed failure codes and stops after an aborted active tick", async () => {
    const stop = new AbortController();
    const tick = vi.fn(async () => { stop.abort(); throw Error("sensitive underlying text"); });
    const report = vi.fn();
    await runScheduler({ tick }, stop.signal, report);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("scheduler_dispatch_pending");
  });
});
