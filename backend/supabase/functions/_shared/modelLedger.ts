import type { Backend, BackendEnvironment } from "./backend.ts";
import { parseModelPool, type Ledger } from "./model.ts";
import { ROUND_ROBIN_PROVIDERS } from "./modelProviders.ts";

export function modelLedger(
  backend: Backend,
  job: { id: string; lease_token: string; attempts: number },
  prefix: string,
  environments?: BackendEnvironment["models"],
): Ledger {
  const identity = { job_id: job.id, lease: job.lease_token };
  return {
    preflight: async (manifest) => {
      if (environments)
        await backend.internal("prepare_model_routing", {
          ...identity,
          server_models: ROUND_ROBIN_PROVIDERS.map((provider) => ({
            provider,
            model: environments[provider]?.model || "",
            project_ref: environments[provider]?.projectRef || "",
            key_configured: Boolean(environments[provider]?.key),
            free_tier_confirmed:
              environments[provider]?.freeTierConfirmed === true,
          })),
        });
      return parseModelPool(
        await backend.internal("model_preflight", { ...identity, manifest }),
      );
    },
    attempt: async (provider_id, result_code, sent) => {
      await backend.internal("record_model_attempt", {
        ...identity,
        provider_id,
        result_code,
        sent,
      });
    },
    reserve: async (
      input_tokens,
      output_tokens,
      input_hash,
      manifest,
      target_provider,
    ) =>
      (
        await backend.internal("reserve_model_call", {
          ...identity,
          call_key: `${prefix}:attempt:${job.attempts}:${target_provider}`,
          input_tokens,
          output_tokens,
          input_hash,
          manifest,
          target_provider,
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
    resume: (target_provider, input_hash, manifest) =>
      backend.internal("resume_model_request", {
        ...identity,
        target_provider,
        input_hash,
        manifest,
      }),
    checkpoint: async (reservation, remote_id) => {
      await backend.internal("checkpoint_model_request", {
        ...identity,
        reservation,
        remote_id,
      });
    },
    defer: async (reservation, retry_after) => {
      await backend.internal("defer_model_request", {
        ...identity,
        reservation,
        retry_after: retry_after || null,
      });
    },
  };
}
