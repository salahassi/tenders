import { load } from "cheerio";

// Fixed, reviewed public listing adapters. No caller-supplied selectors, scripts,
// detail-page crawling, credentials, or pagination requests are executed.
export const officialListings = {
  "jo-gtd": {
    host: "gtd.gov.jo",
    path: "/ar/modules/tendersunderoffering",
    buyer: "دائرة العطاءات الحكومية الأردنية",
  },
  "ps-najah": {
    host: "www.najah.edu",
    path: "/ar/tenders",
    buyer: "جامعة النجاح الوطنية",
  },
  "ps-ramallah": {
    host: "www.ramallah.ps",
    path: "/ar/category/33/عطاءات",
    buyer: "بلدية رام الله",
  },
  "sa-isdb": {
    host: "www.isdb.org",
    path: "/corporate-procurement/tenders-and-opportunities",
    buyer: "Islamic Development Bank",
  },
} as const;
export type OfficialListing = keyof typeof officialListings;
type Row = Record<string, unknown>;
const text = (node: { text(): string }) =>
  node.text().replace(/\s+/g, " ").trim();
export function parseOfficialListing(
  adapter: unknown,
  url: string,
  body: string,
): { rows: Row[]; warnings: string[] } {
  if (typeof adapter !== "string" || !Object.hasOwn(officialListings, adapter))
    throw new Error("ADAPTER_REQUIRED");
  const config = officialListings[adapter as OfficialListing],
    location = new URL(url);
  if (
    location.protocol !== "https:" ||
    location.hostname !== config.host ||
    decodeURIComponent(location.pathname).replace(/\/$/, "").toLowerCase() !==
      config.path ||
    location.search
  )
    throw new Error("OFFICIAL_ADAPTER_URL_MISMATCH");
  const $ = load(body);
  $("script,style,header,footer,nav").remove();
  const root = $.root();
  const warnings = ["LISTING_ONLY_REVIEW_ORIGINAL", "LATEST_PAGE_ONLY"],
    rows: Row[] = [];
  const link = (node: { attr(name: string): string | undefined }) => {
    const href = node.attr("href");
    if (!href) throw new Error("SOURCE_SCHEMA_CHANGED");
    const resolved = new URL(href, url);
    if (resolved.protocol !== "https:" || resolved.hostname !== config.host)
      throw new Error("SOURCE_SCHEMA_CHANGED");
    return resolved.href;
  };
  if (adapter === "jo-gtd" || adapter === "ps-najah") {
    const table = root.find(
      adapter === "jo-gtd" ? "table.table-tender" : "table.table-bordered",
    );
    if (!table.length || !text(table.find("thead")).includes("رقم العطاء"))
      throw new Error("SOURCE_SCHEMA_CHANGED");
    const entries = table.find("tbody tr");
    if (!entries.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    const seen = new Set<string>();
    for (const raw of entries.toArray()) {
      const row = $(raw);
      const cells = row.find("td");
      if (cells.length !== (adapter === "jo-gtd" ? 9 : 5))
        throw new Error("SOURCE_SCHEMA_CHANGED");
      const reference =
          adapter === "jo-gtd"
            ? text(cells.eq(0)).match(/^\d+\/\d{4}/)?.[0] || ""
            : text(cells.eq(0)),
        title = text(cells.eq(1)),
        published = text(cells.eq(2));
      if (!reference || !title || !/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(published))
        throw new Error("SOURCE_SCHEMA_CHANGED");
      // These portals list newest announcements first. Retain the newest notice
      // for a repeated tender number, including extensions/re-advertisements.
      if (seen.has(reference)) {
        warnings.push("SUPERSEDED_LISTING_SKIPPED");
        continue;
      }
      seen.add(reference);
      rows.push({
        reference,
        title,
        buyer: config.buyer,
        url: link(
          adapter === "jo-gtd"
            ? row.find("a.tender-link")
            : cells.eq(1).find("a"),
        ),
        deadline_raw: [
          text(cells.eq(3)),
          adapter === "ps-najah" ? text(cells.eq(4)) : "",
        ]
          .filter(Boolean)
          .join(" "),
        description: `${title}\nتاريخ نشر الإعلان: ${published}\nهذه بيانات القائمة العامة؛ راجع الإعلان الأصلي والوثائق والشروط قبل اتخاذ قرار المشاركة.`,
      });
    }
  } else if (adapter === "ps-ramallah") {
    const entries = root.find(".home_center .cat-title a.btitle");
    if (!entries.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    for (const raw of entries.toArray()) {
      const entry = $(raw);
      const title = text(entry),
        href = link(entry),
        id = new URL(href).pathname.match(/\/Article\/(\d+)\//i)?.[1];
      if (!title || !id) throw new Error("SOURCE_SCHEMA_CHANGED");
      // Auctions and disposal notices are not procurement opportunities.
      if (/مزاد|إلغاء|الغاء/.test(title)) {
        warnings.push("NON_PROCUREMENT_NOTICE_SKIPPED");
        continue;
      }
      rows.push({
        reference: `article:${id}`,
        title,
        buyer: config.buyer,
        url: href,
        description: `${title}\nتاريخ نشر الإعلان: ${text(entry.parent().find(".news_icon"))}\nالموعد النهائي غير مبين في القائمة؛ راجع الإعلان الأصلي.`,
        deadline_raw: null,
      });
    }
  } else {
    const container = root.find(".cloudsearch-teasers");
    if (!container.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    const entries = container.find("article.type-corporate_procurement_tender");
    if (
      !entries.length &&
      !/no results|no tenders|no opportunities/i.test(text(root))
    )
      throw new Error("SOURCE_SCHEMA_CHANGED");
    for (const raw of entries.toArray()) {
      const entry = $(raw);
      const status = text(entry.find(".field--name-field-tender-status"));
      if (!status) throw new Error("SOURCE_SCHEMA_CHANGED");
      if (/closed|cancelled|canceled|awarded/i.test(status)) {
        warnings.push("CLOSED_NOTICE_SKIPPED");
        continue;
      }
      if (!/^(open|active|published)$/i.test(status))
        throw new Error("SOURCE_SCHEMA_CHANGED");
      const title = text(entry.find(".field-title")),
        href = link(entry.find(".field-title a"));
      if (!title) throw new Error("SOURCE_SCHEMA_CHANGED");
      rows.push({
        title,
        url: href,
        reference: entry.attr("data-nid") || href,
        buyer: config.buyer,
        deadline_raw: text(
          entry.find(".field--name-field-submission-deadline"),
        ),
        description: `${title}\nCountry: ${text(entry.find(".field--name-field-world-country"))}\nStatus: ${status}\nCorporate procurement can concern countries outside Saudi Arabia. Review the original notice.`,
      });
    }
  }
  if (rows.length > 100) warnings.push("ITEM_LIMIT_REACHED");
  return { rows: rows.slice(0, 100), warnings: [...new Set(warnings)] };
}
