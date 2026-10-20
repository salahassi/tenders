import { Backend, environment } from "../_shared/backend.ts";
import { createWorkerHandler } from "./handler.ts";
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };
const env = environment((name) => Deno.env.get(name));
Deno.serve(
  createWorkerHandler(
    env,
    (hostname) => Deno.resolveDns(hostname, "A"),
    () => new Backend(env, 130000),
    fetch,
    (task) => EdgeRuntime.waitUntil(task),
  ),
);
