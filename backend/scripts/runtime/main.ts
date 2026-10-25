import { createApiHandler } from "../../supabase/functions/api/handler.ts";
import { createWorkerHandler } from "../../supabase/functions/worker/handler.ts";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway.ts";
import { Backend, environment } from "../../supabase/functions/_shared/backend.ts";
import { DurableScheduler, runScheduler } from "./scheduler.ts";

interface RuntimeDeno {
  env: { get(name: string): string | undefined };
  resolveDns(host: string, type: "A"): Promise<string[]>;
  addSignalListener(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  serve(options: { hostname: string; port: number; onListen(): void },
    handler: (request: Request) => Response | Promise<Response>):
      { finished: Promise<void>; shutdown(): Promise<void> };
}
const runtime = (globalThis as unknown as { Deno: RuntimeDeno }).Deno;
const get = (name: string) => runtime.env.get(name);
const service = get("APP_RUNTIME_SERVICE") || "";
if (!["api", "worker", "source-browser", "scheduler"].includes(service))
  throw Error("RUNTIME_SERVICE_INVALID");
const port = Number(get("PORT") || "8080");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("RUNTIME_PORT_INVALID");
const env = environment(get);
if (!env.url || !env.publishableKey || !env.serviceKey) throw Error("RUNTIME_CONFIGURATION_MISSING");
if ((service === "worker" || service === "scheduler") && !env.workerSecret)
  throw Error("RUNTIME_WORKER_SECRET_MISSING");
const handlers = {
  api: () => createApiHandler(env),
  worker: () => createWorkerHandler(env, (host) => runtime.resolveDns(host, "A"),
    () => new Backend(env, 130000)),
  "source-browser": () => createBrowserGateway(env),
  scheduler: () => (_request: Request) => new Response(null, { status: 404 }),
};
const handler = handlers[service as keyof typeof handlers]();
const stopping = new AbortController();
let draining = false;
const server = runtime.serve({ hostname: "0.0.0.0", port,
  onListen: () => console.info(JSON.stringify({ component: service, status: "listening" })) },
  (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" || path === "/readyz") {
      return new Response(JSON.stringify({ status: draining ? "draining" : "ready", component: service }),
        { status: draining ? 503 : 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (draining) return new Response(null, { status: 503 });
    return handler(request);
  });
const scheduler = service === "scheduler" && get("APP_SCHEDULER_ENABLED") === "true"
  ? runScheduler(new DurableScheduler({ gatewayUrl: env.url, serviceKey: env.serviceKey,
      workerSecret: env.workerSecret, workerUrl: get("APP_WORKER_URL") || "http://worker:8080/functions/v1/worker" }),
    stopping.signal, (code) => console.warn(code))
  : Promise.resolve();
const stop = () => {
  if (draining) return;
  draining = true;
  stopping.abort();
  // Drain active API/worker requests; never exit immediately after a 202.
  void server.shutdown();
};
runtime.addSignalListener("SIGTERM", stop);
runtime.addSignalListener("SIGINT", stop);
await Promise.all([server.finished, scheduler]);
