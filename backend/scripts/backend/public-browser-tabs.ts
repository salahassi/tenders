import type { Page, Route } from "playwright";

/** Load reviewed, same-page public tabs. Never navigate or submit a portal form. */
export async function readPublicTabs(page: Page, selectors: string[]) {
  if (!selectors.length) return [] as string[];
  if (selectors.length > 3 || selectors.some((s) => !s || s.length > 300))
    throw Error("SOURCE_BROWSER_FAILED");
  const warnings: string[] = [];
  const original = new URL(page.url());
  original.hash = "";
  const guard = async (route: Route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (
      request.method() !== "GET" ||
      request.isNavigationRequest() ||
      target.origin !== original.origin
    )
      return await route.abort();
    await route.fallback();
  };
  await page.route("**/*", guard);
  try {
    for (const selector of selectors) {
      const tab = page.locator(selector);
      if ((await tab.count()) !== 1 || !(await tab.isVisible())) {
        warnings.push(`NOTICE_DETAIL_TAB_UNREAD:${selector}`);
        continue;
      }
      const attributes = await tab.evaluate((node) => ({
        tag: node.tagName,
        role: node.getAttribute("role"),
        href: node.getAttribute("href"),
      }));
      if (
        attributes.tag !== "A" ||
        attributes.role !== "tab" ||
        !/^#[A-Za-z][A-Za-z0-9_:.-]*$/.test(attributes.href || "")
      )
        throw Error("SOURCE_BROWSER_FAILED");
      const panel = page.locator(`[id="${attributes.href!.slice(1)}"]`);
      if ((await panel.count()) !== 1) {
        warnings.push(`NOTICE_DETAIL_TAB_UNREAD:${selector}`);
        continue;
      }
      let clickTimedOut = false;
      try {
        await tab.click({ timeout: 10000 });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError")
          throw error;
        clickTimedOut = true;
      }
      if (!clickTimedOut)
        await page
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
      let unread = clickTimedOut;
      if (!unread) {
        try {
          unread = (await panel.innerText({ timeout: 2000 })).trim().length < 5;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError")
            throw error;
          unread = true;
        }
      }
      const current = new URL(page.url());
      current.hash = "";
      if (current.href !== original.href) throw Error("SOURCE_BROWSER_FAILED");
      // A lazy public tab may legitimately remain unavailable. Keep the already
      // readable notice and record the gap; never report a complete detail read.
      if (unread) warnings.push(`NOTICE_DETAIL_TAB_UNREAD:${selector}`);
    }
  } finally {
    await page.unroute("**/*", guard);
  }
  return warnings;
}
