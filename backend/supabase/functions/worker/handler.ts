import { processGeneration } from "../_shared/generation.ts";
import { processModelProbe } from "../_shared/modelProbe.ts";
import { Backend, type BackendEnvironment } from "../_shared/backend.ts";
import { AppError, secretMatches } from "../_shared/http.ts";
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
      await backend.internal("maintenance_tick");
      await backend.internal("schedule_assessment_refresh");
      const cleanup = await backend.internal("claim_storage_cleanup");
      if (!Array.isArray(cleanup))
        throw new AppError(
          503,
          "MAINTENANCE_RESPONSE_INVALID",
          "Maintenance returned an invalid batch.",
        );
      for (const item of cleanup) {
        let succeeded = false;
        try {
          await backend.removeObject(item.storage_key);
          succeeded = true;
        } catch {
          /* Keep the reservation and retry bounded cleanup. */
        }
        await backend.internal("complete_storage_cleanup", {
          cleanup_id: item.id,
          lease: item.lease_token,
          succeeded,
        });
      }
      const job = await backend.claim();
      if (!job) return response({ data: { claimed: false } });
      if (job.type === "model_probe") {
        await processModelProbe(backend, env, job, fetcher);
        return response({ data: { job_id: job.id, processed: true } });
      }
      if (job.type === "source_collect" || job.type === "source_candidates") {
        try {
          const source = (await backend.internal("collection_context", {
            job_id: job.id,
            lease: job.lease_token,
          })) as SourceInput;
          const hosts = env.collectionHosts?.length
            ? env.collectionHosts
            : await backend.internal("worker_collection_hosts");
          const result = await collect(source, hosts || [], resolve, fetcher);
          const saved = await backend.internal("complete_collection", {
            job_id: job.id,
            lease: job.lease_token,
            result,
          });
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
    } catch {
      return response({ error: "DISPATCH_FAILED" }, 503);
    }
  };
}
