// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  Backend,
  modelEnvironments,
} from "../../supabase/functions/_shared/backend";

afterEach(() => vi.unstubAllGlobals());
const environment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-service",
  allowedOrigins: [],
  workerSecret: "synthetic-worker",
  models: modelEnvironments(() => undefined),
};

it.each([1, 2, 5, 6, 7])(
  "claims executor-%i work through the v7 server boundary without rewriting its stored identity",
  async (floor) => {
    const job = {
      id: "00000000-0000-4000-8000-000000000001",
      lease_token: "00000000-0000-4000-8000-000000000002",
      type: "plan_commercial",
      status: "running",
      input_hash: "a".repeat(64),
      checkpoint: {
        minimum_worker_executor: floor,
        model_executor: 2,
        graph_thread: "b".repeat(64),
        model_operation: { task: "verify_grounding" },
        model_round: { input_hash: "c".repeat(64) },
      },
    };
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const request = new Request(input, init);
        calls.push({
          path: new URL(request.url).pathname,
          method: request.method,
          body: await request.json(),
        });
        return new Response(JSON.stringify(job), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    expect(await new Backend(environment).claim()).toEqual(job);
    expect(calls).toEqual([
      { path: "/rest/v1/rpc/claim_backend_job_v7", method: "POST", body: {} },
    ]);
  },
);

it("does not fall back to an older claim boundary when the v7 migration is unavailable", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      paths.push(new URL(new Request(input, init).url).pathname);
      return new Response(
        JSON.stringify({
          code: "PGRST202",
          message: "Synthetic missing function",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }),
  );
  await expect(new Backend(environment).claim()).rejects.toThrow();
  expect(paths).toEqual(["/rest/v1/rpc/claim_backend_job_v7"]);
});
