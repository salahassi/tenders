import { load } from "cheerio";
import { getDocumentProxy } from "unpdf";
import {
  CollectionError,
  canonical,
  inertText,
  publicAddress,
  type SourceInput,
} from "./collector.ts";
import { safeUrl } from "./contracts.ts";
import { sourceExtraction } from "./officialListings.ts";

type Row = Record<string, any>;
const MAX_TEXT = 50000;
const MAX_PDF = 5 * 1024 * 1024;
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

// Every detail/attachment/redirect retains BOTH hostname approvals and public DNS checks.
export async function fetchPublicNotice(
  url: string,
  source: SourceInput,
  hosts: string[],
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch,
  signal: AbortSignal,
  maxBytes: number,
  observedPublicUrl = false,
) {
  for (let hop = 0; hop <= 3; hop++) {
    if (!safeUrl.safeParse(url).success)
      throw new CollectionError("UNSAFE_DESTINATION");
    const host = new URL(url).hostname;
    if (
      !observedPublicUrl &&
      (!source.approved_hosts.includes(host) || !hosts.includes(host))
    )
      throw new CollectionError("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
    const ips = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new CollectionError("SOURCE_TIMEOUT"));
        else
          signal.addEventListener(
            "abort",
            () => reject(new CollectionError("SOURCE_TIMEOUT")),
            { once: true },
          );
      }),
    ]);
    if (!ips.length || ips.some((ip) => !publicAddress(ip)))
      throw new CollectionError("UNSAFE_DESTINATION");
    const response = await fetcher(url, {
      redirect: "manual",
      signal,
      headers: {
        Accept: "text/html,application/pdf;q=0.9",
        "User-Agent": "TenderDesk public notice reader",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get("location");
      if (!next || hop === 3) throw new CollectionError("REDIRECT_LIMIT");
      url = new URL(next, url).href;
      continue;
    }
    if ([401, 403].includes(response.status))
      throw new CollectionError("MANUAL_SOURCE_REQUIRED");
    if (response.status === 429 || response.status >= 500)
      throw new CollectionError("SOURCE_TEMPORARY_FAILURE");
    if (!response.ok) throw new CollectionError("SOURCE_UNAVAILABLE");
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new CollectionError("SOURCE_TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CollectionError("SOURCE_EMPTY");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
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

export function minimizedNotice(text: string) {
  return inertText(
    text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/(?:هاتف|فاكس|البريد الالكتروني|البريد الإلكتروني|للاستفسار|رئيس البلد|contact person|contact name|fax\s*:|telephone\s*:|email\s*:|\[email protected\])/i.test(
            line,
          ),
      )
      .join("\n"),
    MAX_TEXT + 1,
  );
}

// Parse a labeled submission clause, never the first date (often the purchase deadline).
export function submissionDeadline(
  timezone: string | null,
  text: string,
  labeled?: string,
) {
  const normalized = (
    labeled ||
    text
      .split("\n")
      .find((line) =>
        /(?:يجب تسليم العطاءات|آخر موعد لتسليم|اخر موعد لتسليم|الموعد النهائي|تاريخ الايداع:|تاريخ الإيداع:)/.test(
          line,
        ),
      ) ||
    ""
  ).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const iso = normalized.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const dmy = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (!iso && !dmy)
    return { raw: normalized || null, local: null, timezone: null, date: null };
  const year = Number(iso?.[1] || dmy?.[3]),
    month = Number(iso?.[2] || dmy?.[2]),
    day = Number(iso?.[3] || dmy?.[1]);
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsedDate = new Date(date + "T00:00:00Z");
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  )
    return { raw: normalized, local: null, timezone: null, date: null };
  const time = normalized.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  let hour = time ? Number(time[1]) : null;
  if (hour !== null && /مساء|\bPM\b|\sم(?:\s|$)/i.test(normalized) && hour < 12)
    hour += 12;
  if (hour === 12 && /صباح|\bAM\b/i.test(normalized)) hour = 0;
  const validTime = hour !== null && hour < 24 && Number(time![2]) < 60;
  return {
    raw: normalized,
    date,
    timezone,
    local: validTime
      ? `${date}T${String(hour).padStart(2, "0")}:${time![2]}:00`
      : null,
  };
}

export function parseNoticeDetails(input: unknown, url: string, html: string) {
  const config = sourceExtraction(input);
  if (
    !safeUrl.safeParse(url).success ||
    new URL(url).hostname !== new URL(config.url).hostname
  )
    throw new CollectionError("OFFICIAL_ADAPTER_URL_MISMATCH");
  if (
    /captcha|type\s*=\s*["']password|automated access (?:is )?(?:prohibited|forbidden)/i.test(
      html,
    )
  )
    throw new CollectionError("MANUAL_SOURCE_REQUIRED");
  const $ = load(html);
  // ASP.NET portals wrap their public article in a form. Remove controls, not the article container.
  $("script,style,header,footer,nav,input,textarea,button").remove();
  const rules = config.detail;
  const root = $(rules.root);
  if (root.length !== 1)
    throw new CollectionError("NOTICE_DETAIL_SCHEMA_CHANGED");
  const attachments = [
    ...new Set(
      root
        .find("a[href]")
        .map((_, a) => {
          const href = $(a).attr("href")!.replaceAll("\\", "/");
          try {
            const u = new URL(href, url);
            return /\.(pdf|docx?|xlsx?)(?:$|\?)/i.test(u.pathname + u.search) &&
              safeUrl.safeParse(u.href).success
              ? u.href
              : null;
          } catch {
            return null;
          }
        })
        .get()
        .filter(Boolean),
    ),
  ] as string[];
  let title = rules.title
    ? (rules.title_scope === "document"
        ? $(rules.title)
        : root.find(rules.title)
      )
        .first()
        .text()
        .trim()
    : "";
  let closing = rules.deadline ? root.find(rules.deadline).text().trim() : "";
  root.find("dl dt").each((_, term) => {
    const label = $(term).text().trim(),
      value = $(term).next("dd").text().trim();
    if (rules.title_labels.includes(label)) title = value;
    if (rules.deadline_labels.includes(label)) closing = value;
  });
  root.find("tr").each((_, row) => {
    const cells = $(row).find("td,th"),
      label = cells.first().text().trim();
    if (rules.title_labels.includes(label)) title = cells.last().text().trim();
    if (rules.deadline_labels.includes(label))
      closing = cells.last().text().trim();
  });
  for (const selector of rules.remove) root.find(selector).remove();
  for (const rule of rules.remove_matching) {
    root
      .find(rule.selector)
      .filter((_, node) =>
        rule.contains.some((term) => $(node).text().includes(term)),
      )
      .each((_, node) => {
        if (rule.previous) $(node).prev(rule.selector).remove();
        $(node).remove();
      });
  }
  root.find("dt").append(": ");
  root.find("dd").append("\n");
  root.find("br").replaceWith("\n");
  root.find("p,li,tr,div").append("\n");
  const text = minimizedNotice(root.text())
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
  if (text.length < 80) throw new CollectionError("NOTICE_DETAILS_NEED_OCR");
  if (text.length > MAX_TEXT)
    throw new CollectionError("NOTICE_DETAIL_TOO_LARGE");
  return {
    title,
    text,
    attachments,
    deadline: submissionDeadline(config.timezone, text, closing),
  };
}

export async function readPublicPdf(bytes: Uint8Array) {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new CollectionError("ATTACHMENT_FORMAT_INVALID");
  const pdf = await getDocumentProxy(bytes, {
    enableXfa: false,
    useSystemFonts: false,
    stopAtErrors: true,
  });
  try {
    if (pdf.numPages > 100) throw new CollectionError("ATTACHMENT_PAGE_LIMIT");
    const pages: { page: number; text: string; restricted: boolean }[] = [];
    let chars = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const p = await pdf.getPage(page),
        content = await p.getTextContent();
      const raw = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");
      chars += raw.length;
      if (chars > 500000) throw new CollectionError("ATTACHMENT_TEXT_LIMIT");
      // Restricted pages are not silently authorized by public-notice permission.
      const restricted =
        /confidential|strictly private|سري للغاية|سرية|password\s*[:=]|api[_ -]?key\s*[:=]|-----BEGIN .*PRIVATE KEY/i.test(
          raw,
        );
      pages.push({
        page,
        text: restricted ? "" : minimizedNotice(raw),
        restricted,
      });
      p.cleanup();
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export function parseAutomaticNoticeDetails(
  url: string,
  html: string,
  requestedUrl = url,
) {
  const $ = load(html);
  removePrivacyNavigation($);
  const requiresLogin = $("input[type=password]").length > 0;
  const hasScript = $("script").length > 0;
  $(
    "script,style,header,footer,nav,input,textarea,button,noscript,template",
  ).remove();
  const main = $("main,article,[role=main]").first();
  const root = main.length ? main : $("body");
  const title = root.find("h1").first().text().trim();
  const attachments = [
    ...new Set(
      root
        .find("a[href]")
        .toArray()
        .map((node) => canonical($(node).attr("href"), url))
        .filter((link): link is string =>
          Boolean(link && /\.(pdf|docx?|xlsx?)(?:$|\?)/i.test(link)),
        ),
    ),
  ];
  root.find("br").replaceWith("\n");
  root.find("p,li,tr,div,dt,dd").append("\n");
  const text = minimizedNotice(root.text())
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
  if (text.length < 80) {
    // A short article/sidebar on a redirected landing page is not proof of a scanned notice.
    const otherText = minimizedNotice($("body").text()).trim();
    throw new CollectionError(
      requiresLogin
        ? "SOURCE_LOGIN_REQUIRED"
        : url !== requestedUrl
          ? "SOURCE_NOTICE_REDIRECTED"
          : otherText.length >= 80
            ? "NOTICE_DETAILS_CONTENT_UNRESOLVED"
            : $("img,canvas").length
              ? "NOTICE_DETAILS_NEED_OCR"
              : hasScript
                ? "SOURCE_BROWSER_REQUIRED"
                : "SOURCE_EMPTY",
    );
  }
  if (text.length > MAX_TEXT)
    throw new CollectionError("NOTICE_DETAIL_TOO_LARGE");
  return { title, text, attachments, deadline: submissionDeadline(null, text) };
}

// A link to the site's privacy policy is navigation, not a confidentiality marking
// on a tender. Keep privacy-related tender text/documents and all other markers intact.
export function removePrivacyNavigation($: ReturnType<typeof load>) {
  $("a[href]").each((_, node) => {
    const label = $(node).text().replace(/\s+/g, " ").trim();
    const href = $(node).attr("href") || "";
    if (
      /privacy/i.test(href) &&
      /^(privacy (policy|statement)|سياسة الخصوصية(?: وسرية المعلومات)?)$/i.test(
        label,
      )
    )
      $(node).remove();
  });
}

export async function enrichPublicNotice(
  source: SourceInput,
  notice: Row,
  hosts: string[],
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch = fetch,
) {
  if (source.approval !== "approved" || !source.policy_note.trim())
    throw new CollectionError("SOURCE_PERMISSION_REQUIRED");
  const automatic = (source.adapter_config as Row)?.automatic === true;
  let extraction;
  try {
    if (!automatic)
      extraction = sourceExtraction((source.adapter_config as Row).extraction);
  } catch {
    throw new CollectionError("ADAPTER_REQUIRED");
  }
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const page = await fetchPublicNotice(
      notice.canonical_url,
      source,
      hosts,
      resolve,
      fetcher,
      controller.signal,
      automatic ? MAX_PDF : 1048576,
      automatic,
    );
    const isPdf = new TextDecoder().decode(page.bytes.slice(0, 5)) === "%PDF-";
    const directPages =
      automatic && isPdf ? await readPublicPdf(page.bytes) : null;
    if (directPages?.some((p) => p.restricted))
      throw new CollectionError("SOURCE_DOCUMENT_RESTRICTED");
    if (directPages?.some((p) => !p.restricted && p.text.length < 30))
      throw new CollectionError("NOTICE_DETAILS_NEED_OCR");
    const detail = directPages
      ? {
          title: "",
          text: directPages.map((p) => p.text).join("\n"),
          attachments: [] as string[],
          deadline: submissionDeadline(
            null,
            directPages.map((p) => p.text).join("\n"),
          ),
        }
      : automatic
        ? parseAutomaticNoticeDetails(
            page.url,
            new TextDecoder("utf-8", { fatal: true }).decode(page.bytes),
            notice.canonical_url,
          )
        : parseNoticeDetails(
            extraction,
            page.url,
            new TextDecoder("utf-8", { fatal: true }).decode(page.bytes),
          );
    if (detail.text.length > MAX_TEXT)
      throw new CollectionError("NOTICE_DETAIL_TOO_LARGE");
    let description = `[Public notice: ${page.url}]\n${detail.text}`;
    const attachments: Row[] = [];
    for (const url of detail.attachments.slice(0, 3)) {
      const record: Row = { url, status: "unread", included_pages: [] };
      attachments.push(record);
      try {
        if (!/\.pdf$/i.test(new URL(url).pathname))
          throw new CollectionError("ATTACHMENT_FORMAT_UNSUPPORTED");
        const file = await fetchPublicNotice(
          url,
          source,
          hosts,
          resolve,
          fetcher,
          controller.signal,
          MAX_PDF,
          automatic,
        );
        record.sha256 = await digest(file.bytes);
        const pages = await readPublicPdf(file.bytes);
        record.total_pages = pages.length;
        record.restricted_pages = pages
          .filter((p) => p.restricted)
          .map((p) => p.page);
        record.ocr_pages = pages
          .filter((p) => !p.restricted && p.text.length < 30)
          .map((p) => p.page);
        // Read all pages, retain complete eligible pages within the notice boundary.
        for (const p of pages) {
          if (!p.text || p.text.length < 30) continue;
          const section = `\n[Public attachment ${url}, page ${p.page}]\n${p.text}`;
          if (description.length + section.length <= MAX_TEXT) {
            description += section;
            record.included_pages.push(p.page);
          }
        }
        record.status =
          record.included_pages.length === pages.length
            ? "read"
            : record.included_pages.length
              ? "partial"
              : record.ocr_pages.length
                ? "needs_ocr"
                : "authorization_required";
      } catch (error) {
        record.status = "unread";
        record.error =
          error instanceof CollectionError
            ? error.code
            : "ATTACHMENT_READ_FAILED";
      }
    }
    for (const url of detail.attachments.slice(3))
      attachments.push({
        url,
        status: "unread",
        error: "ATTACHMENT_COUNT_LIMIT",
      });
    // Limitations are evidence, not missing facts. Never claim the complete RFP was read.
    const partial = attachments.some((a) => a.status !== "read");
    const metadata = {
      version: 1,
      status: partial ? "partial" : "read",
      detail_url: page.url,
      detail_sha256: await digest(page.bytes),
      fetched_at: new Date().toISOString(),
      attachments,
      deadline: detail.deadline,
    };
    return {
      ...notice,
      title: detail.title || notice.title,
      description,
      deadline_raw: detail.deadline.raw || notice.deadline_raw,
      notice_evidence: metadata,
    };
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError("SOURCE_TEMPORARY_FAILURE");
  } finally {
    clearTimeout(timeout);
  }
}
