// @vitest-environment node
import { expect, it } from "vitest";
import { seedExtraction } from "./sourceExtractionFixture";
import {
  parseSource,
  collect,
  type SourceInput,
} from "../../supabase/functions/_shared/collector";
const source = (id: string, url: string): SourceInput => ({
  id,
  url,
  kind: "link_directory",
  approval: "approved",
  approved_hosts: [new URL(url).hostname],
  policy_note: "Synthetic public-listing adapter test",
  adapter_config: { official_listing: id, extraction: seedExtraction(id) },
});
const najah = source("ps-najah", "https://www.najah.edu/ar/tenders/");
const row = (deadline: string, href = "/ar/tenders/synthetic-1/") =>
  `<tr><td>123</td><td><a href="${href}">توريد أجهزة اختبار</a></td><td>2026-10-15</td><td>${deadline}</td><td>1:00 م</td></tr>`;
const table = (body: string) =>
  `<table class="table-bordered"><thead><tr><th>رقم العطاء</th></tr></thead><tbody>${body}</tbody></table>`;
it("collects an Arabic public notice, retains its raw deadline and keeps the latest repeated announcement", () => {
  const result = parseSource(
    najah,
    table(row("2026-10-25") + row("2026-10-20")),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    reference: "123",
    title: "توريد أجهزة اختبار",
    buyer: "جامعة النجاح الوطنية",
    deadline_raw: "2026-10-25 1:00 م",
    deadline_at: null,
    language: "ar",
  });
  expect(result.candidates).toEqual([]);
  expect(result.warnings).toContain("SUPERSEDED_LISTING_SKIPPED");
});
it("fails closed on changed markup, wrong site, invalid detail links and empty ambiguous results", () => {
  for (const html of [
    "<h1>Login</h1>",
    table(""),
    table(row("2026-10-25", "https://evil.example.test/")),
    table(row("x")).replace("2026-10-15", "unknown"),
  ])
    expect(() => parseSource(najah, html)).toThrow("SOURCE_SCHEMA_CHANGED");
  expect(() =>
    parseSource(
      { ...najah, url: "https://other.example.test/ar/tenders/" },
      table(row("x")),
    ),
  ).toThrow("OFFICIAL_ADAPTER_URL_MISMATCH");
  expect(() =>
    parseSource(
      { ...najah, adapter_config: { official_listing: "__proto__" } },
      "",
    ),
  ).toThrow("ADAPTER_REQUIRED");
});
it("selects Jordan tender columns without treating document links as separate tenders", () => {
  const result = parseSource(
    source("jo-gtd", "https://gtd.gov.jo/AR/Modules/TendersUnderOffering"),
    `<table class="table-tender"><thead><tr><th>رقم العطاء</th></tr></thead><tbody><tr><td>85/2026</td><td>أعمال اختبار</td><td>2026/10/18</td><td>2026/11/09</td><td><a href="/doc.pdf">وثائق</a></td><td></td><td></td><td></td><td><a class="tender-link" href="/Ar/tendersunderofferingdetails/test_1">التفاصيل</a></td></tr></tbody></table>`,
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0].canonical_url).toContain("test_1");
  expect(result.items[0].deadline_raw).toBe("2026/11/09");
});
it("excludes Ramallah auctions and header news; leaves absent deadlines unknown", () => {
  const card = (id: number, title: string) =>
    `<div class="cat-title"><span class="news_icon">19 أيلول 2026</span><a class="btitle" href="/ar/Article/${id}/notice">${title}</a></div>`;
  const result = parseSource(
    source("ps-ramallah", "https://www.ramallah.ps/ar/Category/33/عطاءات"),
    `<header>${card(1, "News")}</header><section class="home_center">${card(2, "طرح مزاد")}${card(3, "توريد أجهزة")}</section>`,
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    reference: "article:3",
    deadline_raw: null,
  });
  expect(result.warnings).toContain("NON_PROCUREMENT_NOTICE_SKIPPED");
});
it("reports a valid IsDB listing with no open tenders, and accepts an explicitly open one", () => {
  const src = source(
    "sa-isdb",
    "https://www.isdb.org/corporate-procurement/tenders-and-opportunities",
  );
  const html = `<div class="cloudsearch-teasers"><article class="type-corporate_procurement_tender" data-nid="1"><div class="field-title"><a href="/corporate-procurement/tenders-and-opportunities/test">Synthetic procurement</a></div><div class="field--name-field-tender-status">Closed</div></article></div>`;
  expect(parseSource(src, html)).toMatchObject({
    items: [],
    warnings: expect.arrayContaining(["CLOSED_NOTICE_SKIPPED"]),
  });
  expect(parseSource(src, html.replace("Closed", "Open")).items).toHaveLength(
    1,
  );
  expect(() => parseSource(src, html.replace("Closed", "Unknown"))).toThrow(
    "SOURCE_SCHEMA_CHANGED",
  );
});
it("runs official listings through the same host, login-wall and size safeguards", async () => {
  const fetcher = async () => new Response(table(row("2026-10-25")));
  await expect(
    collect(najah, [], async () => ["93.184.216.34"], fetcher),
  ).rejects.toThrow("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
  const result = await collect(
    najah,
    najah.approved_hosts,
    async () => ["93.184.216.34"],
    fetcher,
  );
  expect(result.items).toHaveLength(1);
  await expect(
    collect(
      najah,
      najah.approved_hosts,
      async () => ["93.184.216.34"],
      async () => new Response("captcha"),
    ),
  ).rejects.toThrow("MANUAL_SOURCE_REQUIRED");
});

it("accepts the browser-valid omitted closing row in the published Arabic table header", () => {
  const html = table(row("2026-10-25")).replace(
    "</th></tr></thead>",
    "</th></thead>",
  );
  expect(parseSource(najah, html).items).toHaveLength(1);
});

it("reads a previously unknown source entirely from its saved extraction settings", () => {
  const extraction = seedExtraction("ps-najah");
  extraction.url = "https://new-source.example.test/opportunities";
  extraction.buyer = "Synthetic configurable buyer";
  if (extraction.listing.layout !== "table") throw new Error("fixture");
  extraction.listing.container = "table.custom-feed";
  const configured = {
    ...najah,
    url: extraction.url,
    adapter_config: { official_listing: "owner-created", extraction },
  };
  const result = parseSource(
    configured,
    table(row("2026-10-25")).replace("table-bordered", "custom-feed"),
  );
  expect(result.items[0].buyer).toBe("Synthetic configurable buyer");
  expect(result.items[0].canonical_url).toContain("new-source.example.test");
  extraction.listing.container = "table.missing";
  expect(() => parseSource(configured, table(row("2026-10-25")))).toThrow(
    "SOURCE_SCHEMA_CHANGED",
  );
});

it("collects notices and source candidates in one fetch without promoting notice links or attachments", async () => {
  const combined = {
    ...najah,
    adapter_config: {
      ...(najah.adapter_config as Record<string, unknown>),
      discover_source_links: true,
    },
  };
  const html =
    table(row("2026-10-25") + row("2026-10-20", "/ar/tenders/superseded/")) +
    `
    <nav><a href="/about">About</a></nav><footer><a href="https://social.example.test/">Social</a></footer>
    <a href="/ar/tenders/">Self</a><a href="#top">Top</a>
    <a href="/ar/tenders/synthetic-1/?utm_source=duplicate">Duplicate notice</a>
    <a href="/ar/tenders/superseded/">Superseded notice</a>
    <a href="/terms.pdf">Attachment</a><a download href="/download?id=1">Download</a>
    <a href="https://other.example.test/tenders?utm_source=listing">Other tenders</a>
    <a href="https://other.example.test/tenders">Duplicate source</a>
    <a href="javascript:alert(1)">Invalid</a><a href="https://127.0.0.1/">Private</a>`;
  let fetches = 0;
  const result = await collect(
    combined,
    combined.approved_hosts,
    async () => ["93.184.216.34"],
    async () => {
      fetches++;
      return new Response(html);
    },
  );
  expect(fetches).toBe(1);
  expect(result.items).toHaveLength(1);
  expect(result.candidates).toEqual([
    { url: "https://other.example.test/tenders", name: "Other tenders" },
  ]);
  expect(parseSource(najah, html).candidates).toEqual([]);
  expect(() =>
    parseSource(
      combined,
      "<h1>Changed page</h1><a href='https://other.example.test/'>Other</a>",
    ),
  ).toThrow("SOURCE_SCHEMA_CHANGED");
});
