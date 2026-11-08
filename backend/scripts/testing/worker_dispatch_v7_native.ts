/** Offline synthetic RPC fixtures around the image's actual runtime entrypoints.
 * The worker is the container's unmodified default process. The scheduler is a
 * child using the exact image Cmd. No product source or global fetch is replaced.
 */
interface NativeChild {
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  status: Promise<{ success: boolean }>;
}
interface NativeRuntime {
  env: { get(name: string): string | undefined };
  version: { deno: string; v8: string; typescript: string };
  readDir(path: string): AsyncIterable<{ name: string; isDirectory: boolean; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  Command: new (path: string, options: unknown) => { spawn(): NativeChild };
  serve(options: { hostname: string; port: number; onListen(): void },
    handler: (request: Request) => Promise<Response>): { shutdown(): Promise<void> };
}
const runtime = (globalThis as unknown as { Deno: NativeRuntime }).Deno;
const secret = "native-fixture-worker";
const worker = "http://127.0.0.1:8080/functions/v1/worker";
const checks: Record<string, boolean> = {};
const timings: Record<string, number> = {};
const calls: string[] = [];
const finishes: Record<string, unknown>[] = [];
const unexpected: string[] = [];
let readyJob = false;
let failClaim = false;
let maintenanceEntered = 0;
let maintenanceFinished = 0;
let releaseMaintenance: (() => void) | undefined;
let maintenanceHold: Promise<void> | undefined;
let dispatchGeneration = 0;
let dispatchOutstanding = false;
let schedulerStarted = false;
let maintenanceClaimed = false;
let scheduler: NativeChild | undefined;
const lease = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, code: string, milliseconds = 7000) {
  const end = performance.now() + milliseconds;
  while (!predicate()) {
    assert(performance.now() < end, code);
    await pause(20);
  }
}
function holdMaintenance() {
  maintenanceHold = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
}
function unblockMaintenance() {
  releaseMaintenance?.();
  releaseMaintenance = undefined;
  maintenanceHold = undefined;
}
async function request(path = "", authorization: string | null = secret) {
  return await fetch(worker + path, {
    method: "POST", headers: authorization === null ? {} : { "x-worker-secret": authorization },
    body: "{}", signal: AbortSignal.timeout(2500),
  });
}
async function foreground(name: string) {
  const started = performance.now();
  const response = await request();
  const body = await response.json();
  timings[name] = Math.round(performance.now() - started);
  assert(response.status === 200, `${name}_STATUS`);
  // The fixture explicitly advertises a 30-second future poll. A 2.5-second
  // request ceiling detects the old sleeping path without waiting 30 seconds.
  assert(timings[name] < 2000, `${name}_NOT_PROMPT`);
  return body;
}

const gateway = runtime.serve({ hostname: "127.0.0.1", port: 8081, onListen() {} }, async (request) => {
  const name = new URL(request.url).pathname.replace("/rest/v1/rpc/", "");
  calls.push(name);
  if (request.headers.get("apikey") !== "native-fixture-service" ||
      request.headers.get("authorization") !== "Bearer native-fixture-service") {
    unexpected.push("RPC_AUTHORIZATION");
    return json({ message: "synthetic authorization denied" }, 401);
  }
  const body = await request.json();
  switch (name) {
    case "claim_backend_job_v7":
      if (failClaim) {
        failClaim = false;
        return json({ message: "synthetic transient failure", code: "P0001" }, 503);
      }
      if (!readyJob) return json(null);
      readyJob = false;
      return json({ id: jobId, lease_token: lease, type: "native_fixture_unsupported" });
    case "finish_backend_job":
      assert(body.job_id === jobId && body.lease === lease &&
        body.result_status === "blocked", "FIXTURE_JOB_COMPLETION_INVALID");
      return json(null);
    case "claim_backend_local_job_v7": return json(null);
    case "wake_backend_queue_status_v7":
      return json({ dispatched: false, retry_after_ms: 30000,
        wait_kind: "accepted_remote_poll", job_revision: 1 });
    case "maintenance_tick":
      maintenanceEntered++;
      await maintenanceHold;
      return json(null);
    case "schedule_assessment_refresh":
    case "automation_notification_tick": return json(null);
    case "claim_notification_delivery":
    case "claim_abandoned_model_request": return json(null);
    case "claim_storage_cleanup": return json([]);
    case "k8s_claim_dispatch":
      if (!schedulerStarted || dispatchOutstanding || dispatchGeneration >= 3) return json(null);
      dispatchOutstanding = true;
      dispatchGeneration++;
      // The synthetic gateway supplies three leases: ready, failed, retried.
      // Real SQL due-time/exclusive-lease behavior is tested separately.
      readyJob = dispatchGeneration === 1;
      failClaim = dispatchGeneration === 2;
      return json({ lease, generation: dispatchGeneration });
    case "k8s_finish_dispatch_v2":
      assert(body.dispatch_lease === lease && body.dispatch_generation === dispatchGeneration &&
        dispatchOutstanding, "DISPATCH_COMPLETION_IDENTITY_INVALID");
      finishes.push(body);
      dispatchOutstanding = false;
      return json(true);
    case "k8s_claim_maintenance":
      if (!schedulerStarted || maintenanceClaimed) return json(null);
      maintenanceClaimed = true;
      return json({ lease, generation: 1 });
    case "k8s_finish_maintenance":
      assert(body.dispatch_lease === lease && body.dispatch_generation === 1 &&
        body.succeeded === true, "MAINTENANCE_COMPLETION_INVALID");
      maintenanceFinished++;
      return json(true);
    default:
      unexpected.push(name);
      return json({ message: "unknown fixture RPC", code: "P0001" }, 404);
  }
});

async function sourceHashes() {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    for await (const entry of runtime.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile) {
        const digest = await crypto.subtle.digest("SHA-256", await runtime.readFile(child));
        result[child.replace(/^\/app\//, "")] = Array.from(new Uint8Array(digest))
          .map((value) => value.toString(16).padStart(2, "0")).join("");
      } else throw new Error("COPIED_SOURCE_NONREGULAR");
    }
  }
  for (const path of ["/app/backend/supabase/functions", "/app/backend/scripts/runtime",
    "/app/frontend/public/fonts"]) await visit(path);
  for (const name of ["renderDocx.ts", "docxTableStream.ts"]) {
    const path = `/app/frontend/src/lib/${name}`;
    const digest = await crypto.subtle.digest("SHA-256", await runtime.readFile(path));
    result[path.replace(/^\/app\//, "")] = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

try {
  const beforeAuth = calls.length;
  for (const path of ["", "/maintenance"]) {
    for (const authorization of [null, "incorrect-fixture-secret"]) {
      const response = await request(path, authorization);
      assert(response.status === 401, "WORKER_AUTHENTICATION_FAILED");
      await response.body?.cancel();
    }
  }
  assert(calls.length === beforeAuth, "UNAUTHORIZED_REQUEST_TOUCHED_BACKEND");
  checks.worker_authentication = true;
  checks.worker_foreground_maintenance_auth_no_rpc = true;

  const idle = await foreground("idle_ms");
  assert(idle.data?.claimed === false && calls.every((name) => name === "claim_backend_job_v7"),
    "IDLE_WORKER_RAN_MAINTENANCE");
  checks.worker_idle_prompt = true;

  holdMaintenance();
  let directMaintenanceReturned = false;
  const directMaintenance = request("/maintenance").then(async (response) => {
    const body = await response.json();
    assert(response.status === 200 && body.data?.maintenance === true, "DIRECT_MAINTENANCE_FAILED");
    directMaintenanceReturned = true;
  });
  await until(() => maintenanceEntered === 1, "MAINTENANCE_DID_NOT_START");
  readyJob = true;
  const ready = await foreground("ready_while_maintenance_held_ms");
  assert(ready.data?.claimed === true && ready.data?.job_id === jobId &&
    ready.data?.status === "blocked", "READY_RESPONSE_INVALID");
  assert(ready.queue_retry_after_ms === 30000, "POLL_DELAY_NOT_RETURNED");
  assert(!directMaintenanceReturned, "MAINTENANCE_NOT_HELD_DURING_READY_RESPONSE");
  checks.worker_ready_response_before_maintenance = true;
  checks.worker_poll_delay_returned_without_sleep = true;
  const idleHeld = await foreground("idle_while_maintenance_held_ms");
  assert(idleHeld.data?.claimed === false && !directMaintenanceReturned, "IDLE_HELD_BY_MAINTENANCE");
  unblockMaintenance();
  await directMaintenance;

  holdMaintenance();
  schedulerStarted = true;
  const command: unknown = JSON.parse(runtime.env.get("NATIVE_IMAGE_CMD") || "null");
  assert(Array.isArray(command) && command.every((item) => typeof item === "string") &&
    command.at(-1) === "scripts/runtime/main.ts" && command[0] === "run", "IMAGE_CMD_INVALID");
  scheduler = new runtime.Command("/bin/deno", {
    args: command as string[], cwd: "/app/backend", stdout: "null", stderr: "null",
    env: { APP_RUNTIME_SERVICE: "scheduler", APP_SCHEDULER_ENABLED: "true",
      APP_WORKER_URL: worker, PORT: "8083" },
  }).spawn();
  await until(() => maintenanceEntered === 2 && finishes.length === 3, "SCHEDULER_DISPATCH_STALLED");
  assert(maintenanceFinished === 0 && !!releaseMaintenance, "SCHEDULER_MAINTENANCE_NOT_HELD");
  checks.scheduler_maintenance_independent = true;
  assert(finishes[0].succeeded === true && finishes[0].continue_work === true &&
    finishes[0].wake_after_ms === 30000, "SCHEDULER_SUCCESS_METADATA_INVALID");
  assert(finishes[2].succeeded === true && finishes[2].continue_work === false &&
    finishes[2].wake_after_ms === null, "SCHEDULER_IDLE_METADATA_INVALID");
  checks.scheduler_completion_metadata = true;
  assert(finishes[1].succeeded === false && finishes[1].continue_work === false &&
    finishes[1].wake_after_ms === null && dispatchGeneration === 3, "SCHEDULER_FAILURE_RETRY_INVALID");
  checks.scheduler_failure_retry = true;
  unblockMaintenance();
  await until(() => maintenanceFinished === 1, "SCHEDULER_MAINTENANCE_NOT_COMPLETED");
  scheduler.kill("SIGTERM");
  const status = await Promise.race([scheduler.status, pause(3000).then(() => {
    throw new Error("SCHEDULER_SHUTDOWN_NOT_DRAINED");
  })]);
  assert(status.success, "SCHEDULER_SHUTDOWN_FAILED");
  scheduler = undefined;
  checks.shutdown_drained = true;
  assert(unexpected.length === 0, "UNEXPECTED_RPC_OR_EXTERNAL_ROUTE");
  const workerRpcNames = [...new Set(calls.filter(name =>
    name.startsWith("claim_backend_") || name.startsWith("wake_backend_queue_status")))].sort();
  assert(JSON.stringify(workerRpcNames) === JSON.stringify([
    "claim_backend_job_v7", "claim_backend_local_job_v7", "wake_backend_queue_status_v7",
  ]), "WORKER_EXECUTOR7_RPC_PATHS_MISSING_OR_LEGACY");
  checks.worker_executor7_rpc_paths = true;
  console.log(JSON.stringify({ version: 1, passed: true, checks, timings_ms: timings,
    source_sha256: await sourceHashes(), scheduler_completions: finishes,
    rpc_count: calls.length, unexpected_rpc_count: unexpected.length,
    rpc_names: [...new Set(calls)].sort(), worker_rpc_names: workerRpcNames,
    scheduler_image_cmd: command,
    provider_calls: 0, runtime: runtime.version,
    scope: "Default image worker and exact Cmd scheduler child; synthetic loopback RPC gateway. " +
      "Unsupported synthetic job completion plus accepted-poll wake hint, no model generation. " +
      "SQL due-time, lease exclusion and restart durability require separate PostgreSQL tests." }));
} finally {
  unblockMaintenance();
  if (scheduler) {
    try { scheduler.kill("SIGKILL"); } catch { /* Already stopped. */ }
    await scheduler.status;
  }
  await gateway.shutdown();
}
