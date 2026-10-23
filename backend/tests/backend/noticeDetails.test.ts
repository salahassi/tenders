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
import { CollectionError } from "../../supabase/functions/_shared/collector";
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
  expect(
    submissionDeadline(
      "Asia/Amman",
      "Purchase date\n01/10/2026\nClosing date\n05/11/2026",
    ).date,
  ).toBe("2026-11-05");
  expect(
    submissionDeadline("Asia/Amman", "", "تاريخ انتهاء العطاء 05-11-2026").date,
  ).toBe("2026-11-05");
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
it("reads published disabled fields and excludes hidden credential dialogs and buyer contacts", () => {
  const result = parseNoticeDetails(
    seedExtraction("jo-rj"),
    "https://procurement.rj.com/RFP_Check.aspx?fixture=1",
    `<form><div class="container"><div class="form-group"><label>Request Subject</label><textarea disabled id="fixture_RFPSubject">Synthetic software support</textarea></div><div class="form-group"><label>Closing Datetime</label><input disabled type="text" id="fixture_ClosingDate" value="2026-11-05 12:00 PM"></div><div class="form-group"><label>Buyer_Name</label><input disabled type="text" id="fixture_txtBuyerName" value="Synthetic contact"></div><div class="form-group"><label>Description</label><textarea readonly>Synthetic public scope requires implementation, testing, operational support and documented handover of software services.</textarea></div><input type="hidden" value="synthetic form state"><input type="text" value="editable private field"><div hidden>Password: hidden field</div></div><div class="modal fade"><label>Password:</label><input type="password"></div></form>`,
  );
  expect(result.title).toBe("Synthetic software support");
  expect(result.deadline).toMatchObject({
    date: "2026-11-05",
    local: "2026-11-05T12:00:00",
  });
  expect(result.text).toContain("implementation, testing");
  expect(result.text).not.toMatch(
    /Password|Synthetic contact|form state|editable private/,
  );
});
it("keeps an actual visible password wall blocked before cleaning controls", () => {
  expect(() =>
    parseNoticeDetails(
      seedExtraction("jo-rj"),
      "https://procurement.rj.com/RFP_Check.aspx?fixture=1",
      `<div class="container"><div class="form-group"><p>Private synthetic description requiring login.</p><label>Password:</label><input type="password"></div></div>`,
    ),
  ).toThrow("MANUAL_SOURCE_REQUIRED");
});
it("uses only the configured tender section for attachment-only pages", async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage()
    .drawText(
      "Synthetic software tender: provide implementation, testing and support services with complete operating documentation.",
      { font, size: 10, x: 20, y: 700 },
    );
  const bytes = await pdf.save();
  const s: any = {
    ...source,
    url: "https://mwi.gov.jo/AR/Modules/tenders",
    approved_hosts: ["mwi.gov.jo"],
    adapter_config: {
      official_listing: "jo-mwi",
      extraction: seedExtraction("jo-mwi"),
    },
  };
  const target = "https://mwi.gov.jo/Ar/TendersDetails/synthetic";
  const requested: string[] = [];
  const result = await enrichPublicNotice(
    s,
    {
      canonical_url: target,
      title: "Synthetic",
      identity_key: "external:fixture",
    },
    s.approved_hosts,
    async () => ["8.8.8.8"],
    async (url) => {
      requested.push(String(url));
      return String(url) === target
        ? new Response(
            `<h2 id="fixture_lblHeaderTitle">Synthetic software services</h2><div id="fixture_TendersSection"><a href="/tender.pdf">Details</a></div><aside><a href="/unrelated-policy.pdf">Unrelated site document</a></aside>`,
          )
        : new Response(new Uint8Array(bytes));
    },
  );
  expect(result.title).toBe("Synthetic software services");
  expect(result.description).toContain("complete operating documentation");
  expect(result.notice_evidence.status).toBe("read");
  expect(requested).toEqual([target, "https://mwi.gov.jo/tender.pdf"]);
});
it("does not mark an unreadable attachment-only page as read", async () => {
  const s: any = {
    ...source,
    url: "https://mwi.gov.jo/AR/Modules/tenders",
    approved_hosts: ["mwi.gov.jo"],
    adapter_config: {
      official_listing: "jo-mwi",
      extraction: seedExtraction("jo-mwi"),
    },
  };
  const target = "https://mwi.gov.jo/Ar/TendersDetails/synthetic";
  await expect(
    enrichPublicNotice(
      s,
      {
        canonical_url: target,
        title: "Synthetic",
        identity_key: "external:fixture",
      },
      s.approved_hosts,
      async () => ["8.8.8.8"],
      async (url) =>
        String(url) === target
          ? new Response(
              `<div id="fixture_TendersSection"><a href="/tender.pdf">Details</a></div>`,
            )
          : new Response("unavailable", { status: 503 }),
    ),
  ).rejects.toThrow("NOTICE_DETAILS_CONTENT_UNRESOLVED");
});
it("retains verified OCR provenance for a public notice image and keeps pending work resumable", async () => {
  const extraction = seedExtraction("jo-jpmc");
  const s: any = {
    ...source,
    url: extraction.url,
    approved_hosts: ["www.jpmc.com.jo"],
    adapter_config: { extraction },
  };
  const target = "https://www.jpmc.com.jo/ar/tender/synthetic";
  const html = `<main class="News-inner-main-container"><h1>Synthetic software tender</h1><picture><img src="/uploads/notice.webp"></picture></main>`;
  const fetcher: typeof fetch = async (url) =>
    String(url) === target
      ? new Response(html)
      : new Response(new TextEncoder().encode("RIFF1234WEBPsynthetic image"), {
          headers: { "content-type": "image/webp" },
        });
  const inputs: any[] = [];
  const result = await enrichPublicNotice(
    s,
    {
      canonical_url: target,
      title: "Synthetic",
      identity_key: "external:fixture",
    },
    s.approved_hosts,
    async () => ["8.8.8.8"],
    fetcher,
    async (input) => {
      inputs.push(input);
      return {
        pages: [
          {
            page: 1,
            text: "Synthetic OCR text: provide software implementation, testing, operational support and complete handover documentation for the public tender.",
            confidence: 92,
          },
        ],
      };
    },
  );
  expect(inputs[0]).toMatchObject({
    url: "https://www.jpmc.com.jo/uploads/notice.webp",
    pages: [1],
    total_pages: 1,
    mime: "image/webp",
  });
  expect(inputs[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.notice_evidence.attachments[0]).toMatchObject({
    status: "read",
    extraction: "ocr",
    ocr_read_pages: [1],
    ocr_confidence: { "1": 92 },
  });
  expect(result.description).toContain("Synthetic OCR text");
  await expect(
    enrichPublicNotice(
      s,
      {
        canonical_url: target,
        title: "Synthetic",
        identity_key: "external:fixture",
      },
      s.approved_hosts,
      async () => ["8.8.8.8"],
      fetcher,
      async () => {
        throw new CollectionError("NOTICE_OCR_PENDING");
      },
    ),
  ).rejects.toThrow("NOTICE_OCR_PENDING");
});
it("does not admit low-confidence OCR text as notice evidence", async () => {
  const extraction = seedExtraction("jo-jpmc"),
    s: any = {
      ...source,
      url: extraction.url,
      approved_hosts: ["www.jpmc.com.jo"],
      adapter_config: { extraction },
    };
  const target = "https://www.jpmc.com.jo/ar/tender/synthetic";
  await expect(
    enrichPublicNotice(
      s,
      {
        canonical_url: target,
        title: "Synthetic",
        identity_key: "external:fixture",
      },
      s.approved_hosts,
      async () => ["8.8.8.8"],
      async (url) =>
        String(url) === target
          ? new Response(
              `<main class="News-inner-main-container"><h1>Synthetic</h1><picture><img src="/uploads/notice.webp"></picture></main>`,
            )
          : new Response(
              new TextEncoder().encode("RIFF1234WEBPsynthetic image"),
              {
                headers: { "content-type": "image/webp" },
              },
            ),
      async () => ({
        pages: [
          {
            page: 1,
            text: "Unreliable synthetic OCR output with enough characters to exceed the extraction boundary.",
            confidence: 12,
          },
        ],
      }),
    ),
  ).rejects.toThrow("NOTICE_DETAILS_NEED_OCR");
});
it("reads an exact browser continuation after a public HTTP challenge and propagates pending", async () => {
  const s: any = { ...source, adapter_config: { automatic: true } };
  const rendered = `<main><h1>Synthetic browser notice</h1><p>Public software implementation and support services with documented acceptance criteria and complete handover requirements.</p></main>`;
  const result = await enrichPublicNotice(
    s,
    {
      canonical_url: url,
      title: "Synthetic",
      identity_key: "external:fixture",
    },
    s.approved_hosts,
    async () => ["8.8.8.8"],
    async () => new Response("challenge", { status: 403 }),
    undefined,
    async (input) => ({ url: input.url, html: rendered }),
  );
  expect(result.title).toBe("Synthetic browser notice");
  expect(result.notice_evidence.status).toBe("read");
  const partial = await enrichPublicNotice(
    s,
    {
      canonical_url: url,
      title: "Synthetic",
      identity_key: "external:fixture",
    },
    s.approved_hosts,
    async () => ["8.8.8.8"],
    async () => new Response("challenge", { status: 403 }),
    undefined,
    async (input) => ({
      url: input.url,
      html: rendered,
      warnings: ["NOTICE_DETAIL_TAB_UNREAD:#datesTab"],
    }),
  );
  expect(partial.notice_evidence).toMatchObject({
    status: "partial",
    warnings: ["NOTICE_DETAIL_TAB_UNREAD:#datesTab"],
  });
  expect(partial.description).toContain("dates and scope may be incomplete");
  await expect(
    enrichPublicNotice(
      s,
      {
        canonical_url: url,
        title: "Synthetic",
        identity_key: "external:fixture",
      },
      s.approved_hosts,
      async () => ["8.8.8.8"],
      async () => new Response("challenge", { status: 403 }),
      undefined,
      async () => {
        throw new CollectionError("NOTICE_BROWSER_PENDING");
      },
    ),
  ).rejects.toThrow("NOTICE_BROWSER_PENDING");
});
it("rejects a postback destination that renders a different notice", async () => {
  const extraction = seedExtraction("jo-gam"),
    s: any = {
      ...source,
      url: extraction.url,
      approved_hosts: ["www.gamtenders.gov.jo"],
      adapter_config: { extraction },
    };
  const target = "https://www.gamtenders.gov.jo/showtender.aspx?guid=synthetic";
  const fetcher: typeof fetch = async (u, init) => {
    if (init?.method === "POST")
      return new Response(null, {
        status: 302,
        headers: { location: "showtender.aspx" },
      });
    if (String(u).endsWith("adlocaltenders.aspx"))
      return new Response(
        `<form method="post" action="adlocaltenders.aspx"><input type="hidden" name="__VIEWSTATE" value="synthetic"><input type="hidden" name="__EVENTVALIDATION" value="synthetic"><table id="GVtenders"><tr><td>1</td><td>Synthetic requested notice</td><td><a id="fixture_lnkdetails" href="javascript:__doPostBack('GVtenders$ctl02$lnkdetails','')">Details</a></td></tr></table></form>`,
      );
    return new Response(
      `<article class="post-content"><h1 id="lbltitle">A different synthetic notice</h1><p>Public content with sufficient length that must never be assigned to the wrong original notice, even after valid public navigation.</p></article>`,
    );
  };
  await expect(
    enrichPublicNotice(
      s,
      {
        canonical_url: target,
        title: "Synthetic requested notice",
        identity_key: "external:fixture",
      },
      s.approved_hosts,
      async () => ["8.8.8.8"],
      fetcher,
    ),
  ).rejects.toThrow("PUBLIC_NOTICE_IDENTITY_UNRESOLVED");
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
  pdf
    .addPage()
    .drawText("CONFIDENTIAL: synthetic restricted fixture", { font });
  pdf
    .addPage()
    .drawText(
      "The supplier must preserve confidentiality of information while providing software implementation services.",
      { font, size: 10, x: 20, y: 700 },
    );
  const originalBytes = await pdf.save();
  const originalSize = originalBytes.byteLength;
  const pages = await readPublicPdf(originalBytes);
  expect(originalBytes.byteLength).toBe(originalSize);
  expect(pages).toHaveLength(4);
  expect(pages[0].text).toContain("hardware devices");
  expect(pages[1].text).toBe("");
  expect(pages[2]).toMatchObject({ restricted: true, text: "" });
  expect(pages[3].restricted).toBe(false);
  expect(pages[3].text).toContain("preserve confidentiality");
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
    "update public.opportunities set decision='deferred' where id=$1",
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
  expect(saved.decision).toBe("deferred");
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

async function enrichedFixture() {
  const base = await fixture();
  const details: any = await enrichPublicNotice(
    source,
    base.item,
    source.approved_hosts,
    async () => ["8.8.8.8"],
    async () => new Response(html.replace(/<a href[\s\S]*?<\/a>/, "")),
  );
  details.notice_evidence.attachments = [
    {
      url: "https://www.ramallah.ps/synthetic.pdf",
      status: "read",
      sha256: "a".repeat(64),
      included_pages: 1,
      ocr_pages: [],
    },
  ];
  await f.rpc("complete_notice_details", [
    base.job.id,
    base.job.lease_token,
    JSON.stringify(details),
  ]);
  await f.rpc("schedule_assessment_refresh");
  const job = await f.rpc("claim_backend_job");
  return { ...base, details, job };
}

async function expireDetailFetch(id: string, sourceId: string) {
  await f.db.query(
    "update public.opportunities set notice_evidence=jsonb_set(notice_evidence,'{fetched_at}',to_jsonb((now()-interval '1 hour')::text)) where id=$1",
    [id],
  );
  await f.db.query(
    "update public.sources set last_success_at=now() where id=$1",
    [sourceId],
  );
}

function freshDetails(details: any) {
  return {
    ...structuredClone(details),
    notice_evidence: {
      ...structuredClone(details.notice_evidence),
      fetched_at: new Date().toISOString(),
      detail_sha256: "b".repeat(64),
    },
  };
}

async function usageFor(job: any, pending = false) {
  return (
    await f.db.query<any>(
      `insert into public.provider_usage(
    workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,
    settings_revision,reserved_input,reserved_output,state,remote_request_id,remote_deadline,created_by)
    values($1,$2,$3,$4,'gemini_free','synthetic-model',$5,current_date,1,100,100,$6,$7,
    case when $7::text is not null then now()+interval '20 minutes' end,$8) returning *`,
      [
        f.w,
        job.id,
        job.lease_token,
        crypto.randomUUID(),
        job.input_hash,
        pending ? "reserved" : "settled",
        pending ? "synthetic-accepted-request" : null,
        f.owner,
      ],
    )
  ).rows[0];
}

async function acceptedAssessment() {
  const base = await enrichedFixture();
  const ctx = await f.rpc("generation_context", [
    base.job.id,
    base.job.lease_token,
  ]);
  const authorization = await f.command("content.authorize", {
    ...ctx.plan.frozen_context.notice.reference,
    provider: "gemini_free",
    attestation: "nonconfidential_nonpersonal",
  });
  await usageFor(base.job);
  await f.rpc("complete_generation_step", [
    base.job.id,
    base.job.lease_token,
    JSON.stringify({ synthetic: "accepted test assessment" }),
  ]);
  const advance = await f.rpc("claim_backend_job");
  await f.rpc("advance_generation", [
    advance.id,
    advance.lease_token,
    "completed",
    "[]",
    "[]",
    JSON.stringify({
      fit_score: 70,
      evidence_coverage: 80,
      routing: "needs_review",
      result: {
        summary: "Synthetic fixture result",
        source_refs: [{ id: base.o, quote: "150 شيقل" }],
      },
    }),
  ]);
  const assessment = (
    await f.db.query<any>(
      "select * from public.fit_assessments where opportunity_id=$1",
      [base.o],
    )
  ).rows[0];
  const plan = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      assessment.plan_id,
    ])
  ).rows[0];
  return { ...base, assessment, plan, authorization };
}

async function refreshJob(base: { o: string; s: any }) {
  await expireDetailFetch(base.o, base.s.id);
  await f.rpc("schedule_assessment_refresh");
  const job = await f.rpc("claim_backend_job");
  expect(
    (await f.rpc("generation_context", [job.id, job.lease_token]))
      .detail_source,
  ).toBeDefined();
  return job;
}

it("an unchanged detail poll preserves the paid background request, graph, pinned input and saved polling time", async () => {
  const base = await enrichedFixture();
  const usage = await usageFor(base.job, true);
  const checkpoint = {
    model_executor: 2,
    graph_thread: "c".repeat(64),
    model_round: { pending: { usage_id: usage.id }, round: 2 },
  };
  await f.db.query(
    "update public.jobs set checkpoint=$2::jsonb,error_code='MODEL_IN_PROGRESS',next_attempt_at=now()+interval '45 seconds' where id=$1",
    [base.job.id, JSON.stringify(checkpoint)],
  );
  await f.db.query(
    "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,candidate_count) values($1,$2,$3,$4,'classify_opportunity',2)",
    [checkpoint.graph_thread, f.w, base.job.id, base.job.input_hash],
  );
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',2)",
    [checkpoint.graph_thread],
  );
  const before = (
    await f.db.query<any>(
      "select to_jsonb(j) job,to_jsonb(p) plan,w.evidence_revision,(select count(*) from public.advertisement_snapshots) snapshots from public.jobs j join public.generation_plans p on p.id=j.entity_id join public.workspaces w on w.id=j.workspace_id where j.id=$1",
      [base.job.id],
    )
  ).rows[0];
  await expireDetailFetch(base.o, base.s.id);
  await f.rpc("complete_notice_details", [
    base.job.id,
    base.job.lease_token,
    JSON.stringify(freshDetails(base.details)),
  ]);
  const after = (
    await f.db.query<any>(
      "select to_jsonb(j) job,to_jsonb(p) plan,w.evidence_revision,(select count(*) from public.advertisement_snapshots) snapshots from public.jobs j join public.generation_plans p on p.id=j.entity_id join public.workspaces w on w.id=j.workspace_id where j.id=$1",
      [base.job.id],
    )
  ).rows[0];
  expect(after.job).toMatchObject({
    status: "retry_wait",
    error_code: "MODEL_IN_PROGRESS",
    checkpoint,
    input_hash: before.job.input_hash,
    next_attempt_at: before.job.next_attempt_at,
  });
  expect(after.plan).toEqual(before.plan);
  expect(after.evidence_revision).toBe(before.evidence_revision);
  expect(after.snapshots).toBe(before.snapshots);
  expect(
    (
      await f.db.query<any>("select * from public.provider_usage where id=$1", [
        usage.id,
      ])
    ).rows[0],
  ).toEqual(usage);
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1",
        [checkpoint.graph_thread],
      )
    ).rows[0].candidates,
  ).toBe(2);
});

it("reuses only an exactly unchanged automatic assessment, preserving its result, citations, timestamp and frozen hash across global revision changes", async () => {
  const base = await acceptedAssessment();
  await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic disabled evidence",
    content: "This disabled fixture is not an assessment input.",
    enabled: false,
  });
  const beforeSnapshots = (
    await f.db.query<any>(
      "select count(*) n from public.advertisement_snapshots",
    )
  ).rows[0].n;
  for (let poll = 0; poll < 2; poll++) {
    const job = await refreshJob(base);
    await f.rpc("complete_notice_details", [
      job.id,
      job.lease_token,
      JSON.stringify(freshDetails(base.details)),
    ]);
    const outcome = (
      await f.db.query<any>(
        "select j.status job_status,p.status plan_status,s.output from public.jobs j join public.generation_steps s on s.job_id=j.id join public.generation_plans p on p.id=s.plan_id where j.id=$1",
        [job.id],
      )
    ).rows[0];
    expect(outcome).toMatchObject({
      job_status: "succeeded",
      plan_status: "completed",
      output: {
        reason: "NOTICE_DETAILS_UNCHANGED",
        reused_assessment_id: base.assessment.id,
        assessment_input_hash: base.assessment.input_hash,
      },
    });
  }
  const assessments = (
    await f.db.query<any>(
      "select * from public.fit_assessments where opportunity_id=$1",
      [base.o],
    )
  ).rows;
  expect(assessments).toHaveLength(1);
  expect(assessments[0]).toMatchObject({
    id: base.assessment.id,
    result: base.assessment.result,
    created_at: base.assessment.created_at,
    input_hash: base.assessment.input_hash,
  });
  const current = (
    await f.db.query<any>(
      "select evidence_revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0].evidence_revision;
  expect(assessments[0].evidence_revision).toBe(current);
  const plan = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      base.plan.id,
    ])
  ).rows[0];
  expect(plan).toMatchObject({
    input_hash: base.plan.input_hash,
    frozen_context: base.plan.frozen_context,
    created_at: base.plan.created_at,
    evidence_revision: current,
  });
  expect(
    (
      await f.db.query<any>(
        "select assessment_current,assessment_state from public.opportunity_discovery where id=$1",
        [base.o],
      )
    ).rows[0],
  ).toEqual({ assessment_current: true, assessment_state: "assessed" });
  expect(
    (
      await f.db.query<any>(
        "select count(*) n from public.advertisement_snapshots",
      )
    ).rows[0].n,
  ).toBe(beforeSnapshots);
  expect(
    (await f.db.query<any>("select count(*)::int n from public.provider_usage"))
      .rows[0].n,
  ).toBe(1);
});

it("a manual re-evaluation is never replaced with an old assessment after an unchanged detail refresh", async () => {
  const base = await acceptedAssessment();
  const opportunity = (
    await f.db.query<any>(
      "select revision from public.opportunities where id=$1",
      [base.o],
    )
  ).rows[0];
  const manual = await f.command("opportunity.assess", {
    id: base.o,
    expected_revision: opportunity.revision,
  });
  await expireDetailFetch(base.o, base.s.id);
  const job = await f.rpc("claim_backend_job");
  expect(job.entity_id).toBe(manual.id);
  await f.rpc("complete_notice_details", [
    job.id,
    job.lease_token,
    JSON.stringify(freshDetails(base.details)),
  ]);
  expect(
    (
      await f.db.query<any>("select status from public.jobs where id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("retry_wait");
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='assessment.evidence.reused'",
      )
    ).rows[0].n,
  ).toBe(0);
});

it.each([
  "notice text",
  "deadline",
  "attachment bytes",
  "attachment identity",
  "attachment status",
  "future evidence field",
])(
  "a real change in %s invalidates once and the subsequent identical poll preserves the new assessment",
  async (kind) => {
    const base = await enrichedFixture();
    await expireDetailFetch(base.o, base.s.id);
    const changed = freshDetails(base.details);
    if (kind === "notice text")
      changed.description += " A new mandatory acceptance condition.";
    if (kind === "deadline")
      changed.notice_evidence.deadline.date = "2026-03-12";
    if (kind === "attachment bytes")
      changed.notice_evidence.attachments[0].sha256 = "d".repeat(64);
    if (kind === "attachment identity")
      changed.notice_evidence.attachments[0].url =
        "https://www.ramallah.ps/revised-synthetic.pdf";
    if (kind === "attachment status")
      changed.notice_evidence.attachments[0].status = "unread";
    if (kind === "future evidence field")
      changed.notice_evidence.future_requirement = "new mandatory evidence";
    const before = (
      await f.db.query<any>(
        "select evidence_revision,(select count(*) from public.advertisement_snapshots) snapshots from public.workspaces where id=$1",
        [f.w],
      )
    ).rows[0];
    await f.rpc("complete_notice_details", [
      base.job.id,
      base.job.lease_token,
      JSON.stringify(changed),
    ]);
    expect(
      (
        await f.db.query<any>(
          "select status,error_code from public.jobs where id=$1",
          [base.job.id],
        )
      ).rows[0],
    ).toEqual({ status: "canceled", error_code: "NOTICE_DETAILS_REFRESHED" });
    const version = (
      await f.db.query<any>(
        "select evidence_revision from public.workspaces where id=$1",
        [f.w],
      )
    ).rows[0].evidence_revision;
    expect(version).toBeGreaterThan(before.evidence_revision);
    await f.rpc("schedule_assessment_refresh");
    const next = await f.rpc("claim_backend_job");
    const ctx = await f.rpc("generation_context", [next.id, next.lease_token]);
    expect(ctx.plan.evidence_revision).toBe(version);
    expect(ctx.detail_source).toBeUndefined();
    await expireDetailFetch(base.o, base.s.id);
    await f.rpc("complete_notice_details", [
      next.id,
      next.lease_token,
      JSON.stringify(freshDetails(changed)),
    ]);
    expect(
      (
        await f.db.query<any>("select status from public.jobs where id=$1", [
          next.id,
        ])
      ).rows[0].status,
    ).toBe("retry_wait");
    expect(
      (
        await f.db.query<any>(
          "select count(*) snapshots from public.advertisement_snapshots",
        )
      ).rows[0].snapshots,
    ).toBe(Number(before.snapshots) + 1);
    expect(
      (
        await f.db.query<any>(
          "select evidence_revision from public.workspaces where id=$1",
          [f.w],
        )
      ).rows[0].evidence_revision,
    ).toBe(version);
  },
);

it("changed verified company evidence prevents reuse even when the entire notice is unchanged", async () => {
  const base = await acceptedAssessment();
  const note = await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic new capability",
    content:
      "A new verified software delivery capability for this isolated fixture.",
    enabled: true,
  });
  await f.db.query(
    "update public.knowledge_items set verified_at=now(),verified_by=$2 where id=$1",
    [note.id, f.owner],
  );
  const job = await refreshJob(base);
  await f.rpc("complete_notice_details", [
    job.id,
    job.lease_token,
    JSON.stringify(freshDetails(base.details)),
  ]);
  expect(
    (
      await f.db.query<any>("select status from public.jobs where id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("retry_wait");
  expect(
    (
      await f.db.query<any>(
        "select * from public.fit_assessments where id=$1",
        [base.assessment.id],
      )
    ).rows[0],
  ).toEqual(base.assessment);
});

it("a revoked original recipient permission prevents automatic assessment reuse", async () => {
  const base = await acceptedAssessment();
  await f.command("content.revoke", {
    id: base.authorization.id,
    expected_revision: base.authorization.revision,
  });
  const job = await refreshJob(base);
  await f.rpc("complete_notice_details", [
    job.id,
    job.lease_token,
    JSON.stringify(freshDetails(base.details)),
  ]);
  expect(
    (
      await f.db.query<any>("select status from public.jobs where id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("retry_wait");
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.audit_events where action='assessment.evidence.reused'",
      )
    ).rows[0].n,
  ).toBe(0);
});

it("new semantic comparison and the original mutation implementation cannot be invoked as public RPCs", async () => {
  const row = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','app_private.notice_context_semantics(jsonb)','execute') compare_auth,has_function_privilege('service_role','app_private.notice_context_semantics(jsonb)','execute') compare_service,has_function_privilege('service_role','public.complete_notice_details_before_semantic_refresh(uuid,uuid,jsonb)','execute') old_mutation",
    )
  ).rows[0];
  expect(row).toEqual({
    compare_auth: false,
    compare_service: false,
    old_mutation: false,
  });
});

it("volatile HTTP refresh keeps an approval, but changed attachment evidence invalidates it through the canonical path", async () => {
  const base = await enrichedFixture();
  const proposal = crypto.randomUUID(),
    version = crypto.randomUUID();
  const estimate = crypto.randomUUID(),
    delivery = crypto.randomUUID();
  await f.db.query(
    "insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values($1,$2,$3,'Synthetic approval fixture',$4)",
    [proposal, f.w, base.o, f.owner],
  );
  await f.db.query(
    "insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,created_by,status) values($1,$2,$3,1,repeat('a',64),$4,'approved')",
    [version, f.w, proposal, f.owner],
  );
  await f.db.query(
    "update public.proposals set active_version_id=$1,state='approved' where id=$2",
    [version, proposal],
  );
  const evidenceRevision = (
    await f.db.query<any>(
      "select evidence_revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0].evidence_revision;
  for (const [table, id] of [
    ["estimate_versions", estimate],
    ["delivery_versions", delivery],
  ])
    await f.db.query(
      `insert into public.${table}(id,workspace_id,proposal_version_id,ordinal,input,input_hash,evidence_revision,created_by) values($1,$2,$3,1,'{}',repeat('a',64),$4,$5)`,
      [id, f.w, version, evidenceRevision, f.owner],
    );
  await f.db.query(
    `insert into public.approvals(workspace_id,proposal_version_id,estimate_id,delivery_id,content_hash,package_hash,pricing_hash,delivery_hash,evidence_revision,review_hash,approved_by,created_by)
    values($1,$2,$3,$4,repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),$5,repeat('e',64),$6,$6)`,
    [f.w, version, estimate, delivery, evidenceRevision, f.owner],
  );
  const state = async () =>
    (
      await f.db.query<any>(
        "select p.state,v.status,a.invalidated_at,w.evidence_revision from public.proposals p join public.proposal_versions v on v.id=p.active_version_id join public.approvals a on a.proposal_version_id=v.id join public.workspaces w on w.id=p.workspace_id where p.id=$1",
        [proposal],
      )
    ).rows[0];
  const before = await state();
  await expireDetailFetch(base.o, base.s.id);
  await f.rpc("complete_notice_details", [
    base.job.id,
    base.job.lease_token,
    JSON.stringify(freshDetails(base.details)),
  ]);
  expect(await state()).toEqual(before);
  const job = await f.rpc("claim_backend_job");
  await expireDetailFetch(base.o, base.s.id);
  const changed = freshDetails(base.details);
  changed.notice_evidence.attachments[0].sha256 = "f".repeat(64);
  await f.rpc("complete_notice_details", [
    job.id,
    job.lease_token,
    JSON.stringify(changed),
  ]);
  const after = await state();
  expect(after.state).toBe("draft");
  expect(after.status).toBe("draft");
  expect(after.invalidated_at).not.toBeNull();
  expect(after.evidence_revision).toBeGreaterThan(before.evidence_revision);
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

it("reads public detail content with compatible uncompressed negotiation and retains access guards", async () => {
  const publicHtml =
    '<div id="all_body"><p>Synthetic public software procurement with installation, integration, testing and complete documented handover requirements.</p></div>';
  const fetcher: typeof fetch = async (_url, init) =>
    new Headers(init?.headers).get("Accept-Encoding") === "identity"
      ? new Response(publicHtml)
      : new Response("Blocked", { status: 403 });
  const result = await enrichPublicNotice(
    source,
    { canonical_url: url, title: "Synthetic" },
    source.approved_hosts,
    async () => ["8.8.8.8"],
    fetcher,
  );
  expect(result.notice_evidence.status).toBe("read");
  expect(result.description).toContain("documented handover");
  await expect(
    enrichPublicNotice(
      source,
      { canonical_url: url, title: "Synthetic" },
      source.approved_hosts,
      async () => ["8.8.8.8"],
      async () => new Response("Blocked", { status: 403 }),
    ),
  ).rejects.toThrow("MANUAL_SOURCE_REQUIRED");
});

it.each(["attachment", "direct"])(
  "retains readable pages from a mixed PDF after soft OCR failure (%s)",
  async (mode) => {
    const pdf = await PDFDocument.create();
    pdf
      .addPage()
      .drawText(
        "Synthetic public procurement: deliver software, integrate existing systems, test acceptance, and provide complete operating documentation.",
        { x: 15, y: 500, size: 10 },
      );
    pdf.addPage();
    const bytes = await pdf.save();
    const target = mode === "direct" ? url + ".pdf" : url;
    const s =
      mode === "direct"
        ? { ...source, adapter_config: { automatic: true } }
        : source;
    const fetcher: typeof fetch = async (requested) =>
      mode === "direct" || String(requested).endsWith("mixed.pdf")
        ? new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/pdf" },
          })
        : new Response(
            '<div id="all_body"><a href="/public/mixed.pdf">Public document</a></div>',
          );
    const run = (code: string) =>
      enrichPublicNotice(
        s,
        { canonical_url: target, title: "Synthetic mixed PDF" },
        s.approved_hosts,
        async () => ["8.8.8.8"],
        fetcher,
        async (request) => {
          expect(request.pages).toEqual([2]);
          throw new CollectionError(code);
        },
      );
    for (const code of [
      "NOTICE_OCR_LOW_CONFIDENCE",
      "NOTICE_OCR_FAILED",
      "SOURCE_TIMEOUT",
    ]) {
      const result = await run(code);
      expect(result.description).toContain("integrate existing systems");
      expect(result.notice_evidence.status).toBe("partial");
      expect(result.notice_evidence.attachments[0]).toMatchObject({
        status: "partial",
        total_pages: 2,
        included_pages: [1],
        ocr_pages: [2],
        ocr_error: code,
      });
      expect(result.notice_evidence.attachments[0].extraction).toBeUndefined();
    }
    for (const code of [
      "NOTICE_OCR_PENDING",
      "DATA_POLICY_BLOCKED",
      "SOURCE_CONTENT_CHANGED",
      "STALE_INPUT",
      "UNSAFE_DESTINATION",
    ]) {
      await expect(run(code)).rejects.toThrow(code);
    }
  },
);
