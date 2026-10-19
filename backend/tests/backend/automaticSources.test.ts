// @vitest-environment node
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";
import { readableSourcePage } from "../../supabase/functions/_shared/automaticSources";
import { validateModelResult } from "../../supabase/functions/_shared/model";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => {
  await f.db.exec("begin");
});
afterEach(async () => {
  await f.db.exec("rollback");
});
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint auto_rpc; set local role service_role");
  try {
    return (
      await f.db.query<{ data: any }>(
        `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) data`,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).rows[0]?.data;
  } catch (e) {
    await f.db.exec("rollback to savepoint auto_rpc");
    throw databaseError(e as Error);
  } finally {
    await f.db.exec("reset role; release savepoint auto_rpc");
  }
}
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public",
  serviceKey: "synthetic-server",
  workerSecret: "synthetic-worker",
  allowedOrigins: [],
  models: modelEnvironments((name) =>
    name.includes("GROQ") || name.includes("ZAI")
      ? name.endsWith("_KEY")
        ? "synthetic-key"
        : name.endsWith("_NAME")
          ? "synthetic-model"
          : name.endsWith("_PROJECT")
            ? "synthetic-project"
            : undefined
      : undefined,
  ),
};
async function setup() {
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "priority",
  });
  const workspace = (
    await f.db.query<any>(
      "select revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0];
  await f.command("discovery.configure", {
    expected_revision: workspace.revision,
    scope: "keywords",
    include_keywords: ["software"],
    exclude_keywords: [],
    auto_public_notices: true,
    providers: ["groq_free", "zai_free"],
  });
}
async function source(url = "https://source.example.test/") {
  const s = await f.command("source.create", {
    name: "Synthetic source",
    kind: "manual",
    url,
  });
  return f.command("source.action", {
    id: s.id,
    expected_revision: s.revision,
    action: "approve",
    reason: "Synthetic public reading",
  });
}
function worker(fetcher: typeof fetch, resolve = async () => ["8.8.8.8"]) {
  const backend = {
    internal: rpc,
    claim: () => rpc("claim_backend_job"),
    finish: (
      job_id: string,
      lease: string,
      result_status: string,
      result_error: string | null,
    ) =>
      rpc("finish_backend_job", { job_id, lease, result_status, result_error }),
  };
  const handle = createWorkerHandler(
    env,
    resolve,
    () => backend as unknown as Backend,
    fetcher,
  );
  return async () => {
    const r = await handle(
      new Request("https://worker.example.test/", {
        method: "POST",
        headers: { "x-worker-secret": env.workerSecret },
      }),
    );
    expect(r.status).toBe(200);
    return (await r.json()).data;
  };
}
const empty = {
  page_kind: "directory",
  reason_quote: "Public procurement directory",
  notices: [],
  follow_link_id: null,
  candidate_link_ids: [],
};
const answer = (result: unknown) =>
  Response.json({
    choices: [
      { message: { content: JSON.stringify(result) }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 70 },
  });
const detail =
  "Synthetic software delivery. The buyer requests development of a procurement tracking application and integration with existing systems.";
const noticeResult = {
  page_kind: "listing",
  reason_quote: "Current public tenders",
  notices: [
    {
      title: "Synthetic software delivery",
      link_id: "L1",
      reference: null,
      buyer: null,
      deadline_raw: null,
      evidence_quote: detail,
    },
  ],
  follow_link_id: null,
  candidate_link_ids: [],
};

it("reads an unknown website, follows an observed listing link, fails over, and schedules detail reading without site selectors", async () => {
  await setup();
  const s = await source();
  expect(s.adapter_config.automatic).toBe(true);
  expect(s.approval).toBe("approved");
  const network = vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (u.includes("api.groq.com"))
      return new Response("quota", { status: 429 });
    if (u.includes("api.z.ai")) {
      const prompt = JSON.parse(String(init?.body)).messages[1].content;
      return answer(
        prompt.includes('"url":"https://source.example.test/"')
          ? { ...empty, follow_link_id: "L1" }
          : noticeResult,
      );
    }
    if (u === "https://source.example.test/")
      return new Response(
        '<p>Public procurement directory</p><a href="https://listing.example.test/tenders">Tender listing</a>',
        { headers: { "content-type": "text/html" } },
      );
    if (u === "https://listing.example.test/tenders")
      return new Response(
        `<main><h1>Current public tenders</h1><article><a href="/notice/1">Synthetic software delivery</a><p>${detail}</p></article></main>`,
        { headers: { "content-type": "text/html" } },
      );
    return new Response(
      `<article><h1>Synthetic software delivery</h1><p>${detail}</p></article>`,
      { headers: { "content-type": "text/html" } },
    );
  });
  const run = worker(network);
  const first = await run();
  expect(first).toMatchObject({ continued: true, pages_read: 1 });
  const second = await run();
  expect(second).toMatchObject({ processed: 1 });
  const rows = (await f.db.query<any>("select * from public.opportunities"))
    .rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].canonical_url).toBe("https://listing.example.test/notice/1");
  expect(
    (
      await f.db.query<any>(
        "select notice_details_status from public.opportunity_discovery",
      )
    ).rows[0].notice_details_status,
  ).toBe("pending");
  expect(
    (
      await f.db.query(
        "select * from public.jobs where type='classify_opportunity' and status='queued'",
      )
    ).rows,
  ).toHaveLength(1);
  await run();
  expect(
    (await f.db.query<any>("select notice_evidence from public.opportunities"))
      .rows[0].notice_evidence.status,
  ).toBe("read");
  const activity = (
    await f.db.query<any>(
      "select provider,status,result_code,actual_input,actual_output from public.model_activity where operation='inspect_source_page' order by sequence",
    )
  ).rows;
  expect(activity.filter((a) => a.status === "succeeded")).toHaveLength(2);
  expect(
    activity.some(
      (a) =>
        a.provider === "groq_free" && a.result_code === "PROVIDER_QUOTA_WAIT",
    ),
  ).toBe(true);
  expect(
    activity
      .filter((a) => a.status === "succeeded")
      .every((a) => a.actual_input === 120 && a.actual_output === 70),
  ).toBe(true);
  expect(
    network.mock.calls.filter(
      ([u]) => String(u) === "https://source.example.test/",
    ),
  ).toHaveLength(1);
});

it("keeps directory discovery separate and saves reviewed candidates without enabling them", async () => {
  await setup();
  const queued = await f.command(
    "source.discover",
    { url: "https://directory.example.test/" },
    "00000000-0000-4000-8000-000000000078",
  );
  expect(
    await f.command(
      "source.discover",
      { url: "https://directory.example.test/" },
      "00000000-0000-4000-8000-000000000078",
    ),
  ).toEqual(queued);
  const network = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("api.")
      ? answer({ ...empty, candidate_link_ids: ["L1"] })
      : new Response(
          '<p>Public procurement directory</p><a href="https://buyer.example.test/tenders">Synthetic tender source</a>',
        ),
  );
  expect(await worker(network)()).toMatchObject({ candidates: 1 });
  const sources = (await f.db.query<any>("select * from public.sources")).rows;
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({
    approval: "proposed",
    next_due: null,
    adapter_required: false,
    adapter_config: { automatic: true, discovery_job: queued.job_id },
  });
  expect(
    (await f.db.query("select * from public.opportunities")).rows,
  ).toHaveLength(0);
});

it("retains the exact source page across model retries and prevents sending it after permission is revoked", async () => {
  await setup();
  await source();
  const network = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("api.")
      ? new Response("busy", { status: 429 })
      : new Response(
          '<p>Public procurement directory</p><a href="/tenders">Tender listing</a>',
        ),
  );
  const run = worker(network);
  expect(await run()).toMatchObject({ error_code: "MODEL_ROUND_EXHAUSTED" });
  const saved = (await f.db.query<any>("select * from public.source_readings"))
    .rows[0];
  expect(saved.page_hash).toHaveLength(64);
  await f.db.exec(
    "update public.jobs set next_attempt_at=now() where status='retry_wait'; update public.workspaces set discovery_policy=jsonb_set(discovery_policy,'{auto_public_notices}','false')",
  );
  const calls = network.mock.calls.length;
  expect(await run()).toMatchObject({
    error_code: "DATA_AUTHORIZATION_REQUIRED",
  });
  expect(network.mock.calls).toHaveLength(calls);
  expect(
    (await f.db.query<any>("select page_hash from public.source_readings"))
      .rows[0].page_hash,
  ).toBe(saved.page_hash);
});

it("rejects private destinations before fetching and cannot make up notice fields or links", async () => {
  await setup();
  await source();
  const network = vi.fn<typeof fetch>();
  expect(await worker(network, async () => ["127.0.0.1"])()).toMatchObject({
    error_code: "UNSAFE_DESTINATION",
  });
  expect(network).not.toHaveBeenCalled();
  const evidence = [
    {
      id: "page",
      text: `Current public tenders ${detail}`,
      kind: "notice" as const,
      verified: false,
    },
    {
      id: "L1",
      text: "Synthetic software delivery",
      kind: "notice" as const,
      verified: false,
    },
  ];
  expect(() =>
    validateModelResult("inspect_source_page", noticeResult, evidence),
  ).not.toThrow();
  expect(() =>
    validateModelResult(
      "inspect_source_page",
      {
        ...noticeResult,
        notices: [{ ...noticeResult.notices[0], link_id: "L99" }],
      },
      evidence,
    ),
  ).toThrow();
  expect(() =>
    validateModelResult(
      "inspect_source_page",
      {
        ...noticeResult,
        notices: [{ ...noticeResult.notices[0], deadline_raw: "2099-01-01" }],
      },
      evidence,
    ),
  ).toThrow();
  expect(() =>
    readableSourcePage(
      '<html><script>render()</script><div id="app"></div></html>',
      "https://source.example.test/",
    ),
  ).toThrow("SOURCE_BROWSER_REQUIRED");
});

it("requires an Owner for discovery and keeps page-writing RPCs worker-only", async () => {
  await f.db.exec("update public.memberships set role='Reviewer'");
  await expect(
    f.command("source.discover", { url: "https://directory.example.test/" }),
  ).rejects.toThrow("ROLE_FORBIDDEN");
  const grants = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','public.save_source_page(uuid,uuid,jsonb)','execute') can_save, has_function_privilege('anon','public.auto_source_context(uuid,uuid)','execute') can_read, has_table_privilege('authenticated','public.source_readings','insert') can_insert",
    )
  ).rows[0];
  expect(grants).toEqual({
    can_save: false,
    can_read: false,
    can_insert: false,
  });
});
