// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  enrichPublicNotice,
  fetchPublicNotice,
  parseNoticeDetails,
  parseAutomaticNoticeDetails,
  readPublicPdf,
  submissionDeadline,
} from "../../supabase/functions/_shared/publicNoticeDetails";
import { seedExtraction } from "./sourceExtractionFixture";
import { workflowFixture } from "./workflowFixture";
import { taskInput } from "../../supabase/functions/_shared/generation";
const url = "https://www.ramallah.ps/ar/Article/1/synthetic";
const source: any = {
  id: "synthetic",
  kind: "link_directory",
  url: "https://www.ramallah.ps/ar/Category/33/عطاءات",
  approval: "approved",
  policy_note: "Synthetic reviewed source",
  approved_hosts: ["www.ramallah.ps"],
  adapter_config: {
    official_listing: "ps-ramallah",
    extraction: seedExtraction("ps-ramallah"),
  },
};
const html = `<h1>Synthetic software licenses</h1><div id="all_body"><p>تجديد تراخيص برامج وتطوير تطبيقات. شروط اصطناعية للاختبار فقط.</p><ol><li>رسوم شراء الوثيقة 150 شيقل.</li><li>آخر موعد لشراء وثيقة المناقصة 9/3/2026 الساعة 11:00 صباحاً.</li><li>يجب تسليم العطاءات قبل الساعة 11:00 صباحاً يوم 10/3/2026؛ صلاحية العطاءات 90 يوما.</li><li>تقديم رخصة مهن سارية المفعول.</li><li>كفالة بنكية بقيمة 10,000 شيقل لمدة 120 يوم.</li></ol><table><tr><td>هاتف 02-111-2222 test@example.test</td></tr></table><p>Synthetic signatory</p><p>رئيس البلدية</p><a href="/public/files\\synthetic.pdf">وثيقة</a></div>`;
it("reads all labeled notice conditions, correct submission date, links and excludes contact/signature blocks", () => {
  const result = parseNoticeDetails(seedExtraction("ps-ramallah"), url, html);
  expect(result.text).toContain("150 شيقل");
  expect(result.text).toContain("120 يوم");
  expect(result.text).toContain("رخصة مهن");
  expect(result.text).not.toMatch(/example.test|02-111|Synthetic signatory/);
  expect(result.attachments).toEqual([
    "https://www.ramallah.ps/public/files/synthetic.pdf",
  ]);
  expect(result.deadline).toMatchObject({
    local: "2026-03-10T11:00:00",
    timezone: "Asia/Hebron",
    date: "2026-03-10",
  });
});
it("never mistakes a purchase date for submission, invents a missing time or accepts an invalid date", () => {
  expect(
    submissionDeadline("Asia/Hebron", "آخر موعد لشراء 9/3/2026 الساعة 11:00")
      .date,
  ).toBeNull();
  expect(submissionDeadline("Asia/Amman", "", "02/11/2026")).toMatchObject({
    date: "2026-11-02",
    local: null,
    timezone: "Asia/Amman",
  });
  expect(
    submissionDeadline("Asia/Hebron", "", "2026-10-18 الساعة 1:00 م").local,
  ).toBe("2026-10-18T13:00:00");
  expect(
    submissionDeadline("Asia/Hebron", "يجب تسليم العطاءات 31/2/2026").date,
  ).toBeNull();
});
it("rejects a missing detail selector instead of evaluating site navigation as evidence", () => {
  expect(() =>
    parseNoticeDetails(
      seedExtraction("ps-ramallah"),
      url,
      "<header>11:00 10/3/2026</header>",
    ),
  ).toThrow("NOTICE_DETAIL_SCHEMA_CHANGED");
});
it("reads the Najah labeled desktop/mobile detail fields without confusing publication and submission", () => {
  const result = parseNoticeDetails(
    seedExtraction("ps-najah"),
    "https://www.najah.edu/ar/tenders/synthetic/",
    `<div class="page-content"><div class="content"><p>Synthetic procurement announcement with sufficient public description and conditions.</p><dl><dt>الموضوع</dt><dd>Synthetic mobile application services</dd><dt>تم النشر في</dt><dd>2026-10-13</dd><dt>الموعد النهائي</dt><dd>2026-10-18 13:00:00</dd></dl></div></div>`,
  );
  expect(result.title).toBe("Synthetic mobile application services");
  expect(result.deadline.local).toBe("2026-10-18T13:00:00");
  expect(result.text).toContain("الموعد النهائي: 2026-10-18 13:00:00");
});
it("retains public GTD details inside an ASP.NET form while removing form controls", () => {
  const result = parseNoticeDetails(
    seedExtraction("jo-gtd"),
    "https://gtd.gov.jo/Ar/tendersunderofferingdetails/synthetic",
    `<form><input value="synthetic hidden form token"><div id="page_divtendersDetails"><div>اسم العطاء: <span id="page_lblTitle">Synthetic public procurement detail</span></div><div>تاريخ الايداع: <span id="page_lblDepositDate">02/11/2026</span></div><p>Synthetic public procurement terms and sufficient announcement details for the fixture.</p></div></form>`,
  );
  expect(result.title).toBe("Synthetic public procurement detail");
  expect(result.deadline).toMatchObject({ date: "2026-11-02", local: null });
  expect(result.text).not.toContain("form token");
});
it("keeps hostname, redirect, private DNS and streamed byte boundaries for public details", async () => {
  const hosts = source.approved_hosts,
    signal = new AbortController().signal;
  await expect(
    fetchPublicNotice(
      url,
      source,
      hosts,
      async () => ["127.0.0.1"],
      fetch,
      signal,
      20,
    ),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  let calls = 0;
  const redirect: typeof fetch = async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://unapproved.example.test/file.pdf" },
    });
  };
  await expect(
    fetchPublicNotice(
      url,
      source,
      hosts,
      async () => ["8.8.8.8"],
      redirect,
      signal,
      20,
    ),
  ).rejects.toThrow("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
  expect(calls).toBe(1);
  await expect(
    fetchPublicNotice(
      url,
      source,
      hosts,
      async () => ["8.8.8.8"],
      async () => new Response("x".repeat(21)),
      signal,
      20,
    ),
  ).rejects.toThrow("SOURCE_TOO_LARGE");
});
it("reads actual PDF text, marks image-only pages and omits restricted pages", async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage()
    .drawText(
      "Synthetic technical scope: software licensing and hardware devices.",
      { font, size: 12, x: 20, y: 700 },
    );
  pdf.addPage();
  pdf.addPage().drawText("Confidential synthetic restricted fixture", { font });
  const pages = await readPublicPdf(await pdf.save());
  expect(pages).toHaveLength(3);
  expect(pages[0].text).toContain("hardware devices");
  expect(pages[1].text).toBe("");
  expect(pages[2]).toMatchObject({ restricted: true, text: "" });
});
it("retains public HTML facts when an attachment fails and reports incomplete coverage honestly", async () => {
  const fetcher: typeof fetch = async (u) =>
    String(u) === url
      ? new Response(html)
      : new Response("temporary", { status: 503 });
  const result = await enrichPublicNotice(
    source,
    { canonical_url: url, title: "Synthetic", identity_key: "external:1" },
    source.approved_hosts,
    async () => ["8.8.8.8"],
    fetcher,
  );
  expect(result.description).toContain("150 شيقل");
  expect(result.notice_evidence.status).toBe("partial");
  expect(result.notice_evidence.attachments[0]).toMatchObject({
    status: "unread",
    error: "SOURCE_TEMPORARY_FAILURE",
  });
});

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function fixture() {
  const s = await f.command("source.create", {
    name: "Synthetic public details",
    kind: "link_directory",
    url: source.url,
    approved_hosts: source.approved_hosts,
    policy_note: source.policy_note,
  });
  await f.db.query(
    "update public.sources set adapter_config=$2::jsonb,approval='approved',policy_checked_at=now(),next_due=now()+interval '6 hours' where id=$1",
    [s.id, JSON.stringify(source.adapter_config)],
  );
  await f.command("model.configure", {
    provider: "gemini_free",
    expected_revision: 0,
    enabled: true,
    model: "synthetic-model",
    project_ref: "synthetic",
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
  const item = {
    title: "Synthetic software licenses",
    description: "Listing summary with no deadline.",
    reference: "article:1",
    canonical_url: url,
    buyer: "Synthetic buyer",
    language: "en",
    identity_key: "external:1",
  };
  const o = (
    await f.db.query<any>(
      "select app_private.ingest_notice($1,s,$3::jsonb,$4) id from public.sources s where id=$2",
      [f.w, s.id, JSON.stringify(item), f.owner],
    )
  ).rows[0].id;
  await f.db.query(
    "update public.opportunities set decision='declined' where id=$1",
    [o],
  );
  await f.rpc("schedule_assessment_refresh");
  const job = await f.rpc("claim_backend_job");
  return { s, o, item, job };
}
it("persists detail evidence under the lease, supersedes title-only plans, preserves decisions and excludes expired notices", async () => {
  const { o, item, job } = await fixture();
  expect(job.type).toBe("classify_opportunity");
  const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
  expect(ctx.detail_notice.canonical_url).toBe(url);
  const result = await enrichPublicNotice(
    source,
    item,
    source.approved_hosts,
    async () => ["8.8.8.8"],
    async (u) =>
      String(u) === url
        ? new Response(html.replace(/<a href[\s\S]*?<\/a>/, ""))
        : new Response(null, { status: 404 }),
  );
  await f.rpc("complete_notice_details", [
    job.id,
    job.lease_token,
    JSON.stringify(result),
  ]);
  const saved = (
    await f.db.query<any>(
      "select *,deadline_at::text closing from public.opportunities where id=$1",
      [o],
    )
  ).rows[0];
  expect(saved.decision).toBe("declined");
  expect(saved.description).toContain("150 شيقل");
  expect(saved.closing).toContain("2026-03-10 09:00:00");
  expect(saved.notice_evidence.status).toBe("read");
  expect(saved.assessment_pending).toBe(true);
  const view = (
    await f.db.query<any>(
      "select * from public.opportunity_discovery where id=$1",
      [o],
    )
  ).rows[0];
  expect(view).toMatchObject({
    is_expired: true,
    inbox_visible: false,
    assessment_current: false,
  });
  await f.rpc("schedule_assessment_refresh");
  const next = await f.rpc("claim_backend_job");
  const refreshed = await f.rpc("generation_context", [
    next.id,
    next.lease_token,
  ]);
  expect(refreshed.detail_source).toBeUndefined();
  expect(refreshed.plan.frozen_context.notice.text).toContain("رخصة مهن");
  expect(refreshed.plan.frozen_context.notice_evidence.status).toBe("read");
});
it("persists a temporary detail fetch retry without making a provider request or final assessment", async () => {
  const { o, job } = await fixture();
  await f.rpc("fail_notice_details", [
    job.id,
    job.lease_token,
    "SOURCE_TEMPORARY_FAILURE",
  ]);
  const view = (
    await f.db.query<any>(
      "select * from public.opportunity_discovery where id=$1",
      [o],
    )
  ).rows[0];
  expect(view).toMatchObject({
    assessment_state: "retry_wait",
    assessment_current: false,
    inbox_visible: false,
  });
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(0);
});
it("detail mutation RPCs are service-only", async () => {
  const rows = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','public.complete_notice_details(uuid,uuid,jsonb)','execute') can_complete,has_function_privilege('authenticated','public.fail_notice_details(uuid,uuid,text)','execute') can_fail",
    )
  ).rows[0];
  expect(rows).toEqual({ can_complete: false, can_fail: false });
});
it("grounds company judgments in both verified Company Knowledge notes and extracted files", async () => {
  const { o } = await fixture();
  const note = await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic delivery experience",
    content: "Synthetic company delivered an approval application.",
    enabled: true,
  });
  await f.db.query(
    "update public.knowledge_items set verified_at=now(),verified_by=$2 where id=$1",
    [note.id, f.owner],
  );
  const file = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "company",
    knowledge_item_id: note.id,
    original_name: "synthetic-capabilities.txt",
    mime_type: "text/plain",
    size: 60,
    hash: "b".repeat(64),
  });
  await f.rpc("accept_uploaded_document", [
    file.id,
    f.owner,
    "b".repeat(64),
    60,
    "Synthetic file evidence: application integration experience.",
    "ready",
    crypto.randomUUID(),
  ]);
  const frozen = (
    await f.db.query<any>(
      "select app_private.generation_snapshot($1,$2,null,null) data",
      [f.w, o],
    )
  ).rows[0].data;
  const input = taskInput({
    plan: { frozen_context: frozen },
    step: { task: "classify_opportunity", input: {} },
    steps: [],
    requirements: [],
  });
  expect(
    input.evidence.some((e) =>
      e.text.includes("delivered an approval application"),
    ),
  ).toBe(true);
  expect(
    input.evidence.some((e) =>
      e.text.includes("application integration experience"),
    ),
  ).toBe(true);
  expect(input.manifest).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ entity_kind: "knowledge", entity_id: note.id }),
      expect.objectContaining({ entity_kind: "document", entity_id: file.id }),
    ]),
  );
  expect(input.context.company_evidence_coverage.complete_text).toBe(true);
  expect(input.context.company_evidence_source).toContain(
    "files and notes only",
  );
});
it("reserves a larger notice assessment while preserving other-task and daily limits", async () => {
  const revision = (
    await f.db.query<any>(
      "select revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0].revision;
  await f.command("discovery.configure", {
    expected_revision: revision,
    scope: "keywords",
    include_keywords: ["Synthetic software services"],
    exclude_keywords: ["Synthetic physical supply"],
    auto_public_notices: true,
    providers: ["gemini_free"],
  });
  const { o, job } = await fixture();
  const ref = (
    await f.db.query<any>(
      "select app_private.content_record($1,'notice',$2)-'content'-'title' ref",
      [f.w, o],
    )
  ).rows[0].ref;
  const reserve = (tokens: number) =>
    f.rpc("reserve_model_call", [
      job.id,
      job.lease_token,
      "synthetic-large-notice",
      "a".repeat(64),
      tokens,
      1000,
      JSON.stringify([ref]),
      "gemini_free",
    ]);
  await f.db.exec("savepoint too_large");
  await expect(reserve(64001)).rejects.toThrow("MODEL_CONTEXT_TOO_LARGE");
  await f.db.exec("rollback to savepoint too_large");
  await f.db.query("update public.jobs set type='analyze_chunk' where id=$1", [
    job.id,
  ]);
  await f.db.exec("savepoint smaller_task");
  await expect(reserve(30000)).rejects.toThrow("MODEL_CONTEXT_TOO_LARGE");
  await f.db.exec("rollback to savepoint smaller_task");
  await f.db.query(
    "update public.jobs set type='classify_opportunity' where id=$1",
    [job.id],
  );
  const reservation = await reserve(30000);
  expect(reservation.reserved_input).toBe(30000);
  expect(reservation.state).toBe("reserved");
  expect(
    (
      await f.db.query<any>(
        "select input_per_day from public.model_settings where workspace_id=$1 and provider='gemini_free'",
        [f.w],
      )
    ).rows[0].input_per_day,
  ).toBe(250000);
});
it("reads pending detail pages before starting an older ready-to-model assessment", async () => {
  const { o, s, item, job } = await fixture();
  const hash = (
    await f.db.query<any>(
      "select app_private.content_record($1,'notice',$2)->>'content_hash' hash",
      [f.w, o],
    )
  ).rows[0].hash;
  await f.db.query(
    "update public.opportunities set notice_evidence=jsonb_build_object('version',1,'notice_hash',$2::text,'fetched_at',now()) where id=$1",
    [o, hash],
  );
  await f.db.query(
    "update public.jobs set status='queued',lease_token=null,lease_until=null where id=$1",
    [job.id],
  );
  const newer = (
    await f.db.query<any>(
      "select app_private.ingest_notice($1,s,$3::jsonb,$4) id from public.sources s where id=$2",
      [
        f.w,
        s.id,
        JSON.stringify({
          ...item,
          identity_key: "external:2",
          reference: "article:2",
          title: "Synthetic second public notice",
        }),
        f.owner,
      ],
    )
  ).rows[0].id;
  await f.rpc("schedule_assessment_refresh");
  const next = await f.rpc("claim_backend_job");
  const ctx = await f.rpc("generation_context", [next.id, next.lease_token]);
  expect(ctx.plan.opportunity_id).toBe(newer);
  expect(ctx.detail_source).toBeDefined();
});

it("keeps expertise after the former twelve-source and 32k excerpt boundaries", () => {
  const company = Array.from({ length: 14 }, (_, i) => ({
    id: `source-${i}`,
    text:
      "Synthetic source text. ".repeat(160) +
      (i === 13
        ? "Essential uncommon Arabic integration expertise at the end."
        : ""),
    kind: "company",
    verified: true,
    reference: {
      entity_kind: "knowledge",
      entity_id: `note-${i}`,
      content_hash: "a".repeat(64),
    },
  }));
  const input = taskInput({
    plan: {
      frozen_context: {
        notice: {
          id: "notice",
          text: "متطلبات مشروع جديد",
          kind: "notice",
          reference: {
            entity_kind: "notice",
            entity_id: "notice",
            content_hash: "b".repeat(64),
          },
        },
        knowledge: company,
        blocks: [],
        reviews: [],
      },
    },
    step: { task: "classify_opportunity", input: {} },
    steps: [],
    requirements: [],
  });
  expect(input.evidence).toHaveLength(15);
  expect(input.evidence.find((x) => x.id === "source-13")?.text).toBe(
    company[13].text,
  );
  expect(input.context.company_evidence_coverage).toEqual({
    available_sources: 14,
    supplied_sources: 14,
    complete_text: true,
  });
});

it("uses saved detail selectors and timezone for a new source without a runtime source registry", () => {
  const extraction = seedExtraction("ps-ramallah");
  extraction.url = "https://new-source.example.test/listing";
  extraction.timezone = "Europe/Paris";
  extraction.detail.root = "#custom_notice";
  const result = parseNoticeDetails(
    extraction,
    "https://new-source.example.test/notice/1",
    html.replace("all_body", "custom_notice"),
  );
  expect(result.deadline.timezone).toBe("Europe/Paris");
  expect(result.text).toContain("150 شيقل");
});

it("does not mislabel a redirected landing page or a short article as scanned content", () => {
  const html =
    "<body><section>" +
    "Public procurement navigation and other notices. ".repeat(8) +
    "</section><article>Short unrelated card</article></body>";
  expect(() =>
    parseAutomaticNoticeDetails(
      "https://buyer.example.test/home",
      html,
      "https://buyer.example.test/notice?id=1",
    ),
  ).toThrow("SOURCE_NOTICE_REDIRECTED");
  expect(() =>
    parseAutomaticNoticeDetails("https://buyer.example.test/notice", html),
  ).toThrow("NOTICE_DETAILS_CONTENT_UNRESOLVED");
  expect(() =>
    parseAutomaticNoticeDetails(
      "https://buyer.example.test/notice",
      '<body><img src="notice.png"></body>',
    ),
  ).toThrow("NOTICE_DETAILS_NEED_OCR");
  expect(() =>
    parseAutomaticNoticeDetails(
      "https://buyer.example.test/notice",
      "<body><script>render()</script></body>",
    ),
  ).toThrow("SOURCE_BROWSER_REQUIRED");
  expect(() =>
    parseAutomaticNoticeDetails(
      "https://buyer.example.test/notice",
      "<body></body>",
    ),
  ).toThrow("SOURCE_EMPTY");
});
