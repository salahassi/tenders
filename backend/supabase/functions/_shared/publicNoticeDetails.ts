import { load } from "cheerio";
import { getDocumentProxy } from "unpdf";
import {
  CollectionError,
  canonical,
  inertText,
  publicAddress,
  publicLoginRequired,
  type SourceInput,
} from "./collector.ts";
import { safeUrl } from "./contracts.ts";
import { sourceExtraction, type ExtractionConfig } from "./officialListings.ts";
import { readPublicPostback } from "./publicPostback.ts";
import { hasRestrictedDocumentContent } from "./contentPolicy.ts";

type Row = Record<string, any>;
export type PublicNoticeOcrReader = (input: {
  url: string;
  sha256: string;
  pages: number[];
  total_pages: number;
  mime: string;
}) => Promise<{ pages: { page: number; text: string; confidence: number }[] }>;
export type PublicNoticePageReader = (input: {
  url: string;
}) => Promise<{ url: string; html: string; warnings?: string[] }>;
const MAX_TEXT = 50000;
const MAX_PDF = 5 * 1024 * 1024;
function publicImageMime(bytes: Uint8Array) {
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  throw new CollectionError("ATTACHMENT_FORMAT_UNSUPPORTED");
}
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
        "Accept-Encoding": "identity",
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
  const lines = text.split("\n");
  const closingLine = lines.findIndex((line) =>
    /(?:يجب تسليم العطاءات|آخر موعد لتسليم|اخر موعد لتسليم|آخر موعد لإيداع|الموعد النهائي|تاريخ الايداع:|تاريخ الإيداع:|closing\s+date(?:time)?|submission\s+deadline|deadline\s+for\s+submission)/i.test(
      line,
    ),
  );
  const closingText =
    closingLine < 0 ? "" : lines.slice(closingLine, closingLine + 2).join("\n");
  const normalized = (labeled || closingText).replace(/[٠-٩]/g, (d) =>
    String("٠١٢٣٤٥٦٧٨٩".indexOf(d)),
  );
  const iso = normalized.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const dmy = normalized.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
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
    publicLoginRequired(html) ||
    /captcha|automated access (?:is )?(?:prohibited|forbidden)/i.test(html)
  )
    throw new CollectionError("MANUAL_SOURCE_REQUIRED");
  const $ = load(html);
  removeHiddenNoticeUi($);
  removePrivacyNavigation($);
  preserveReadonlyNoticeFields($);
  // ASP.NET portals wrap their public article in a form. Remove controls, not the article container.
  $("script,style,header,footer,nav,input,textarea,button").remove();
  const rules = config.detail;
  const root = $(rules.root);
  if (root.length !== 1)
    throw new CollectionError("NOTICE_DETAIL_SCHEMA_CHANGED");
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
  const images = rules.images
    ? [
        ...new Set(
          root
            .find(rules.images)
            .toArray()
            .map((node) => canonical($(node).attr("src"), url))
            .filter((value): value is string => !!value),
        ),
      ]
    : [];
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
  root.find("dt").append(": ");
  root.find("dd").append("\n");
  root.find("br").replaceWith("\n");
  root.find("p,li,tr,div").append("\n");
  const text = minimizedNotice(root.text())
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
  if (text.length < 80 && !attachments.length && !images.length)
    throw new CollectionError("NOTICE_DETAILS_NEED_OCR");
  if (text.length > MAX_TEXT)
    throw new CollectionError("NOTICE_DETAIL_TOO_LARGE");
  return {
    title,
    text,
    attachments,
    images,
    deadline: submissionDeadline(config.timezone, text, closing),
  };
}

export async function readPublicPdf(bytes: Uint8Array) {
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new CollectionError("ATTACHMENT_FORMAT_INVALID");
  // PDF.js may transfer its input buffer. Retain the original public bytes for
  // hash-bound OCR requests and the saved evidence digest.
  const pdf = await getDocumentProxy(bytes.slice(), {
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
      const restricted = hasRestrictedDocumentContent(raw);
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
  const requiresLogin = publicLoginRequired(html);
  if (requiresLogin) throw new CollectionError("SOURCE_LOGIN_REQUIRED");
  removeHiddenNoticeUi($);
  preserveReadonlyNoticeFields($);
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
  if (text.length < 80 && !attachments.length) {
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

// Hidden login/upload dialogs are interface controls, not public notice text.
// Access-wall detection runs against the original document before this cleanup.
function removeHiddenNoticeUi($: ReturnType<typeof load>) {
  $("[hidden],[aria-hidden=true],template,noscript").remove();
  $("[style]").each((_, node) => {
    if (
      /display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(
        $(node).attr("style") || "",
      )
    )
      $(node).remove();
  });
  $(".modal").each((_, node) => {
    const modal = $(node);
    if (
      !modal.hasClass("show") &&
      !modal.hasClass("in") &&
      modal.attr("aria-hidden") !== "false"
    )
      modal.remove();
  });
}

// Several public portals render their published scope in disabled form fields.
// Keep only visible read-only textual values; never copy editable fields, hidden
// state, credentials, files, checkboxes or action controls into model evidence.
function preserveReadonlyNoticeFields($: ReturnType<typeof load>) {
  $(
    "input[disabled],input[readonly],textarea[disabled],textarea[readonly]",
  ).each((_, node) => {
    const field = $(node);
    if (
      node.tagName === "input" &&
      !["", "text", "date", "datetime-local", "number"].includes(
        (field.attr("type") || "").toLowerCase(),
      )
    )
      return;
    const value =
      node.tagName === "textarea" ? field.text() : field.attr("value") || "";
    const replacement = $("<span></span>").text(value);
    for (const attribute of ["id", "class"]) {
      const value = field.attr(attribute);
      if (value) replacement.attr(attribute, value);
    }
    field.replaceWith(replacement);
  });
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

async function applyPublicOcr(
  url: string,
  bytes: Uint8Array,
  pages: { page: number; text: string; restricted: boolean }[],
  mime: string,
  record: Row,
  reader?: PublicNoticeOcrReader,
) {
  const requested = pages
    .filter((p) => !p.restricted && p.text.length < 30)
    .slice(0, 10)
    .map((p) => p.page);
  if (!reader || !requested.length) return;
  let result: Awaited<ReturnType<PublicNoticeOcrReader>>;
  try {
    result = await reader({
      url,
      sha256: await digest(bytes),
      pages: requested,
      total_pages: pages.length,
      mime,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      [
        "NOTICE_OCR_LOW_CONFIDENCE",
        "NOTICE_OCR_FAILED",
        "SOURCE_TIMEOUT",
      ].includes(code) &&
      pages.some((page) => !page.restricted && page.text.length >= 30)
    ) {
      // OCR supplements text already extracted from the verified PDF bytes. A
      // blank scan or technical OCR failure must not erase those readable pages.
      // Pending, changed evidence, policy and destination failures still stop.
      record.ocr_error = code;
      return;
    }
    throw error;
  }
  if (
    !Array.isArray(result.pages) ||
    result.pages.length !== requested.length ||
    new Set(result.pages.map((p) => p.page)).size !== requested.length ||
    result.pages.some(
      (p) =>
        !requested.includes(p.page) ||
        typeof p.text !== "string" ||
        !Number.isFinite(p.confidence) ||
        p.confidence < 0 ||
        p.confidence > 100,
    )
  )
    throw new CollectionError("NOTICE_OCR_RESULT_INVALID");
  record.ocr_read_pages = [];
  record.ocr_confidence = {};
  for (const resultPage of result.pages) {
    if (resultPage.confidence < 50 || resultPage.text.trim().length < 30)
      continue;
    const page = pages.find((p) => p.page === resultPage.page)!;
    if (hasRestrictedDocumentContent(resultPage.text)) {
      page.restricted = true;
      continue;
    }
    page.text = minimizedNotice(resultPage.text);
    record.ocr_read_pages.push(page.page);
    record.ocr_confidence[String(page.page)] = resultPage.confidence;
  }
  if (record.ocr_read_pages.length) record.extraction = "ocr";
}

export async function enrichPublicNotice(
  source: SourceInput,
  notice: Row,
  hosts: string[],
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch = fetch,
  ocrReader?: PublicNoticeOcrReader,
  pageReader?: PublicNoticePageReader,
) {
  if (source.approval !== "approved" || !source.policy_note.trim())
    throw new CollectionError("SOURCE_PERMISSION_REQUIRED");
  const automatic = (source.adapter_config as Row)?.automatic === true;
  let extraction: ExtractionConfig | undefined;
  try {
    if (!automatic || (source.adapter_config as Row)?.extraction)
      extraction = sourceExtraction((source.adapter_config as Row).extraction);
  } catch {
    throw new CollectionError("ADAPTER_REQUIRED");
  }
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 55000);
  try {
    let detailWarnings: string[] = [];
    const render = async () => {
      if (!pageReader) throw new CollectionError("SOURCE_BROWSER_REQUIRED");
      const rendered = await pageReader({ url: notice.canonical_url });
      detailWarnings = rendered.warnings || [];
      if (
        !safeUrl.safeParse(rendered.url).success ||
        new URL(rendered.url).origin !== new URL(notice.canonical_url).origin
      )
        throw new CollectionError("UNSAFE_DESTINATION");
      const bytes = new TextEncoder().encode(rendered.html);
      if (!bytes.length || bytes.length > 1048576)
        throw new CollectionError("SOURCE_TOO_LARGE");
      return { url: rendered.url, bytes, contentType: "text/html" };
    };
    let page = extraction?.detail.postback
      ? await readPublicPostback(
          extraction.detail.postback,
          { title: notice.title, reference: notice.reference },
          source,
          hosts,
          resolve,
          fetcher,
          controller.signal,
        )
      : await fetchPublicNotice(
          notice.canonical_url,
          source,
          hosts,
          resolve,
          fetcher,
          controller.signal,
          automatic ? MAX_PDF : 1048576,
          automatic,
        ).catch((error) => {
          if (
            pageReader &&
            error instanceof CollectionError &&
            ["MANUAL_SOURCE_REQUIRED", "SOURCE_BROWSER_REQUIRED"].includes(
              error.code,
            )
          )
            return render();
          throw error;
        });
    const isPdf = new TextDecoder().decode(page.bytes.slice(0, 5)) === "%PDF-";
    const directPages =
      automatic && isPdf ? await readPublicPdf(page.bytes) : null;
    const directRecord: Row | null = directPages
      ? {
          url: page.url,
          sha256: await digest(page.bytes),
          total_pages: directPages.length,
        }
      : null;
    if (directPages)
      await applyPublicOcr(
        page.url,
        page.bytes,
        directPages,
        "application/pdf",
        directRecord!,
        ocrReader,
      );
    if (directPages?.some((p) => p.restricted))
      throw new CollectionError("SOURCE_DOCUMENT_RESTRICTED");
    if (
      directPages &&
      !directPages.some((p) => !p.restricted && p.text.length >= 30)
    )
      throw new CollectionError("NOTICE_DETAILS_NEED_OCR");
    const parsePage = () =>
      automatic && !extraction
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
    const detail = directPages
      ? {
          title: "",
          text: directPages
            .filter((p) => p.text.length >= 30)
            .map((p) => p.text)
            .join("\n"),
          attachments: [] as string[],
          images: [] as string[],
          deadline: submissionDeadline(
            null,
            directPages.map((p) => p.text).join("\n"),
          ),
        }
      : await (async () => {
          try {
            return parsePage();
          } catch (error) {
            if (
              !pageReader ||
              !(error instanceof CollectionError) ||
              ![
                "SOURCE_BROWSER_REQUIRED",
                "MANUAL_SOURCE_REQUIRED",
                "NOTICE_DETAILS_CONTENT_UNRESOLVED",
                "SOURCE_EMPTY",
              ].includes(error.code)
            )
              throw error;
            page = await render();
            return parsePage();
          }
        })();
    if (extraction?.detail.postback) {
      const normalize = (value: string) =>
        value.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (!detail.title || normalize(detail.title) !== normalize(notice.title))
        throw new CollectionError("PUBLIC_NOTICE_IDENTITY_UNRESOLVED");
    }
    if (detail.text.length > MAX_TEXT)
      throw new CollectionError("NOTICE_DETAIL_TOO_LARGE");
    let description = `[Public notice: ${page.url}]\n${detail.text}`;
    let evidenceChars = detail.text.length;
    const attachments: Row[] = [];
    if (directRecord && directPages)
      attachments.push({
        ...directRecord,
        status: directPages.every((p) => p.text.length >= 30)
          ? "read"
          : "partial",
        included_pages: directPages
          .filter((p) => p.text.length >= 30)
          .map((p) => p.page),
        ocr_pages: directPages
          .filter((p) => p.text.length < 30)
          .map((p) => p.page),
      });
    const imageUrls = "images" in detail ? detail.images : [];
    const documentUrls = [...detail.attachments, ...imageUrls];
    for (const url of documentUrls.slice(0, 3)) {
      const record: Row = { url, status: "unread", included_pages: [] };
      attachments.push(record);
      try {
        const isImage = imageUrls.includes(url);
        if (!isImage && !/\.pdf$/i.test(new URL(url).pathname))
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
        const mime = isImage ? publicImageMime(file.bytes) : "application/pdf";
        const pages = isImage
          ? [{ page: 1, text: "", restricted: false }]
          : await readPublicPdf(file.bytes);
        await applyPublicOcr(url, file.bytes, pages, mime, record, ocrReader);
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
            evidenceChars += p.text.length;
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
        if (
          error instanceof CollectionError &&
          [
            "NOTICE_OCR_PENDING",
            "DATA_POLICY_BLOCKED",
            "SOURCE_CONTENT_CHANGED",
            "NOTICE_SOURCE_EVIDENCE_CHANGED",
            "STALE_INPUT",
            "UNSAFE_DESTINATION",
            "DEPLOYMENT_HOST_APPROVAL_REQUIRED",
            "SOURCE_DOCUMENT_RESTRICTED",
            "NOTICE_OCR_RESULT_INVALID",
          ].includes(error.code)
        )
          throw error;
        record.status = "unread";
        record.error =
          error instanceof CollectionError
            ? error.code
            : "ATTACHMENT_READ_FAILED";
      }
    }
    for (const url of documentUrls.slice(3))
      attachments.push({
        url,
        status: "unread",
        error: "ATTACHMENT_COUNT_LIMIT",
      });
    if (evidenceChars < 80) {
      const ocrFailure = attachments.find(
        (a) => typeof a.error === "string" && a.error.startsWith("NOTICE_OCR_"),
      );
      throw new CollectionError(
        ocrFailure?.error ||
          (attachments.some((a) => a.status === "needs_ocr")
            ? "NOTICE_DETAILS_NEED_OCR"
            : "NOTICE_DETAILS_CONTENT_UNRESOLVED"),
      );
    }
    // Limitations are evidence, not missing facts. Never claim the complete RFP was read.
    const partial =
      detailWarnings.length > 0 || attachments.some((a) => a.status !== "read");
    const readLimitation =
      "\n[Read limitation: some public detail tabs or page content could not be fully read; dates and scope may be incomplete.]";
    if (
      detailWarnings.length &&
      description.length + readLimitation.length <= MAX_TEXT
    )
      description += readLimitation;
    const metadata = {
      version: 1,
      status: partial ? "partial" : "read",
      detail_url: page.url,
      detail_sha256: await digest(page.bytes),
      fetched_at: new Date().toISOString(),
      attachments,
      ...(detailWarnings.length ? { warnings: detailWarnings } : {}),
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
