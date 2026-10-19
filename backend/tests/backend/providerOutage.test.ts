// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
let job: string, lease: string;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
  lease = crypto.randomUUID();
  job = (
    await f.db.query<any>(
      "insert into public.jobs(workspace_id,type,entity_id,status,created_by,input_hash,lease_token,lease_until) values($1,'classify_opportunity',$2,'running',$3,repeat('a',64),$4,now()+interval '3 minutes') returning id",
      [f.w, crypto.randomUUID(), f.owner, lease],
    )
  ).rows[0].id;
});
afterEach(async () => f.db.exec("rollback"));
async function attempt(
  provider: string,
  code: string,
  http: number | null,
  extra: {
    sent?: boolean;
    model?: string;
    after?: string;
    age?: number;
    status?: string;
  } = {},
) {
  await f.db.query(
    "insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,result_code,sent,http_status,retry_after,started_at) values($1,$2,$3,$4,$5,'synthetic-project','classify_opportunity',1,1,$6,$7,$8,$9,$10,now()-make_interval(secs=>$11))",
    [
      f.w,
      job,
      crypto.randomUUID(),
      provider,
      extra.model || "synthetic-model",
      extra.status || (code === "SUCCEEDED" ? "succeeded" : "failed"),
      code,
      extra.sent ?? true,
      http,
      extra.after || null,
      extra.age || 0,
    ],
  );
}
const windows = () => f.rpc("model_retry_windows", [job, lease]);
it("backs off repeated headerless outages across jobs without cooling down healthy models or counting skipped attempts", async () => {
  await attempt("zai_free", "PROVIDER_QUOTA_WAIT", 429, { age: 3 });
  await attempt("zai_free", "PROVIDER_QUOTA_WAIT", 429, { age: 2 });
  await attempt("zai_free", "PROVIDER_QUOTA_WAIT", 429);
  await attempt("zai_free", "PROVIDER_QUOTA_WAIT", null, {
    sent: false,
    status: "skipped",
  });
  await attempt("groq_free", "SUCCEEDED", 200);
  await attempt("gemini_free", "PROVIDER_REQUEST_INVALID", 400);
  const rows = await windows();
  expect(rows).toHaveLength(1);
  expect(rows[0].provider).toBe("zai_free");
  expect(Date.parse(rows[0].retry_after) - Date.now()).toBeGreaterThan(230000);
  expect(Date.parse(rows[0].retry_after) - Date.now()).toBeLessThan(245000);
});
it("honors Retry-After, clears backoff on a response, and retains the exact model identity", async () => {
  await attempt("groq_free", "PROVIDER_QUOTA_WAIT", 429, {
    after: new Date(Date.now() + 2 * 3600000).toISOString(),
  });
  expect(
    Date.parse((await windows())[0].retry_after) - Date.now(),
  ).toBeGreaterThan(7100000);
  await attempt("groq_free", "SUCCEEDED", 200);
  expect(await windows()).toEqual([]);
  await attempt("groq_free", "PROVIDER_QUOTA_WAIT", 429, {
    model: "other-model",
  });
  expect(await windows()).toMatchObject([
    { provider: "groq_free", model: "other-model" },
  ]);
});
it("counts rejected server responses and uncertain network sends, caps backoff, and lets it expire", async () => {
  await attempt("gemini_free", "MODEL_NETWORK_UNCERTAIN", 503, { sent: false });
  await attempt("zai_free", "MODEL_NETWORK_UNCERTAIN", null);
  expect((await windows()).map((x: any) => x.provider).sort()).toEqual([
    "gemini_free",
    "zai_free",
  ]);
  for (let i = 0; i < 7; i++)
    await attempt("zai_free", "PROVIDER_QUOTA_WAIT", 429);
  const zai = (await windows()).find((x: any) => x.provider === "zai_free");
  expect(Date.parse(zai.retry_after) - Date.now()).toBeGreaterThan(3590000);
  expect(Date.parse(zai.retry_after) - Date.now()).toBeLessThanOrEqual(3600000);
  await f.db.exec(
    "update public.model_attempts set started_at=now()-interval '2 hours'",
  );
  expect(await windows()).toEqual([]);
  await expect(
    f.rpc("model_retry_windows", [job, crypto.randomUUID()]),
  ).rejects.toThrow("STALE_LEASE");
});
