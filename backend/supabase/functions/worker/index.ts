import { Backend, environment } from "../_shared/backend.ts";
import { secretMatches } from "../_shared/http.ts";
const env = environment((name) => Deno.env.get(name));
Deno.serve(async (request: Request) => {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (request.method !== "POST")
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers,
    });
  if (
    !(await secretMatches(
      request.headers.get("x-worker-secret") || "",
      env.workerSecret,
    ))
  )
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers,
    });
  try {
    const backend = new Backend(env),
      job = await backend.claim();
    if (!job)
      return new Response(JSON.stringify({ data: { claimed: false } }), {
        headers,
      });
    // No model adapter or source collector is represented as active in M2.
    // Claims/leases/heartbeats are real; unavailable handlers remain blocked.
    await backend.finish(
      job.id,
      job.lease_token,
      "blocked",
      job.type.startsWith("source_")
        ? "SOURCE_ADAPTER_NOT_CONFIGURED"
        : "MODEL_NOT_CONFIGURED",
    );
    return new Response(
      JSON.stringify({ data: { job_id: job.id, status: "blocked" } }),
      { headers },
    );
  } catch {
    return new Response(JSON.stringify({ error: "DISPATCH_FAILED" }), {
      status: 503,
      headers,
    });
  }
});
