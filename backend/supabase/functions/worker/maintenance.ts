import type { Backend, BackendEnvironment } from "../_shared/backend.ts";
import { FreeModelProvider, ModelError } from "../_shared/model.ts";
import {
  processNotificationEmail,
  smtpStatus,
} from "../_shared/notifications.ts";

export type MaintenanceOperation =
  | "maintenance_tick"
  | "assessment_scheduling"
  | "notification_delivery"
  | "usage_reconciliation"
  | "storage_cleanup";

// These operations retain their database leases, retry records and transactional
// guards. Their failure must not turn unrelated, committed business work into a
// failed dispatch. Only fixed operation names leave this boundary: exception
// messages can contain private provider responses, credentials or document text.
export async function runWorkerMaintenance(
  backend: Backend,
  env: BackendEnvironment,
  fetcher: typeof fetch,
): Promise<MaintenanceOperation[]> {
  const pending = new Set<MaintenanceOperation>();
  const record = (operation: MaintenanceOperation) => {
    if (!pending.has(operation))
      console.warn("worker_maintenance_pending", operation);
    pending.add(operation);
  };
  const attempt = async (
    operation: MaintenanceOperation,
    work: () => Promise<unknown>,
  ) => {
    try {
      await work();
    } catch {
      record(operation);
    }
  };

  await attempt("maintenance_tick", () => backend.internal("maintenance_tick"));
  await attempt("assessment_scheduling", () =>
    backend.internal("schedule_assessment_refresh"),
  );
  await attempt("notification_delivery", async () => {
    const transport = smtpStatus(env);
    if (!transport.configured)
      console.warn("smtp_configuration_incomplete", transport.issues.join(","));
    await backend.internal("automation_notification_tick", {
      transport_ready: transport.configured,
    });
    await processNotificationEmail(backend, env);
  });

  // Reconcile an already accepted request; never send fresh model input or
  // publish a late result into a canceled/superseded generation plan.
  await attempt("usage_reconciliation", async () => {
    const abandoned = await backend.internal("claim_abandoned_model_request");
    if (!abandoned) return;
    const providerId = abandoned.provider || "gemini_free";
    const model = abandoned.connection_id
      ? backend.resolveModelEnvironment({ ...abandoned, provider: providerId })
      : env.models[providerId as keyof typeof env.models];
    if (
      !model?.key ||
      model.model !== abandoned.model ||
      (abandoned.project_ref && model.projectRef !== abandoned.project_ref)
    ) {
      record("usage_reconciliation");
      return;
    }
    try {
      const provider = new FreeModelProvider(model, fetcher, 20000);
      const result = await provider.pollBackground(abandoned.remote_request_id);
      if (result.id !== abandoned.remote_request_id) {
        record("usage_reconciliation");
        return;
      }
      if (["queued", "in_progress"].includes(result.status)) return;
      const { usage } = provider.backgroundResult(result);
      const terminated = ["failed", "cancelled", "canceled"].includes(
        result.status,
      );
      if (terminated || (usage.input !== null && usage.output !== null))
        await backend.internal("settle_model_call", {
          reservation: abandoned.id,
          actual_input: usage.input,
          actual_output: usage.output,
          thinking: usage.thinking,
          error_code: terminated
            ? "PROVIDER_BACKGROUND_TERMINATED"
            : ["canceled", "blocked", "failed"].includes(abandoned.job_status)
              ? "SUPERSEDED_RESULT_RECONCILED"
              : "ACCEPTED_RESULT_RECONCILED",
        });
      else record("usage_reconciliation");
    } catch (error) {
      record("usage_reconciliation");
      if (
        error instanceof ModelError &&
        error.code === "PROVIDER_BACKGROUND_RETRIEVAL_FAILED"
      )
        await backend.internal("settle_model_call", {
          reservation: abandoned.id,
          actual_input: null,
          actual_output: null,
          thinking: null,
          error_code: error.code,
        });
      // Retain unknown usage. The next maintenance invocation may GET the same
      // accepted identity; a timeout never asserts zero usage or resends a POST.
    }
  });

  await attempt("storage_cleanup", async () => {
    const cleanup = await backend.internal("claim_storage_cleanup");
    if (!Array.isArray(cleanup)) {
      record("storage_cleanup");
      return;
    }
    for (const item of cleanup) {
      if (
        !item ||
        ![item.id, item.lease_token, item.storage_key].every(
          (value) => typeof value === "string" && value.length > 0,
        )
      ) {
        record("storage_cleanup");
        continue;
      }
      // Isolate each item, including its completion RPC. One failed receipt
      // must not abandon the rest of this already leased cleanup batch.
      await attempt("storage_cleanup", async () => {
        let succeeded = false;
        try {
          await backend.removeObject(item.storage_key);
          succeeded = true;
        } catch {
          record("storage_cleanup");
        }
        await backend.internal("complete_storage_cleanup", {
          cleanup_id: item.id,
          lease: item.lease_token,
          succeeded,
        });
      });
    }
  });
  // Cron retries failed transactions and existing leased/failed cleanup and
  // receipt records. No success flag, accounting value or capacity is invented.
  return [...pending];
}
