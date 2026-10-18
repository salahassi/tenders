// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { screenSoftwareScope } from "../../supabase/functions/_shared/discovery";
import {
  nextStage,
  taskInput,
  processGeneration,
} from "../../supabase/functions/_shared/generation";
import { validateModelResult } from "../../supabase/functions/_shared/model";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function configure() {
  const revision = (
    await f.db.query<any>(
      "select revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0].revision;
  return f.command("discovery.configure", {
    expected_revision: revision,
    scope: "software_services",
    auto_public_notices: true,
    providers: ["gemini_free", "qwen_free", "mistral_free", "groq_free"],
  });
}
async function collect(title = "Synthetic software procurement") {
  const s = await f.command("source.create", {
    name: "Synthetic public feed",
    kind: "rss",
    url: "https://feed.example.test/rss",
    approved_hosts: ["feed.example.test"],
    policy_note: "Synthetic reviewed public listing",
  });
  await f.command("source.action", {
    id: s.id,
    expected_revision: s.revision,
    action: "approve",
    reason: "Synthetic public source approval",
  });
  const item = {
    identity_key: "external:SYNTHETIC",
    title,
    description: "",
    buyer: "Synthetic buyer",
    reference: "SYNTHETIC",
    canonical_url: "https://feed.example.test/notice",
    language: "en",
  };
  const o = (
    await f.db.query<any>(
      "select app_private.ingest_notice($1,s,$3::jsonb,$4) id from public.sources s where id=$2",
      [f.w, s.id, JSON.stringify(item), f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "update public.sources set next_due=now()+interval '6 hours' where id=$1",
    [s.id],
  );
  return { o, s };
}
async function manifest(o: string) {
  return [
    (
      await f.db.query<any>(
        "select app_private.content_record($1,'notice',$2)-'content'-'title' ref",
        [f.w, o],
      )
    ).rows[0].ref,
  ];
}
async function check(m: unknown, provider = "gemini_free") {
  await f.db.exec("savepoint payload");
  try {
    await f.db.query(
      "select app_private.check_model_payload($1,$2,$3::jsonb)",
      [f.w, provider, JSON.stringify(m)],
    );
  } catch (e) {
    await f.db.exec("rollback to savepoint payload");
    throw e;
  } finally {
    await f.db.exec("release savepoint payload");
  }
}
async function model() {
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "gemini_free",
    model: "synthetic-flash",
    project_ref: "synthetic-project",
    free_only: true,
    billing_verified: true,
    free_quota_only: false,
    quota_mode: "provider_managed",
    quota_ends_at: null,
    quota_remaining_tokens: null,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
    failover_rank: 1,
  });
}
it("automatically authorizes only an approved exact public snapshot and honors revocation", async () => {
  const { o } = await collect();
  const m = await manifest(o);
  await expect(check(m)).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
  await configure();
  await check(m);
  await check(m, "groq_free");
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.content_authorizations",
      )
    ).rows[0].n,
  ).toBe(2);
  const a = (
    await f.db.query<any>(
      "select * from public.content_authorizations where provider='gemini_free'",
    )
  ).rows[0];
  await f.command("content.revoke", {
    id: a.id,
    expected_revision: a.revision,
  });
  await expect(check(m)).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
  await f.db.query(
    "update public.opportunities set description='Edited private business content' where id=$1",
    [o],
  );
  await expect(check(await manifest(o), "qwen_free")).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
  await expect(check(m, "groq_free")).rejects.toThrow("STALE_INPUT");
});
it("does not approve manually assigned sources, company notes or nonselected providers", async () => {
  const { o, s } = await collect();
  await configure();
  const manual = await f.command("opportunity.create", {
    source_id: s.id,
    title: "Synthetic private note",
    language: "en",
  });
  await expect(check(await manifest(manual.id))).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
  await expect(check(await manifest(o), "cloudflare_free")).rejects.toThrow(
    "DATA_AUTHORIZATION_REQUIRED",
  );
  const k = await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic profile",
    content: "Synthetic public capability",
    enabled: true,
  });
  const ref = (
    await f.db.query<any>(
      "select app_private.content_record($1,'knowledge',$2)-'content'-'title' ref",
      [f.w, k.id],
    )
  ).rows[0].ref;
  await expect(check([ref])).rejects.toThrow("DATA_AUTHORIZATION_REQUIRED");
});
it("keeps pending and blocked work out of the inbox and requeues superseded notice content", async () => {
  const { o } = await collect();
  await configure();
  await model();
  expect(
    (
      await f.db.query<any>(
        "select * from public.opportunity_discovery where id=$1",
        [o],
      )
    ).rows[0],
  ).toMatchObject({
    assessment_state: "pending_schedule",
    inbox_visible: false,
  });
  expect(await f.rpc("schedule_assessment_refresh")).toMatchObject({
    scheduled: 1,
  });
  let p = (
    await f.db.query<any>(
      "select * from public.generation_plans where opportunity_id=$1",
      [o],
    )
  ).rows[0];
  expect(p.frozen_context.discovery_scope).toBe("software_services");
  expect(
    (
      await f.db.query<any>(
        "select * from public.opportunity_discovery where id=$1",
        [o],
      )
    ).rows[0],
  ).toMatchObject({ assessment_state: "queued", inbox_visible: false });
  await f.db.query(
    "update public.jobs set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED' where entity_id=$1",
    [p.id],
  );
  await f.db.query(
    "update public.generation_plans set status='blocked',error_code='DATA_AUTHORIZATION_REQUIRED' where id=$1",
    [p.id],
  );
  expect(
    (
      await f.db.query<any>(
        "select * from public.opportunity_discovery where id=$1",
        [o],
      )
    ).rows[0],
  ).toMatchObject({ assessment_state: "blocked", inbox_visible: false });
  await f.db.query(
    "update public.opportunities set assessment_pending=true where id=$1",
    [o],
  );
  expect(await f.rpc("schedule_assessment_refresh")).toMatchObject({
    scheduled: 1,
  });
  expect(
    (
      await f.db.query<any>(
        "select status from public.jobs where entity_id=$1",
        [p.id],
      )
    ).rows[0].status,
  ).toBe("queued");
  await f.db.query(
    "update public.opportunities set description='New software requirements',decision='shortlisted' where id=$1",
    [o],
  );
  expect(await f.rpc("schedule_assessment_refresh")).toMatchObject({
    scheduled: 1,
  });
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [p.id],
      )
    ).rows[0].status,
  ).toBe("canceled");
  expect(
    (
      await f.db.query<any>(
        "select decision from public.opportunities where id=$1",
        [o],
      )
    ).rows[0].decision,
  ).toBe("shortlisted");
});
it("requires Owner authority and revision, with audited idempotent configuration", async () => {
  const w = (
    await f.db.query<any>("select * from public.workspaces where id=$1", [f.w])
  ).rows[0];
  const input = {
    expected_revision: w.revision,
    scope: "software_services",
    auto_public_notices: false,
    providers: [],
  };
  const first = await f.command(
    "discovery.configure",
    input,
    "00000000-0000-4000-8000-000000000088",
  );
  expect(
    await f.command("discovery.configure", input, "00000000-0000-4000-8000-000000000088"),
  ).toEqual(first);
  await expect(f.command("discovery.configure", input)).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  await f.db.query(
    "update public.memberships set role='Editor' where workspace_id=$1",
    [f.w],
  );
  await expect(
    f.command("discovery.configure", {
      ...input,
      expected_revision: first.revision,
    }),
  ).rejects.toThrow("ROLE_FORBIDDEN");
});
it.each([
  "توريد أجهزة حاسوب",
  "Supply of LCD monitors",
  "تنفيذ مبنى مركز ثقافي",
  "توريد مواد كيميائية ومستلزمات مخبرية",
  "Supplying solar systems with vehicle chargers",
])("screens explicit physical scope: %s", (title) => {
  expect(screenSoftwareScope(title, "software_services")).toMatchObject({
    status: "out_of_scope",
    method: "scope-rule-v1",
  });
  expect(screenSoftwareScope(title, "all")).toBeNull();
});
it.each([
  "تجديد تراخيص برامج وتعزيز أمن المعلومات",
  "Digital transformation for hospitals",
  "AI applications for construction",
  "توريد حواسيب وتطوير برمجيات",
  "نظام توسعة لمركز البيانات",
  "منصة لإدارة مشتريات الأجهزة",
  "Consulting services",
  "استقطاب خبراء الأمن الرقمي وتطبيقات الهاتف المحمول",
])("preserves software, mixed and uncertain scope: %s", (title) => {
  expect(screenSoftwareScope(title, "software_services")).toBeNull();
});
it("validates scope citations and excludes even when title-only fit is unknown", async () => {
  const notice = {
    id: "notice",
    text: "Synthetic supply of stone",
    kind: "notice" as const,
    verified: false,
    reference: {
      entity_kind: "notice",
      entity_id: "notice",
      content_hash: "a".repeat(64),
    },
  };
  const factor = {
    rating: null,
    reason: "Unknown",
    notice_evidence: [],
    company_evidence: [],
  };
  const result = {
    factors: {
      capability: factor,
      scope: factor,
      sector: factor,
      prerequisite: factor,
    },
    critical_unknown: true,
    reason_summary: "Physical work outside software scope",
    missing_information: [],
    risk_flags: [],
    suggested_tags: [],
    scope_decision: {
      status: "out_of_scope",
      reason: "Stone supply",
      notice_evidence: [{ id: notice.id, quote: "supply of stone" }],
    },
  };
  expect(() =>
    validateModelResult("classify_opportunity", result, [notice], []),
  ).not.toThrow();
  expect(() =>
    validateModelResult(
      "classify_opportunity",
      {
        ...result,
        scope_decision: {
          ...result.scope_decision,
          notice_evidence: [{ id: notice.id, quote: "fabricated" }],
        },
      },
      [notice],
      [],
    ),
  ).toThrow();
  const ctx: any = {
    plan: {
      stage: "assessment",
      input_hash: "synthetic",
      frozen_context: {
        notice,
        knowledge: [],
        blocks: [],
        reviews: [],
        discovery_scope: "software_services",
      },
    },
    step: { task: "classify_opportunity", input: {} },
    steps: [
      {
        task: "classify_opportunity",
        stage: "assessment",
        status: "completed",
        output: result,
      },
    ],
    requirements: [],
  };
  expect(taskInput(ctx).context.scope_policy).toContain("Hardware");
  expect((await nextStage(ctx)).final_result).toMatchObject({
    routing: "excluded",
    fit_score: null,
  });
});

it("records deterministic scope assessment through real worker RPCs without calling a model", async () => {
  const { o } = await collect("Synthetic supply of LCD monitors");
  await configure();
  await model();
  await f.rpc("schedule_assessment_refresh");
  const backend: any = {
    internal: async (name: string, args: Record<string, unknown>) => {
      const entries = Object.entries(args);
      return (
        await f.db.query<any>(
          `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) data`,
          entries.map(([, v]) =>
            v && typeof v === "object" ? JSON.stringify(v) : v,
          ),
        )
      ).rows[0].data;
    },
  };
  const env: any = { models: {} };
  const fetcher: typeof fetch = async () => {
    throw Error("Physical scope must not call an external model");
  };
  for (let i = 0; i < 2; i++) {
    const job = await f.rpc("claim_backend_job");
    expect(job).not.toBeNull();
    await processGeneration(backend, env, job, fetcher);
  }
  const view = (
    await f.db.query<any>(
      "select * from public.opportunity_discovery where id=$1",
      [o],
    )
  ).rows[0];
  expect(view).toMatchObject({
    assessment_state: "assessed",
    assessment_current: true,
    routing: "excluded",
    inbox_visible: false,
  });
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.notifications where dedupe_key like 'notice:%' or dedupe_key like 'assessment:%'",
      )
    ).rows[0].n,
  ).toBe(0);
  await f.db.query(
    "update public.opportunities set title='Synthetic software development' where id=$1",
    [o],
  );
  expect(
    (
      await f.db.query<any>(
        "select assessment_current,inbox_visible from public.opportunity_discovery where id=$1",
        [o],
      )
    ).rows[0],
  ).toEqual({ assessment_current: false, inbox_visible: false });
});

it("does not expose discovery rows without membership or retain automatic permission after restore", async () => {
  await collect(); await configure();
  await f.db.exec("set role authenticated");
  expect((await f.db.query("select id from public.opportunity_discovery")).rows).toHaveLength(1);
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",["00000000-0000-4000-8000-000000000099"]);
  expect((await f.db.query("select id from public.opportunity_discovery")).rows).toHaveLength(0);
  await f.db.exec("reset role");
  await f.db.query("update public.workspaces set restore_origin=$2::jsonb where id=$1",[f.w,JSON.stringify({source_workspace:crypto.randomUUID(),authorizations_reset:true})]);
  expect((await f.db.query<any>("select discovery_policy from public.workspaces where id=$1",[f.w])).rows[0].discovery_policy).toEqual({scope:"all",auto_public_notices:false,providers:[]});
});
