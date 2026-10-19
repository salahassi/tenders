import { load } from "cheerio";
import { z } from "zod";
import { safeUrl } from "./contracts.ts";

// Only generic extraction operations live here. Source identities, URLs,
// selectors, labels and timezones are persisted source configuration.
const selector = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => {
    try {
      load("")(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid CSS selector");
const terms = z.array(z.string().min(1).max(200)).max(30);
const column = z.number().int().min(0).max(30);
export const extractionSchema = z
  .object({
    version: z.literal(1),
    url: safeUrl,
    buyer: z.string().min(1).max(1000),
    timezone: z
      .string()
      .max(100)
      .nullable()
      .refine((value) => {
        if (value === null) return true;
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    description_template: z.string().min(1).max(3000),
    listing: z.discriminatedUnion("layout", [
      z
        .object({
          layout: z.literal("table"),
          container: selector,
          rows: selector,
          header_contains: z.string().min(1).max(200),
          column_count: z.number().int().min(1).max(31),
          reference_column: column,
          reference_format: z.enum(["text", "number_year"]),
          title_column: column,
          published_column: column,
          deadline_columns: z.array(column).min(1).max(4),
          link: selector,
        })
        .strict(),
      z
        .object({
          layout: z.literal("links"),
          rows: selector,
          published: selector,
          reference_segment: z.number().int().min(0).max(20),
          reference_prefix: z.string().max(100),
          excluded_title_terms: terms,
        })
        .strict(),
      z
        .object({
          layout: z.literal("cards"),
          container: selector,
          rows: selector,
          title: selector,
          link: selector,
          reference_attribute: z
            .string()
            .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/),
          status: selector,
          open_statuses: terms,
          closed_statuses: terms,
          deadline: selector,
          country: selector,
          empty_messages: terms,
        })
        .strict(),
    ]),
    detail: z
      .object({
        root: selector,
        title: selector.optional(),
        title_scope: z.enum(["root", "document"]).default("root"),
        deadline: selector.optional(),
        title_labels: terms.default([]),
        deadline_labels: terms.default([]),
        remove: z.array(selector).max(20).default([]),
        remove_matching: z
          .array(
            z
              .object({
                selector,
                contains: terms,
                previous: z.boolean().default(false),
              })
              .strict(),
          )
          .max(10)
          .default([]),
      })
      .strict(),
  })
  .strict();
export type ExtractionConfig = z.infer<typeof extractionSchema>;
export function sourceExtraction(value: unknown): ExtractionConfig {
  const parsed = extractionSchema.safeParse(value);
  if (!parsed.success) throw new Error("ADAPTER_REQUIRED");
  return parsed.data;
}
const locationKey = (url: string) => {
  const u = new URL(url);
  return (
    u.origin +
    decodeURIComponent(u.pathname).replace(/\/$/, "").toLowerCase() +
    u.search
  );
};
export function extractionMatchesUrl(config: ExtractionConfig, url: string) {
  return locationKey(config.url) === locationKey(url);
}
type Row = Record<string, unknown>;
const text = (node: { text(): string }) =>
  node.text().replace(/\s+/g, " ").trim();
const contains = (value: string, values: string[]) =>
  values.some((term) => value.toLowerCase().includes(term.toLowerCase()));
export function parseOfficialListing(
  input: unknown,
  url: string,
  body: string,
): { rows: Row[]; warnings: string[] } {
  const config = sourceExtraction(input),
    rules = config.listing;
  if (!extractionMatchesUrl(config, url))
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
    if (
      !safeUrl.safeParse(resolved.href).success ||
      resolved.hostname !== new URL(config.url).hostname
    )
      throw new Error("SOURCE_SCHEMA_CHANGED");
    return resolved.href;
  };
  const append = (values: Row) =>
    rows.push({
      ...values,
      buyer: config.buyer,
      description: config.description_template.replace(
        /\{(title|published|country|status)\}/g,
        (_, field: string) => String(values[field] || ""),
      ),
    });
  if (rules.layout === "table") {
    const table = root.find(rules.container);
    if (
      !table.length ||
      !text(table.find("thead")).includes(rules.header_contains)
    )
      throw new Error("SOURCE_SCHEMA_CHANGED");
    const entries = table.find(rules.rows);
    if (!entries.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    const seen = new Set<string>();
    for (const raw of entries.toArray()) {
      const row = $(raw),
        cells = row.find("td");
      if (cells.length !== rules.column_count)
        throw new Error("SOURCE_SCHEMA_CHANGED");
      const rawReference = text(cells.eq(rules.reference_column));
      const reference =
        rules.reference_format === "number_year"
          ? rawReference.match(/^\d+\/\d{4}/)?.[0] || ""
          : rawReference;
      const title = text(cells.eq(rules.title_column)),
        published = text(cells.eq(rules.published_column));
      if (!reference || !title || !/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(published))
        throw new Error("SOURCE_SCHEMA_CHANGED");
      if (seen.has(reference)) {
        warnings.push("SUPERSEDED_LISTING_SKIPPED");
        continue;
      }
      seen.add(reference);
      append({
        reference,
        title,
        published,
        url: link(row.find(rules.link)),
        deadline_raw: rules.deadline_columns
          .map((i) => text(cells.eq(i)))
          .filter(Boolean)
          .join(" "),
      });
    }
  } else if (rules.layout === "links") {
    const entries = root.find(rules.rows);
    if (!entries.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    for (const raw of entries.toArray()) {
      const entry = $(raw),
        title = text(entry),
        href = link(entry);
      const id = new URL(href).pathname.split("/")[rules.reference_segment];
      if (!title || !id) throw new Error("SOURCE_SCHEMA_CHANGED");
      if (contains(title, rules.excluded_title_terms)) {
        warnings.push("NON_PROCUREMENT_NOTICE_SKIPPED");
        continue;
      }
      append({
        reference: rules.reference_prefix + id,
        title,
        url: href,
        published: text(entry.parent().find(rules.published)),
        deadline_raw: null,
      });
    }
  } else {
    const container = root.find(rules.container);
    if (!container.length) throw new Error("SOURCE_SCHEMA_CHANGED");
    const entries = container.find(rules.rows);
    if (!entries.length && !contains(text(root), rules.empty_messages))
      throw new Error("SOURCE_SCHEMA_CHANGED");
    for (const raw of entries.toArray()) {
      const entry = $(raw),
        status = text(entry.find(rules.status));
      if (!status) throw new Error("SOURCE_SCHEMA_CHANGED");
      if (contains(status, rules.closed_statuses)) {
        warnings.push("CLOSED_NOTICE_SKIPPED");
        continue;
      }
      if (
        !rules.open_statuses.some(
          (s) => s.toLowerCase() === status.toLowerCase(),
        )
      )
        throw new Error("SOURCE_SCHEMA_CHANGED");
      const title = text(entry.find(rules.title)),
        href = link(entry.find(rules.link));
      if (!title) throw new Error("SOURCE_SCHEMA_CHANGED");
      append({
        title,
        url: href,
        reference: entry.attr(rules.reference_attribute) || href,
        deadline_raw: text(entry.find(rules.deadline)),
        country: text(entry.find(rules.country)),
        status,
      });
    }
  }
  if (rows.length > 100) warnings.push("ITEM_LIMIT_REACHED");
  return { rows: rows.slice(0, 100), warnings: [...new Set(warnings)] };
}
