import { environment } from "../_shared/backend.ts";
import { createWorkerHandler } from "./handler.ts";
const env = environment((name) => Deno.env.get(name));
Deno.serve(
  createWorkerHandler(env, (hostname) => Deno.resolveDns(hostname, "A")),
);
