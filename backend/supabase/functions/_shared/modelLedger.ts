import type { Backend, BackendEnvironment } from "./backend.ts";
import { parseModelPool, type Ledger } from "./model.ts";
import { ROUND_ROBIN_PROVIDERS } from "./modelProviders.ts";
import { defaultCapabilities, taskRegistry } from "./modelContract.ts";

export function modelLedger(
  backend: Backend,
  job: { id: string; lease_token: string; attempts: number },
  prefix: string,
  environments?: BackendEnvironment["models"],
  routeTask?: keyof typeof taskRegistry,
): Ledger {
  const identity = { job_id: job.id, lease: job.lease_token };
  let version = 1;
  let currentAttempt: string | undefined;
  return {
    environment: (config) =>
      backend.resolveModelEnvironment?.(config) ??
      (config.connection_id && environments?.[config.provider]
        ? {
            ...environments[config.provider],
            model: config.model,
            projectRef: config.project_ref,
          }
        : environments?.[config.provider]),
    invocationStartedAt: backend.invocationStartedAt,
    invocationBudgetMs: backend.invocationBudgetMs,
    backgroundAllowed: (config) =>
      backend.internal("model_background_allowed", {
        ...identity,
        target_provider: config.provider,
        target_model: config.model,
        target_project: config.project_ref,
        target_connection: config.connection_id ?? null,
        target_configuration: config.model_config_id ?? null,
      }),
    reasoningAllowed: (config, transport, level) =>
      backend.internal("model_reasoning_allowed", {
        ...identity,
        target_provider: config.provider,
        target_model: config.model,
        target_project: config.project_ref,
        target_connection: config.connection_id ?? null,
        target_configuration: config.model_config_id ?? null,
        target_transport: transport,
        target_level: level,
      }),
    requestPrepared: async (request) => {
      if (version !== 2 || !currentAttempt) return;
      await backend.internal("record_model_request_metadata", {
        attempt_id: currentAttempt,
        lease: job.lease_token,
        metadata: {
          contract_version: request.contractVersion,
          schema_version: request.schemaVersion,
          prompt_version: request.promptVersion,
          input_hash: request.inputHash,
          route_revision: request.routeRevision,
          profile: request.profile,
          capabilities: request.capabilities,
          ...(request.reasoningControl
            ? { reasoning_control: request.reasoningControl }
            : {}),
        },
      });
    },
    loadRound: (input_hash) =>
      backend.internal("load_model_round", { ...identity, input_hash }),
    saveRound: async (progress, release_job) => {
      await backend.internal(
        version === 2 ? "save_task_model_round" : "save_model_round",
        {
          ...identity,
          progress,
          release_job,
        },
      );
    },
    beginAttempt: async (
      provider_id,
      model_name,
      project_name,
      operation_name,
      config,
    ) => {
      currentAttempt = String(
        await backend.internal(
          config?.model_config_id
            ? "start_task_model_attempt"
            : "start_model_attempt",
          config?.model_config_id
            ? {
                ...identity,
                target_model: config.model_config_id,
                target_connection: config.connection_id,
                operation_name,
              }
            : {
                ...identity,
                provider_id,
                model_name,
                project_name,
                operation_name,
              },
        ),
      );
      return currentAttempt;
    },
    endAttempt: async (attempt_id, result_code, sent, usage_id, metadata) => {
      await backend.internal("finish_model_attempt", {
        attempt_id,
        lease: job.lease_token,
        result_code,
        sent,
        usage_id,
        metadata,
      });
    },
    preflight: async (manifest, task) => {
      if (environments) {
        await backend.internal("import_model_catalog", {
          ...identity,
          server_models: ROUND_ROBIN_PROVIDERS.map((provider) => ({
            provider,
            model: environments[provider]?.model || "",
            project_ref: environments[provider]?.projectRef || "",
            key_configured: Boolean(environments[provider]?.key),
            capabilities: defaultCapabilities(provider),
          })),
        });
        if (task)
          version = (await backend.internal("prepare_task_model_route", {
            ...identity,
            task_name: task,
            default_profile: taskRegistry[task].profile,
            ...(routeTask
              ? {
                  route_task: routeTask,
                  default_profile: taskRegistry[routeTask].profile,
                }
              : {}),
          }))
            ? 2
            : 1;
      }
      if (environments && version === 1)
        await backend.internal("prepare_model_routing", {
          ...identity,
          server_models: ROUND_ROBIN_PROVIDERS.map((provider) => ({
            provider,
            model: environments[provider]?.model || "",
            project_ref: environments[provider]?.projectRef || "",
            key_configured: Boolean(environments[provider]?.key),
          })),
        });
      const pool = parseModelPool(
        await backend.internal(
          version === 2 ? "task_model_preflight" : "model_preflight",
          { ...identity, manifest },
        ),
      );
      if (pool.routing_mode === "round_robin") {
        const windows = (await backend.internal(
          version === 2 ? "task_model_retry_windows" : "model_retry_windows",
          identity,
        )) as {
          provider: string;
          model: string;
          project_ref: string;
          retry_after: string;
          model_config_id?: string;
          connection_id?: string;
        }[];
        pool.providers = pool.providers.map((p) => ({
          ...p,
          retry_after: windows.find((w) =>
            version === 2
              ? w.model_config_id === p.model_config_id &&
                w.connection_id === p.connection_id
              : w.provider === p.provider &&
                w.model === p.model &&
                w.project_ref === p.project_ref,
          )?.retry_after,
        }));
      }
      return pool;
    },
    attempt: async (provider_id, result_code, sent, config) => {
      await backend.internal(
        config?.model_config_id
          ? "record_task_model_attempt"
          : "record_model_attempt",
        config?.model_config_id
          ? {
              ...identity,
              target_model: config.model_config_id,
              result_code,
              sent,
            }
          : {
              ...identity,
              provider_id,
              result_code,
              sent,
            },
      );
    },
    reserve: async (
      input_tokens,
      output_tokens,
      input_hash,
      manifest,
      target_provider,
      config,
    ) =>
      (
        await backend.internal(
          config?.model_config_id
            ? "reserve_task_model_call"
            : "reserve_model_call",
          {
            ...identity,
            call_key: config?.model_config_id
              ? `${prefix}:${input_hash.slice(0, 16)}:${job.attempts}:${config.model_config_id}`
              : `${prefix}:attempt:${job.attempts}:${target_provider}`,
            input_tokens,
            output_tokens,
            input_hash,
            manifest,
            ...(config?.model_config_id
              ? {
                  target_model: config.model_config_id,
                  target_connection: config.connection_id,
                }
              : { target_provider }),
          },
        )
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
    resume: (target_provider, input_hash, manifest, config) =>
      backend.internal(
        config?.model_config_id
          ? "resume_task_model_request_phase"
          : "resume_model_request",
        {
          ...identity,
          ...(config?.model_config_id
            ? {
                target_model: config.model_config_id,
                target_connection: config.connection_id,
                request_prefix: prefix,
              }
            : { target_provider }),
          input_hash,
          manifest,
        },
      ),
    checkpoint: async (reservation, remote_id) => {
      await backend.internal("checkpoint_model_request", {
        ...identity,
        reservation,
        remote_id,
      });
    },
    defer: async (reservation, retry_after, healthyPoll) => {
      await backend.internal(
        healthyPoll ? "defer_pending_model_request" : "defer_model_request",
        {
          ...identity,
          reservation,
          ...(!healthyPoll ? { retry_after: retry_after || null } : {}),
        },
      );
    },
  };
}
