import { Backend, type BackendEnvironment } from "./backend.ts";
import { executeModel, ModelError, parseModelPool } from "./model.ts";

/** A bounded operational check, with no customer content or fabricated business records. */
export async function processModelProbe(
  backend: Backend,
  env: BackendEnvironment,
  job: { id: string; lease_token: string; attempts: number },
  fetcher: typeof fetch,
) {
  try {
    await executeModel(
      "connection_probe",
      {
        purpose: "Verify the TenderDesk model connection. Return status ready.",
      },
      [],
      [],
      [],
      env.models,
      {
        preflight: async (manifest) =>
          parseModelPool(
            await backend.internal("model_preflight", {
              job_id: job.id,
              lease: job.lease_token,
              manifest,
            }),
          ),
        reserve: async (
          input_tokens,
          output_tokens,
          input_hash,
          manifest,
          provider,
        ) =>
          (
            await backend.internal("reserve_model_call", {
              job_id: job.id,
              lease: job.lease_token,
              call_key: `probe:${job.id}:attempt:${job.attempts}:${provider}`,
              input_tokens,
              output_tokens,
              input_hash,
              manifest,
              target_provider: provider,
            })
          ).id,
        settle: async (reservation, usage, error_code) => {
          await backend.internal("settle_model_call", {
            reservation,
            actual_input: usage.input,
            actual_output: usage.output,
            thinking: usage.thinking,
            error_code: error_code || null,
          });
        },
      },
      "en",
      false,
      fetcher,
    );
    await backend.finish(job.id, job.lease_token, "succeeded", null);
  } catch (error) {
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
