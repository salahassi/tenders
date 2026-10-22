import { z } from "zod";
import { Backend, type BackendEnvironment } from "./backend.ts";
import {
  verifyBrowserIdentity,
  sealSession,
  openSession,
} from "./browserIdentity.ts";
import { readJson } from "./http.ts";
const identity = { request_id: z.uuid(), lease: z.uuid() };
const schemas = {
  claim: z.object({}).strict(),
  complete: z
    .object({
      ...identity,
      page: z.record(z.string(), z.unknown()).nullable(),
      error_code: z.string().nullable(),
    })
    .strict(),
  challenge: z
    .object({ ...identity, image: z.string().max(200000).optional() })
    .strict(),
  session_load: z.object(identity).strict(),
  session_save: z
    .object({
      ...identity,
      state: z
        .object({
          cookies: z.array(z.unknown()).max(500),
          origins: z.array(z.unknown()).max(100),
        })
        .strict(),
    })
    .strict(),
};
export function createBrowserGateway(
  env: BackendEnvironment,
  factory = () => new Backend(env),
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request) => {
    const response = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "POST")
      return response({ error: "METHOD_NOT_ALLOWED" }, 405);
    const token =
      request.headers.get("authorization")?.replace(/^Bearer /i, "") || "";
    if (!(await verifyBrowserIdentity(token, fetcher)))
      return response({ error: "UNAUTHORIZED" }, 401);
    try {
      const input = z
        .object({
          action: z.enum([
            "claim",
            "complete",
            "challenge",
            "session_load",
            "session_save",
          ]),
          payload: z.unknown(),
        })
        .strict()
        .parse(await readJson(request));
      const payload = schemas[input.action].parse(input.payload);
      const backend = factory();
      let data;
      if (input.action === "claim")
        data = await backend.internal("claim_source_browser_page");
      else if (input.action === "complete")
        data = await backend.internal("complete_source_browser_page", payload);
      else if (input.action === "challenge")
        data = await backend.internal("source_browser_challenge", payload);
      else {
        const p = payload as { request_id: string; lease: string; state?: any };
        const args = { request_id: p.request_id, lease: p.lease };
        const scope = await backend.internal("source_browser_identity", args);
        const binding = scope.workspace_id + ":" + scope.host;
        if (input.action === "session_load") {
          const saved = await backend.internal("source_browser_session", args);
          data = saved
            ? ((await openSession(saved, env.serviceKey, binding)) ?? null)
            : null;
        } else
          data = await backend.internal("source_browser_session", {
            ...args,
            sealed_state: await sealSession(p.state, env.serviceKey, binding),
          });
      }
      return response({ data });
    } catch (error) {
      return response(
        {
          error:
            error instanceof z.ZodError
              ? "INVALID_INPUT"
              : "BROWSER_QUEUE_REJECTED",
        },
        error instanceof z.ZodError ? 400 : 409,
      );
    }
  };
}
