import { Backend, type BackendEnvironment } from "./backend.ts";
import { ModelError, ModelDeferred } from "./model.ts";

import { executeGuardedModel } from "./modelGraph.ts";

/** A bounded operational check, with no customer content or fabricated business records. */
export async function processModelProbe(
  backend: Backend,
  env: BackendEnvironment,
  job: { id: string; lease_token: string; attempts: number },
  fetcher: typeof fetch,
) {
  try {
    const outcome = await executeGuardedModel({
      backend,
      job,
      prefix: `probe:${job.id}`,
      task: "connection_probe",
      context: {
        purpose: "Verify the TenderDesk model connection. Return status ready.",
        check_id: job.id,
      },
      evidence: [],
      requiredIds: [],
      manifest: [],
      environments: env.models,
      language: "en",
      repair: false,
      fetcher,
    });
    if (outcome.threadId)
      await backend.internal("complete_model_probe_graph", {
        job_id: job.id,
        lease: job.lease_token,
        thread_id: outcome.threadId,
        result: outcome.result,
      });
    else await backend.finish(job.id, job.lease_token, "succeeded", null);
    await outcome
      .cleanup?.()
      .catch(() => console.warn("provider_request_cleanup_pending"));
  } catch (error) {
    if (error instanceof ModelDeferred) return;
    await backend.internal("fail_generation", {
      job_id: job.id,
      lease: job.lease_token,
      error_code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "MODEL_PROBE_FAILED",
      retry_after: error instanceof ModelError ? error.retryAfter : null,
      split_inputs: null,
    });
  }
}
