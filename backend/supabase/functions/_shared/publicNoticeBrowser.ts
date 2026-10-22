import type { Backend } from "./backend.ts";
import { CollectionError } from "./collector.ts";

/** Resume the original assessment using the exact saved public browser request. */
export function noticeBrowserReader(
  backend: Backend,
  job: { id: string; lease_token: string },
) {
  return async ({
    url,
  }: {
    url: string;
  }): Promise<{ url: string; html: string; warnings?: string[] }> => {
    const result = await backend.internal("request_notice_browser", {
      job_id: job.id,
      lease: job.lease_token,
      url,
    });
    if (result.status === "blocked")
      throw new CollectionError(result.error_code || "SOURCE_BROWSER_FAILED");
    if (result.status !== "ready")
      throw new CollectionError("NOTICE_BROWSER_PENDING");
    const page = result.page;
    if (
      page?.requested_url !== url ||
      typeof page.url !== "string" ||
      typeof page.extraction_html !== "string" ||
      !page.extraction_html.trim()
    )
      throw new CollectionError("SOURCE_BROWSER_FAILED");
    const warnings = page.detail_warnings ?? [];
    if (
      !Array.isArray(warnings) ||
      warnings.length > 3 ||
      warnings.some(
        (value) =>
          typeof value !== "string" ||
          !value.startsWith("NOTICE_DETAIL_TAB_UNREAD:") ||
          value.length > 340,
      )
    )
      throw new CollectionError("SOURCE_BROWSER_FAILED");
    return {
      url: page.url,
      html: page.extraction_html,
      warnings: [...warnings, ...(page.partial ? ["SOURCE_PAGE_PARTIAL"] : [])],
    };
  };
}
