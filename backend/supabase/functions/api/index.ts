import { environment } from "../_shared/backend.ts";
import { createApiHandler } from "./handler.ts";
Deno.serve(createApiHandler(environment((name) => Deno.env.get(name))));
