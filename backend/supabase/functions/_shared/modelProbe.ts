import { Backend, type BackendEnvironment } from "./backend.ts";
import { executeModel, ModelError, ModelDeferred } from "./model.ts";

import { modelLedger } from "./modelLedger.ts";

/** A bounded operational check, with no customer content or fabricated business records. */
export async function processModelProbe(
  backend: Backend,
  env: BackendEnvironment,
  job: { id: string; lease_token: string; attempts: number },
  fetcher: typeof fetch,
) {
  const ledger = modelLedger(backend, job, `probe:${job.id}`);
  try {
    await executeModel(
      "connection_probe",
      {
        purpose: "Verify the TenderDesk model connection. Return status ready.",
        check_id: job.id,
      },
      [],
      [],
      [],
      env.models,
      ledger,
      "en",
      false,
      fetcher,
    );
    await backend.finish(job.id, job.lease_token, "succeeded", null);
    await ledger
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
