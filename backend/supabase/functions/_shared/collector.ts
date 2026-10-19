import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { safeUrl } from "./contracts.ts";
import { parseOfficialListing } from "./officialListings.ts";

export class CollectionError extends Error {
  constructor(
    public code: string,
    public retryAfter: string | null = null,
  ) {
    super(code);
  }
}
const path = z
  .string()
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){0,9}$/)
  .refine(
    (p) =>
      !p
        .split(".")
        .some((x) => ["__proto__", "prototype", "constructor"].includes(x)),
  );
export const adapterSchema = z
  .object({
    items: path.default("items"),
    fields: z
      .object({
        title: path.default("title"),
        description: path.default("description"),
        url: path.default("url"),
        reference: path.default("id"),
        buyer: path.default("buyer"),
        deadline_raw: path.default("deadline"),
      })
      .strict()
      .default({
        title: "title",
        description: "description",
        url: "url",
        reference: "id",
        buyer: "buyer",
        deadline_raw: "deadline",
      }),
  })
  .strict();
export type SourceInput = {
  id: string;
  url: string;
  kind: string;
  approval: string;
  approved_hosts: string[];
  policy_note: string;
  adapter_config: unknown;
  etag?: string | null;
  last_modified?: string | null;
};
export interface CollectedItem {
  identity_key: string;
  title: string;
  description: string;
  buyer: string;
  reference: string;
  canonical_url: string | null;
  deadline_raw: string | null;
  deadline_at: null;
  deadline_timezone: null;
  language: "en" | "ar";
}
export interface CollectionResult {
  status: number;
  etag: string | null;
  last_modified: string | null;
  items: CollectedItem[];
  candidates: { url: string; name: string }[];
  warnings: string[];
}
export function publicAddress(address: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const a = address.split(".").map(Number);
  if (a.some((x) => x > 255)) return false;
  return !(
    a[0] === 0 ||
    a[0] === 10 ||
    a[0] === 127 ||
    a[0] >= 224 ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && (a[1] === 168 || a[1] === 0 || a[1] === 2)) ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19 || a[1] === 51)) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113)
  );
}
export function inertText(value: unknown, max = 100000): string {
  let text =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  text = text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, " ");
  // Minimize public notice data; contact lines, addresses and telephone strings are not model/company evidence.
  text = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/(?:contact person|contact name|جهة الاتصال|مسؤول التواصل|signature|توقيع)\s*[:：]/i.test(
          line,
        ),
    )
    .join("\n");
  text = text
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[contact removed]")
    .replace(
      /(?:\+\d[\d ()-]{7,}\d)|(?:\b\d{3}[- .]\d{3}[- .]\d{4}\b)/g,
      "[contact removed]",
    );
  return text
    .normalize("NFC")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);
}
export function canonical(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value, base);
    if (!safeUrl.safeParse(u.href).success) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (/^utm_|^fbclid$|^gclid$/i.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    return u.href;
  } catch {
    return null;
  }
}
const at = (value: unknown, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (current, k) =>
        current && typeof current === "object" && Object.hasOwn(current, k)
          ? (current as Record<string, unknown>)[k]
          : undefined,
      value,
    );
function item(
  row: Record<string, unknown>,
  base: string,
): CollectedItem | null {
  const title = inertText(row.title, 1000),
    url = canonical(row.url, base),
    reference = inertText(row.reference, 1000);
  if (!title || (!url && !reference)) return null;
  return {
    identity_key: reference ? `external:${reference}` : `url:${url}`,
    title,
    description: inertText(row.description),
    buyer: inertText(row.buyer, 1000),
    reference,
    canonical_url: url,
    deadline_raw: inertText(row.deadline_raw, 1000) || null,
    deadline_at: null,
    deadline_timezone: null,
    language: /[\u0600-\u06ff]/.test(title) ? "ar" : "en",
  };
}
export function parseSource(
  source: SourceInput,
  body: string,
): Pick<CollectionResult, "items" | "candidates" | "warnings"> {
  const warnings: string[] = [];
  let rows: Record<string, unknown>[] = [];
  const official =
    source.adapter_config &&
    typeof source.adapter_config === "object" &&
    "official_listing" in source.adapter_config
      ? source.adapter_config.official_listing
      : undefined;
  if (source.kind === "link_directory" && official !== undefined) {
    try {
      const parsed = parseOfficialListing(
        (source.adapter_config as Record<string, unknown>).extraction,
        source.url,
        body,
      );
      rows = parsed.rows;
      warnings.push(...parsed.warnings);
    } catch (error) {
      throw new CollectionError(
        error instanceof Error &&
          ["ADAPTER_REQUIRED", "OFFICIAL_ADAPTER_URL_MISMATCH"].includes(
            error.message,
          )
          ? error.message
          : "SOURCE_SCHEMA_CHANGED",
      );
    }
  } else if (source.kind === "link_directory") {
    const candidates: { url: string; name: string }[] = [],
      seen = new Set<string>();
    const clean = body.replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    );
    for (const match of clean.matchAll(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    )) {
      const url = canonical(match[1], source.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (candidates.length === 100) {
        warnings.push("ITEM_LIMIT_REACHED");
        break;
      }
      candidates.push({
        url,
        name: inertText(match[2], 200) || new URL(url).hostname,
      });
    }
    return { items: [], candidates, warnings };
  } else if (source.kind === "json_feed") {
    const config = adapterSchema.parse(source.adapter_config);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new CollectionError("SOURCE_SCHEMA_CHANGED");
    }
    const list = Array.isArray(value) ? value : at(value, config.items);
    if (!Array.isArray(list))
      throw new CollectionError("SOURCE_SCHEMA_CHANGED");
    rows = list
      .slice(0, 100)
      .map((row) =>
        Object.fromEntries(
          Object.entries(config.fields).map(([key, p]) => [key, at(row, p)]),
        ),
      );
    if (list.length > 100) warnings.push("ITEM_LIMIT_REACHED");
  } else if (source.kind === "rss") {
    if (/<!DOCTYPE|<!ENTITY/i.test(body))
      throw new CollectionError("UNSAFE_XML");
    let depth = 0;
    for (const token of body.matchAll(/<\/?[\w:-]+\b[^>]*>/g)) {
      if (token[0].startsWith("</")) depth--;
      else if (!token[0].endsWith("/>")) depth++;
      if (depth > 64) throw new CollectionError("UNSAFE_XML");
    }
    let parsed: any;
    try {
      parsed = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        parseTagValue: false,
        isArray: (name) => ["item", "entry"].includes(name),
      }).parse(body);
    } catch {
      throw new CollectionError("SOURCE_SCHEMA_CHANGED");
    }
    const list = parsed.rss?.channel?.item || parsed.feed?.entry;
    if (!Array.isArray(list))
      throw new CollectionError("SOURCE_SCHEMA_CHANGED");
    const content = (v: any) => (typeof v === "object" ? v?.["#text"] : v);
    rows = list.slice(0, 100).map((r: any) => ({
      title: content(r.title),
      description: content(r.description || r.summary || r.content),
      url:
        typeof r.link === "string"
          ? r.link
          : Array.isArray(r.link)
            ? r.link.find(
                (x: any) => !x["@_rel"] || x["@_rel"] === "alternate",
              )?.["@_href"]
            : r.link?.["@_href"],
      reference: content(r.guid || r.id),
      buyer: content(r.buyer),
      deadline_raw: content(r.deadline),
    }));
    if (list.length > 100) warnings.push("ITEM_LIMIT_REACHED");
  } else throw new CollectionError("ADAPTER_REQUIRED");
  if (
    rows.some((r) =>
      Object.values(r).some((v) => typeof v === "string" && v.length > 100000),
    )
  )
    warnings.push("FIELD_TRUNCATED_REVIEW_REQUIRED");
  const items = rows
    .map((r) => item(r, source.url))
    .filter((r): r is CollectedItem => !!r);
  if (items.length < rows.length)
    warnings.push(`INVALID_ITEMS:${rows.length - items.length}`);
  return { items, candidates: [], warnings };
}
export async function collect(
  source: SourceInput,
  deploymentHosts: string[],
  resolve: (hostname: string) => Promise<string[]>,
  fetcher: typeof fetch = fetch,
): Promise<CollectionResult> {
  if (source.approval !== "approved" || !source.policy_note.trim())
    throw new CollectionError("SOURCE_PERMISSION_REQUIRED");
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 20000);
  try {
    let url = source.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!safeUrl.safeParse(url).success)
        throw new CollectionError("UNSAFE_DESTINATION");
      const host = new URL(url).hostname.toLowerCase();
      if (
        !source.approved_hosts.includes(host) ||
        !deploymentHosts.includes(host)
      )
        throw new CollectionError("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
      const addresses = await new Promise<string[]>((resolveResult, reject) => {
        const abort = () => reject(new CollectionError("SOURCE_TIMEOUT"));
        if (controller.signal.aborted) {
          abort();
          return;
        }
        controller.signal.addEventListener("abort", abort, { once: true });
        resolve(host)
          .then(resolveResult, reject)
          .finally(() => controller.signal.removeEventListener("abort", abort));
      });
      if (!addresses.length || addresses.some((a) => !publicAddress(a)))
        throw new CollectionError("UNSAFE_DESTINATION");
      const headers: Record<string, string> = {
        Accept:
          "application/rss+xml, application/atom+xml, application/json, text/html;q=0.5",
      };
      if (source.etag) headers["If-None-Match"] = source.etag;
      if (source.last_modified)
        headers["If-Modified-Since"] = source.last_modified;
      const response = await fetcher(url, {
        redirect: "manual",
        headers,
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 3)
          throw new CollectionError("REDIRECT_LIMIT");
        url = new URL(location, url).href;
        continue;
      }
      const result = {
        status: response.status,
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        items: [],
        candidates: [],
        warnings: [],
      } as CollectionResult;
      if (response.status === 304) return result;
      if ([401, 403].includes(response.status))
        throw new CollectionError("MANUAL_SOURCE_REQUIRED");
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const retry =
          raw && /^\d+$/.test(raw)
            ? new Date(Date.now() + Number(raw) * 1000).toISOString()
            : raw && Number.isFinite(Date.parse(raw))
              ? new Date(raw).toISOString()
              : null;
        throw new CollectionError("SOURCE_QUOTA_WAIT", retry);
      }
      if (response.status >= 500)
        throw new CollectionError("SOURCE_TEMPORARY_FAILURE");
      if (!response.ok) throw new CollectionError("SOURCE_UNAVAILABLE");
      if (Number(response.headers.get("content-length")) > 1048576) {
        await response.body?.cancel();
        throw new CollectionError("SOURCE_TOO_LARGE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CollectionError("SOURCE_EMPTY");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) {
          await reader.cancel();
          throw new CollectionError("SOURCE_TOO_LARGE");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (
        /captcha|type\s*=\s*["']password|automated access (?:is )?(?:prohibited|forbidden)/i.test(
          body,
        )
      )
        throw new CollectionError("MANUAL_SOURCE_REQUIRED");
      return { ...result, ...parseSource({ ...source, url }, body) };
    }
    throw new CollectionError("REDIRECT_LIMIT");
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError("SOURCE_TEMPORARY_FAILURE");
  } finally {
    clearTimeout(timeout);
  }
}
