import { describe, expect, it, vi } from "vitest";
import { DurableScheduler, runScheduler, runMaintenanceScheduler, validateLease, validateSchedulerConfig } from "./scheduler.ts";

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
      dispatch_generation: lease.generation, succeeded: true, continue_work: false, wake_after_ms: null });
    expect(String(requests[2][0])).toMatch(/k8s_finish_dispatch_v2$/);
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
      .mockResolvedValueOnce(json({ data: {claimed:false} })).mockResolvedValueOnce(json(false));
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

  it("persists immediate continuation and the bounded poll wake without waiting in this tick", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json({data:{claimed:true},queue_retry_after_ms:30000})).mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config,fetcher).tick()).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({continue_work:true,wake_after_ms:30000,succeeded:true});
  });

  it.each([{}, {data:null}, {data:{claimed:1}}, {data:{claimed:true},queue_retry_after_ms:0},
    {data:{claimed:true},queue_retry_after_ms:60001}, {data:{claimed:true},queue_retry_after_ms:1.5},
    {data:{claimed:true},queue_retry_after_ms:"30000"}])("does not acknowledge malformed completion hints: %j", async value => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json(value)).mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config,fetcher).tick()).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({succeeded:false,continue_work:false,wake_after_ms:null});
  });

  it("keeps a slow maintenance request independent while foreground dispatch completes", async () => {
    let finishMaintenance: (()=>void) | undefined;
    const calls: string[]=[];
    const fetcher: typeof fetch = async(input, init) => {
      const url=String(input);calls.push(url);
      if (url.endsWith("/k8s_claim_dispatch") || url.endsWith("/k8s_claim_maintenance")) return json(lease);
      if (url.endsWith("/worker/maintenance")) {
        expect(init?.headers).toMatchObject({"x-worker-secret":config.workerSecret});
        await new Promise<void>(resolve=>{finishMaintenance=resolve;});
        return json({data:{maintenance:true}});
      }
      if (url.endsWith("/worker")) return json({data:{claimed:true},queue_retry_after_ms:30000});
      return json(true);
    };
    const scheduler=new DurableScheduler(config,fetcher);
    let maintenanceDone=false;
    const maintenance=scheduler.maintenanceTick().then(value=>{maintenanceDone=true;return value;});
    await vi.waitFor(()=>expect(finishMaintenance).toBeTypeOf("function"));
    expect(await scheduler.tick()).toBe(true);
    expect(maintenanceDone).toBe(false);
    expect(calls.some(url=>url.endsWith("/k8s_finish_dispatch_v2"))).toBe(true);
    expect(calls.some(url=>url.endsWith("/k8s_finish_maintenance"))).toBe(false);
    finishMaintenance!();
    expect(await maintenance).toBe(true);
  });

  it("awaits an active maintenance tick during shutdown and emits only fixed errors", async () => {
    const stop=new AbortController();let release: (()=>void) | undefined;
    const tick=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});throw Error("private error");});
    const report=vi.fn();let done=false;
    const running=runMaintenanceScheduler({maintenanceTick:tick},stop.signal,report).then(()=>{done=true;});
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));stop.abort();
    expect(done).toBe(false);release!();await running;
    expect(tick).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledExactlyOnceWith("scheduler_maintenance_pending");
  });

  it.each([{}, {data:{claimed:true}}, {data:{maintenance:false}}])("requires explicit maintenance completion, not any HTTP200: %j", async value => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(lease))
      .mockResolvedValueOnce(json(value)).mockResolvedValueOnce(json(true));
    expect(await new DurableScheduler(config,fetcher).maintenanceTick()).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({succeeded:false});
  });
});
