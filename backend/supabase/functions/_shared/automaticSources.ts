import { load } from "cheerio";
import { type Backend, type BackendEnvironment } from "./backend.ts";
import {
  canonical,
  CollectionError,
  inertText,
  item,
  parseSource,
} from "./collector.ts";
import { withSourceMarkup } from "./sourcePageMarkup.ts";
import { ModelDeferred, ModelError, type Evidence } from "./model.ts";
import { executeGuardedModel } from "./modelGraph.ts";
import {
  fetchPublicNotice,
  readPublicPdf,
  removePrivacyNavigation,
} from "./publicNoticeDetails.ts";

type Row = Record<string, any>;
export function readableSourcePage(html: string, url: string) {
  const $ = load(html);
  removePrivacyNavigation($);
  const hasScript = $("script").length > 0;
  const hasImage = $("img,canvas").length > 0;
  $("script,style,noscript,template,input,textarea,button").remove();
  $("br").replaceWith("\n");
  $("p,li,tr,div,h1,h2,h3,dt,dd").append("\n");
  const raw = inertText($("body").text(), 60001)
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
  if (
    /please enable javascript|javascript (?:is required|must be enabled)|human visitor|what code is in the image/i.test(
      raw,
    ) ||
    (hasScript && /\{\{\s*[a-zA-Z_$][^{}]{0,150}\}\}/.test(raw))
  )
    throw new CollectionError("SOURCE_BROWSER_REQUIRED");
  if (raw.length < 20)
    throw new CollectionError(
      hasScript
        ? "SOURCE_BROWSER_REQUIRED"
        : hasImage
          ? "SOURCE_OCR_REQUIRED"
          : "SOURCE_EMPTY",
    );
  const links: { id: string; url: string; text: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, node) => {
    const href = $(node).attr("href")!;
    const target = canonical(href, url);
    if (
      !target ||
      href.startsWith("#") ||
      seen.has(target) ||
      links.length >= 200
    )
      return;
    seen.add(target);
    links.push({
      id: `L${links.length + 1}`,
      url: target,
      text: inertText($(node).text(), 500),
    });
  });
  return {
    url,
    text: raw.slice(0, 60000),
    links,
    partial: raw.length > 60000 || $("a[href]").length > 200,
  };
}

async function readPage(
  ctx: Row,
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch,
) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 25000);
  try {
    // The URL is either Owner-supplied or an exact observed navigation link saved by the leased worker.
    // Every request/redirect still validates HTTPS and public DNS, without forwarding credentials.
    const response = await fetchPublicNotice(
      ctx.state.pending_url,
      ctx.source,
      [],
      resolve,
      fetcher,
      controller.signal,
      5 * 1024 * 1024,
      true,
    );
    const pdf =
      new TextDecoder().decode(response.bytes.slice(0, 5)) === "%PDF-";
    let page;
    if (pdf) {
      const pages = await readPublicPdf(response.bytes);
      if (pages.some((p) => p.restricted))
        throw new CollectionError("SOURCE_DOCUMENT_RESTRICTED");
      const text = pages
        .filter((p) => !p.restricted)
        .map((p) => p.text)
        .join("\n");
      if (
        !text.trim() ||
        pages.some((p) => !p.restricted && p.text.length < 30)
      )
        throw new CollectionError("SOURCE_OCR_REQUIRED");
      page = {
        url: response.url,
        text: text.slice(0, 60000),
        links: [],
        partial: text.length > 60000,
      };
    } else {
      if (response.bytes.length > 1048576)
        throw new CollectionError("SOURCE_TOO_LARGE");
      if (
        !/text\/html|application\/xhtml/i.test(response.contentType) &&
        !new TextDecoder().decode(response.bytes.slice(0, 200)).includes("<")
      )
        throw new CollectionError("SOURCE_FORMAT_UNSUPPORTED");
      const html = new TextDecoder("utf-8", { fatal: true }).decode(
        response.bytes,
      );
      page = withSourceMarkup(readableSourcePage(html, response.url), html);
    }
    return { ...page, requested_url: ctx.state.pending_url };
  } finally {
    clearTimeout(timer);
  }
}

export async function processAutomaticSource(
  backend: Backend,
  env: BackendEnvironment,
  job: Row,
  resolve: (host: string) => Promise<string[]>,
  fetcher: typeof fetch = fetch,
) {
  const identity = { job_id: job.id, lease: job.lease_token };
  try {
    const ctx = await backend.internal("auto_source_context", identity);
    let state = ctx.state;
    if (!state.page) {
      const browser = await backend.internal("source_browser_page", identity);
      if (browser?.status === "blocked")
        throw new CollectionError(
          browser.error_code || "SOURCE_BROWSER_FAILED",
        );
      if (browser && browser.status !== "ready")
        return await backend.internal("queue_source_browser_page", identity);
      let page;
      if (browser?.status === "ready") page = browser.page;
      else {
        try {
          page = await readPage(ctx, resolve, fetcher);
        } catch (error) {
          if (
            error instanceof CollectionError &&
            ["SOURCE_BROWSER_REQUIRED", "MANUAL_SOURCE_REQUIRED"].includes(
              error.code,
            )
          )
            return await backend.internal(
              "queue_source_browser_page",
              identity,
            );
          throw error;
        }
      }
      state = await backend.internal("save_source_page", { ...identity, page });
    }
    const page = state.page;
    // A reviewed extraction profile is already a deterministic adapter. Public
    // JavaScript pages need Chromium to obtain their DOM, not another model to
    // reinterpret fields the configured selectors can read directly.
    if (
      ctx.mode === "collect_notices" &&
      ctx.source.adapter_config?.official_listing &&
      ctx.source.adapter_config?.extraction &&
      typeof page.extraction_html === "string"
    ) {
      const parsed = parseSource(
        { ...ctx.source, url: page.url },
        page.extraction_html,
      );
      if (page.partial && !parsed.items.length)
        throw new CollectionError("SOURCE_PAGE_PARTIAL");
      const saved = await backend.internal("advance_source_reading", {
        ...identity,
        items: parsed.items,
        candidates: [],
        next_url: null,
        warnings: [
          ...parsed.warnings,
          "CONFIGURED_PUBLIC_DOM_EXTRACTION",
          ...(page.partial ? ["SOURCE_PAGE_PARTIAL"] : []),
        ],
      });
      if (!saved.continued)
        await backend.internal("schedule_assessment_refresh");
      return saved;
    }
    const evidence: Evidence[] = [
      { id: "page", text: page.text, kind: "notice", verified: false },
      ...page.links.map((l: Row) => ({
        id: l.id,
        text: l.text,
        kind: "notice" as const,
        verified: false,
      })),
    ];
    const outcome = await executeGuardedModel({
      backend,
      job: job as any,
      prefix: `source:${job.id}:page:${state.visited_urls.length}`,
      task: "inspect_source_page",
      context: {
        mode: ctx.mode,
        url: page.url,
        links: page.links,
        partial: page.partial,
      },
      evidence,
      requiredIds: [],
      manifest: [
        {
          entity_kind: "source_page",
          entity_id: job.id,
          content_hash: state.page_hash,
        },
      ],
      environments: env.models,
      language: "ar",
      repair: job.failure_count > 0,
      fetcher,
    });
    const result = outcome.result;
    if (result.page_kind === "browser_required") {
      if (state.page.rendered)
        throw new CollectionError("SOURCE_BROWSER_FAILED");
      return await backend.internal("queue_source_browser_page", identity);
    }
    const blockers: Record<string, string> = {
      login_required: "SOURCE_LOGIN_REQUIRED",
      browser_required: "SOURCE_BROWSER_REQUIRED",
      no_tender_content: "SOURCE_NOT_A_TENDER_LISTING",
    };
    if (blockers[result.page_kind])
      throw new CollectionError(blockers[result.page_kind]);
    if (page.partial && result.page_kind === "no_open_notices")
      throw new CollectionError("SOURCE_PAGE_PARTIAL");
    if (
      ctx.mode === "collect_notices" &&
      !result.notices.length &&
      !result.follow_link_id &&
      result.page_kind !== "no_open_notices"
    )
      throw new CollectionError("SOURCE_NOT_A_TENDER_LISTING");
    const link = (id: string | null) =>
      id === null ? null : page.links.find((l: Row) => l.id === id);
    const items =
      ctx.mode === "collect_notices"
        ? result.notices.map((n: Row) =>
            item(
              {
                title: n.title,
                url: link(n.link_id)?.url || page.url,
                description: n.evidence_quote,
                reference: n.reference,
                buyer: n.buyer,
                deadline_raw: n.deadline_raw,
              },
              page.url,
            ),
          )
        : [];
    if (items.some((i: unknown) => !i))
      throw new CollectionError("SOURCE_EVIDENCE_INVALID");
    const candidates =
      ctx.mode === "discover_sources"
        ? result.candidate_link_ids.map((id: string) => {
            const l = link(id)!;
            return { url: l.url, name: l.text || new URL(l.url).hostname };
          })
        : [];
    const saved = await backend.internal(
      outcome.threadId
        ? "advance_source_reading_graph"
        : "advance_source_reading",
      {
        ...(outcome.threadId ? { thread_id: outcome.threadId, result } : {}),
        ...identity,
        items,
        candidates,
        next_url: link(result.follow_link_id)?.url || null,
        warnings: page.partial ? ["SOURCE_PAGE_PARTIAL"] : [],
      },
    );
    await outcome
      .cleanup?.()
      .catch(() => console.warn("provider_request_cleanup_pending"));
    if (!saved.continued) await backend.internal("schedule_assessment_refresh");
    return saved;
  } catch (error) {
    if (error instanceof ModelDeferred) return { waiting_for_model: true };
    const code =
      error instanceof Error && error.name === "AbortError"
        ? "SOURCE_TIMEOUT"
        : error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z][A-Z_]+$/.test(error.code)
          ? error.code
          : "SOURCE_TEMPORARY_FAILURE";
    await backend.internal("fail_source_reading", {
      ...identity,
      error_code: code,
      retry_after:
        error instanceof ModelError || error instanceof CollectionError
          ? error.retryAfter
          : null,
    });
    return { error_code: code };
  }
}
