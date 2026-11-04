import { processGeneration } from "../_shared/generation.ts";
import { processDeliveryExport } from "../_shared/deliveryWorker.ts";
import { processAutomaticSource } from "../_shared/automaticSources.ts";
import { processModelProbe } from "../_shared/modelProbe.ts";
import { Backend, type BackendEnvironment } from "../_shared/backend.ts";
import { AppError, secretMatches } from "../_shared/http.ts";
import { wakeReadyQueue } from "./queueWake.ts";
import {
  runWorkerMaintenance,
  type MaintenanceOperation,
} from "./maintenance.ts";
import {
  collect,
  CollectionError,
  type SourceInput,
} from "../_shared/collector.ts";
export function createWorkerHandler(
  env: BackendEnvironment,
  resolve: (hostname: string) => Promise<string[]>,
  factory = () => new Backend(env),
  fetcher: typeof fetch = fetch,
  background?: (task: Promise<void>) => void,
) {
  return async (request: Request): Promise<Response> => {
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    if (request.method !== "POST")
      return response({ error: "METHOD_NOT_ALLOWED" }, 405);
    const supplied = request.headers.get("x-worker-secret") || "";
    if (!supplied) return response({ error: "UNAUTHORIZED" }, 401);
    try {
      const backend = factory();
      const allowed = env.workerSecret
        ? await secretMatches(supplied, env.workerSecret)
        : await backend.internal("verify_dispatcher_secret", { supplied });
      if (!allowed) return response({ error: "UNAUTHORIZED" }, 401);
      const process = async () => {
        let maintenancePending: MaintenanceOperation[] = [];
        let maintenanceRan = false;
        const maintain = async () => {
          if (maintenanceRan) return;
          maintenanceRan = true;
          maintenancePending = await runWorkerMaintenance(
            backend,
            env,
            fetcher,
          );
        };
        const withMaintenance = async (result: Response) => {
          await maintain();
          return maintenancePending.length
            ? response(
                {
                  ...(await result.json()),
                  maintenance_pending: maintenancePending,
                },
                result.status,
              )
            : result;
        };
        // Claim eligible business work before any unrelated housekeeping RPC or
        // provider/storage call. Claim still owns authorization, capacity, due
        // time and exclusive lease checks; maintenance never replaces them.
        let job = await backend.claim();
        if (!job) {
          await maintain();
          // Assessment scheduling/recovery can make work eligible in this tick.
          // One normal re-claim preserves that behavior without draining a loop.
          job = await backend.claim();
          if (!job)
            return withMaintenance(response({ data: { claimed: false } }));
        }
        const processClaimed = async () => {
          if (job.type === "render_delivery") {
            const saved = await processDeliveryExport(backend, job);
            return response({ data: { job_id: job.id, ...saved } });
          }
          if (job.type === "model_probe") {
            await processModelProbe(backend, env, job, fetcher);
            return response({ data: { job_id: job.id, processed: true } });
          }
          if (
            job.type === "source_collect" ||
            job.type === "source_candidates"
          ) {
            if (
              job.type === "source_candidates" &&
              job.checkpoint?.discovery_url
            ) {
              const saved = await processAutomaticSource(
                backend,
                env,
                job,
                resolve,
                fetcher,
              );
              return response({ data: { job_id: job.id, ...saved } });
            }
            try {
              const source = (await backend.internal("collection_context", {
                job_id: job.id,
                lease: job.lease_token,
              })) as SourceInput;
              if (
                source.kind === "link_directory" &&
                (source.adapter_config as Record<string, unknown>)
                  ?.automatic === true
              ) {
                const saved = await processAutomaticSource(
                  backend,
                  env,
                  job,
                  resolve,
                  fetcher,
                );
                return response({ data: { job_id: job.id, ...saved } });
              }
              const hosts = env.collectionHosts?.length
                ? env.collectionHosts
                : await backend.internal("worker_collection_hosts");
              const result = await collect(
                source,
                hosts || [],
                resolve,
                fetcher,
              );
              const saved = await backend.internal("complete_collection", {
                job_id: job.id,
                lease: job.lease_token,
                result,
              });
              await backend
                .internal("schedule_assessment_refresh")
                .catch(() => console.warn("assessment_scheduling_pending"));
              return response({ data: { job_id: job.id, ...saved } });
            } catch (error) {
              const code =
                error instanceof CollectionError || error instanceof AppError
                  ? error.code
                  : "SOURCE_TEMPORARY_FAILURE";
              await backend.internal("fail_collection", {
                job_id: job.id,
                lease: job.lease_token,
                error_code: code,
                retry_after:
                  error instanceof CollectionError ? error.retryAfter : null,
              });
              return response({ data: { job_id: job.id, error_code: code } });
            }
          }
          if (
            [
              "classify_opportunity",
              "analyze_chunk",
              "summarize_review",
              "plan_proposal",
              "draft_section",
              "plan_commercial",
              "review_proposal",
              "advance_plan",
            ].includes(job.type)
          ) {
            await processGeneration(backend, env, job, fetcher, resolve);
            return response({ data: { job_id: job.id, processed: true } });
          }
          await backend.finish(
            job.id,
            job.lease_token,
            "blocked",
            "MODEL_NOT_CONFIGURED",
          );
          return response({
            data: {
              job_id: job.id,
              status: "blocked",
              error_code: "MODEL_NOT_CONFIGURED",
            },
          });
        };
        const result = await processClaimed();
        // Stage transitions and assembly need no inference slot. Commit a few
        // ready local steps now, using the normal exclusive claim transaction.
        // No model work is drained here, and cron remains crash recovery.
        const localStartedAt = Date.now();
        for (let count = 0; count < 3; count++) {
          if (
            Date.now() - localStartedAt >= 15000 ||
            !(
              backend.invocationBudgetMs -
                (Date.now() - backend.invocationStartedAt) >
              15000
            )
          )
            break;
          const local = await backend.internal("claim_backend_local_job_v4");
          if (!local) break;
          job = local;
          await processClaimed();
        }
        try {
          await wakeReadyQueue(backend, job);
        } catch {
          // Completion is already durable. Cron remains the fallback when a
          // wake cannot be queued; never turn successful work into a retry.
          console.warn("queue_wakeup_pending");
        }
        return withMaintenance(result);
      };
      if (background) {
        background(
          process()
            .then((result) => {
              if (!result.ok) console.warn("background_dispatch_failed");
            })
            .catch(() => console.warn("background_dispatch_failed")),
        );
        return response({ data: { accepted: true } }, 202);
      }
      return await process();
    } catch {
      return response({ error: "DISPATCH_FAILED" }, 503);
    }
  };
}
