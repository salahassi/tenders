import { environment } from "../_shared/backend.ts";
import { createBrowserGateway } from "../_shared/browserGateway.ts";
Deno.serve(createBrowserGateway(environment((name) => Deno.env.get(name))));
