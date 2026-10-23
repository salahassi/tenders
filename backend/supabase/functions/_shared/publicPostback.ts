import { load } from "cheerio";
import {
  CollectionError,
  publicAddress,
  publicLoginRequired,
  type SourceInput,
} from "./collector.ts";
import { safeUrl } from "./contracts.ts";
import {
  publicPostbackSchema,
  type PublicPostbackConfig,
} from "./publicPostbackConfig.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_REQUESTS = 6;
const normalize = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** Follow one explicitly observed public ASP.NET detail link in an anonymous session. */
export async function readPublicPostback(
  input: PublicPostbackConfig,
  notice: { title: string; reference?: string },
  source: SourceInput,
  hosts: string[],
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  const parsed = publicPostbackSchema.safeParse(input);
  if (!parsed.success) throw new CollectionError("ADAPTER_REQUIRED");
  const config = parsed.data;
  if (source.approval !== "approved" || !source.policy_note.trim())
    throw new CollectionError("SOURCE_PERMISSION_REQUIRED");
  const origin = new URL(source.url).origin;
  let requests = 0;
  let sessionCookie = "";

  function bounded<T>(operation: Promise<T>): Promise<T> {
    if (signal.aborted)
      return Promise.reject(new CollectionError("SOURCE_TIMEOUT"));
    return new Promise<T>((accept, reject) => {
      const abort = () => reject(new CollectionError("SOURCE_TIMEOUT"));
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          accept(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  async function request(startUrl: string, form?: URLSearchParams) {
    let url = startUrl;
    let body = form?.toString();
    for (let hop = 0; hop <= 3; hop++) {
      if (signal.aborted) throw new CollectionError("SOURCE_TIMEOUT");
      if (!safeUrl.safeParse(url).success || new URL(url).origin !== origin)
        throw new CollectionError("UNSAFE_DESTINATION");
      const host = new URL(url).hostname;
      if (!source.approved_hosts.includes(host) || !hosts.includes(host))
        throw new CollectionError("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
      const ips = await bounded(resolve(host));
      if (!ips.length || ips.some((ip) => !publicAddress(ip)))
        throw new CollectionError("UNSAFE_DESTINATION");
      if (++requests > MAX_REQUESTS)
        throw new CollectionError("PUBLIC_POSTBACK_REQUEST_LIMIT");
      const headers = new Headers({
        "Accept-Encoding": "identity",
        Accept: "text/html",
        "User-Agent": "TenderDesk public notice reader",
      });
      if (body !== undefined)
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      if (sessionCookie) headers.set("Cookie", sessionCookie);
      const response = await bounded(
        fetcher(url, {
          method: body === undefined ? "GET" : "POST",
          headers,
          body,
          redirect: "manual",
          signal,
        }),
      );
      // Only the anonymous ASP.NET session cookie is needed. Do not retain
      // authentication/tracking cookies or share state across notices/jobs.
      for (const cookie of response.headers.getSetCookie()) {
        const match =
          /^\s*(ASP\.NET_SessionId)=([A-Za-z0-9_-]{1,200})(?:;|$)/i.exec(
            cookie,
          );
        if (match) sessionCookie = `${match[1]}=${match[2]}`;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || hop === 3) throw new CollectionError("REDIRECT_LIMIT");
        if (body !== undefined && [307, 308].includes(response.status))
          throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
        url = new URL(location, url).href;
        body = undefined;
        continue;
      }
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        throw new CollectionError("MANUAL_SOURCE_REQUIRED");
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new CollectionError("SOURCE_TEMPORARY_FAILURE");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CollectionError("SOURCE_UNAVAILABLE");
      }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body?.cancel();
        throw new CollectionError("SOURCE_TOO_LARGE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CollectionError("SOURCE_EMPTY");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        if (signal.aborted) {
          await reader.cancel();
          throw new CollectionError("SOURCE_TIMEOUT");
        }
        const { value, done } = await bounded(reader.read());
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new CollectionError("SOURCE_TOO_LARGE");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        url,
        bytes,
        contentType: response.headers.get("content-type") || "",
      };
    }
    throw new CollectionError("REDIRECT_LIMIT");
  }

  const listing = await request(config.url);
  const html = new TextDecoder("utf-8", { fatal: true }).decode(listing.bytes);
  if (
    publicLoginRequired(html) ||
    /captcha|automated access (?:is )?(?:prohibited|forbidden)/i.test(html)
  )
    throw new CollectionError("MANUAL_SOURCE_REQUIRED");
  const $ = load(html);
  const matches = $(config.rows)
    .toArray()
    .filter((row) => {
      const title = normalize($(row).find(config.title).text());
      const reference = config.reference
        ? normalize($(row).find(config.reference).text())
        : null;
      return (
        title === normalize(notice.title) &&
        (reference === null || reference === normalize(notice.reference || ""))
      );
    });
  if (matches.length !== 1)
    throw new CollectionError("PUBLIC_NOTICE_IDENTITY_UNRESOLVED");
  const row = $(matches[0]);
  const link = row.find(config.link);
  if (link.length !== 1 || link[0].tagName !== "a")
    throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
  const event =
    /^javascript:__doPostBack\(\s*'([$A-Za-z0-9_]+)'\s*,\s*''\s*\)\s*;?$/i.exec(
      link.attr("href") || "",
    );
  if (
    !event ||
    !/(?:^|\$)(?:lnk|link)?(?:details?|view)$/i.test(event[1]) ||
    /(?:delete|remove|purchase|payment|buy|submit|login|register|accept|approve)/i.test(
      event[1],
    )
  )
    throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
  const form = link.closest("form");
  if (
    form.length !== 1 ||
    (form.attr("method") || "get").toLowerCase() !== "post"
  )
    throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
  const destination = new URL(form.attr("action") || listing.url, listing.url);
  if (
    destination.origin !== origin ||
    destination.username ||
    destination.password
  )
    throw new CollectionError("UNSAFE_DESTINATION");
  const fields = new URLSearchParams();
  form.find("input[type=hidden][name]").each((_, node) => {
    const name = $(node).attr("name")!;
    if (
      !/^__(?:VIEWSTATE(?:\d+|FIELDCOUNT|GENERATOR)?|EVENTVALIDATION)$/.test(
        name,
      )
    )
      return;
    if (fields.has(name))
      throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
    fields.set(name, $(node).attr("value") || "");
  });
  if (
    !fields.has("__VIEWSTATE") ||
    !fields.has("__EVENTVALIDATION") ||
    fields.toString().length > MAX_BYTES
  )
    throw new CollectionError("PUBLIC_POSTBACK_UNSAFE_NAVIGATION");
  fields.set("__EVENTTARGET", event[1]);
  fields.set("__EVENTARGUMENT", "");
  const result = await request(destination.href, fields);
  return { ...result, title: normalize(row.find(config.title).text()) };
}
