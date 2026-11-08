/** Relay durable database wake requests to the authenticated persistent worker.
 * Business job admission, leases and idempotency remain in existing RPCs.
 */
export interface DispatchLease {
  lease: string;
  generation: number;
}
export interface SchedulerConfig {
  gatewayUrl: string;
  serviceKey: string;
  workerUrl: string;
  workerSecret: string;
}

export function validateLease(value: unknown): DispatchLease | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw Error("DISPATCH_LEASE_INVALID");
  const lease = value as Record<string, unknown>;
  if (
    typeof lease.lease !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(lease.lease) ||
    typeof lease.generation !== "number" ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1
  ) throw Error("DISPATCH_LEASE_INVALID");
  return { lease: lease.lease, generation: lease.generation };
}

export function validateSchedulerConfig(config: SchedulerConfig): SchedulerConfig {
  const gateway = new URL(config.gatewayUrl);
  const worker = new URL(config.workerUrl);
  for (const url of [gateway, worker]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) throw Error("DISPATCH_URL_INVALID");
  }
  if (gateway.pathname !== "/" || worker.pathname !== "/functions/v1/worker" ||
    !config.serviceKey || !config.workerSecret) throw Error("DISPATCH_CONFIGURATION_MISSING");
  return { ...config, gatewayUrl: gateway.origin };
}

export class DurableScheduler {
  private readonly config: SchedulerConfig;
  constructor(config: SchedulerConfig, private readonly fetcher: typeof fetch = fetch) {
    this.config = validateSchedulerConfig(config);
  }

  private async rpc(name: string, body: Record<string, unknown>) {
    const response = await this.fetcher(`${this.config.gatewayUrl}/rest/v1/rpc/${name}`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", apikey: this.config.serviceKey,
        Authorization: `Bearer ${this.config.serviceKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("DISPATCH_DATABASE_UNAVAILABLE");
    return response.json() as Promise<unknown>;
  }

  async tick(): Promise<boolean> {
    const claim = validateLease(await this.rpc("k8s_claim_dispatch", {}));
    if (!claim) return false;
    let succeeded = false;
    let continueWork = false;
    let wakeAfterMs: number | null = null;
    try {
      const response = await this.fetcher(this.config.workerUrl, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", "x-worker-secret": this.config.workerSecret },
        body: "{}", signal: AbortSignal.timeout(150000),
      });
      // The Kubernetes worker responds after processing, rather than returning
      // 202 while a platform-owned background invocation may disappear.
      if (response.status === 200) {
        const value = await response.json();
        if (!value || typeof value !== "object" || !value.data ||
          typeof value.data.claimed !== "boolean" ||
          (value.queue_retry_after_ms !== undefined &&
            (!Number.isInteger(value.queue_retry_after_ms) || value.queue_retry_after_ms < 1 || value.queue_retry_after_ms > 60000)))
          throw Error("DISPATCH_RESPONSE_INVALID");
        continueWork = value.data.claimed;
        wakeAfterMs = value.queue_retry_after_ms ?? null;
        succeeded = true;
      } else await response.body?.cancel();
    } catch {
      // No raw response or exception is logged: these may contain credentials.
    }
    const acknowledged = await this.rpc("k8s_finish_dispatch_v2", {
      dispatch_lease: claim.lease, dispatch_generation: claim.generation, succeeded,
      continue_work: succeeded && continueWork, wake_after_ms: succeeded ? wakeAfterMs : null,
    });
    if (acknowledged !== true) throw Error("DISPATCH_LEASE_EXPIRED");
    return succeeded;
  }

  async maintenanceTick(): Promise<boolean> {
    const claim = validateLease(await this.rpc("k8s_claim_maintenance", {}));
    if (!claim) return false;
    let succeeded = false;
    try {
      const response = await this.fetcher(`${this.config.workerUrl}/maintenance`, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", "x-worker-secret": this.config.workerSecret },
        body: "{}", signal: AbortSignal.timeout(150000),
      });
      if (response.status === 200) {
        const value = await response.json();
        succeeded = value?.data?.maintenance === true;
      } else await response.body?.cancel();
    } catch { /* Only fixed outcomes leave this boundary. */ }
    const acknowledged = await this.rpc("k8s_finish_maintenance", {
      dispatch_lease: claim.lease, dispatch_generation: claim.generation, succeeded,
    });
    if (acknowledged !== true) throw Error("MAINTENANCE_LEASE_EXPIRED");
    return succeeded;
  }
}

export async function runScheduler(
  scheduler: Pick<DurableScheduler, "tick">,
  signal: AbortSignal,
  report: (code: string) => void,
) {
  await runLoop(() => scheduler.tick(), signal, report, "scheduler_dispatch_pending", 1000);
}

export async function runMaintenanceScheduler(
  scheduler: Pick<DurableScheduler, "maintenanceTick">,
  signal: AbortSignal,
  report: (code: string) => void,
) {
  await runLoop(() => scheduler.maintenanceTick(), signal, report, "scheduler_maintenance_pending", 5000);
}

async function runLoop(tick: () => Promise<boolean>, signal: AbortSignal,
  report: (code: string) => void, code: string, interval: number) {
  while (!signal.aborted) {
    try { await tick(); } catch { report(code); }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, interval);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
