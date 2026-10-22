import { chromium, type Browser } from "playwright";
import { resolve4 } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import {
  publicAddress,
  canonical,
  inertText,
} from "../../supabase/functions/_shared/collector.ts";
import { withSourceMarkup } from "../../supabase/functions/_shared/sourcePageMarkup.ts";
import { processNoticeOcrRequest } from "./public-notice-ocr-worker.ts";
import { readPublicTabs } from "./public-browser-tabs.ts";

type Request = {
  id: string;
  url: string;
  workspace_id: string;
  lease_token: string;
  read_tabs?: string[];
};
type Gateway = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<any>;
export async function publicDestination(
  url: string,
  lookup: (hostname: string) => Promise<string[]> = resolve4,
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw Error("UNSAFE_DESTINATION");
  const addresses = await lookup(u.hostname);
  if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
    throw Error("UNSAFE_DESTINATION");
  return u;
}
export function renderedPage(html: string, url: string, requested: string) {
  const $ = load(html);
  $(
    "script,style,noscript,template,input,textarea,button,header,footer,nav",
  ).remove();
  $("br").replaceWith("\n");
  $("p,li,tr,div,h1,h2,h3,dt,dd").append("\n");
  const raw = inertText($("body").text(), 60001).trim();
  const links: { id: string; text: string; url: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")!;
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
      text: inertText($(a).text(), 500),
      url: target,
    });
  });
  if (raw.length < 20) throw Error("SOURCE_BROWSER_FAILED");
  return withSourceMarkup(
    {
      requested_url: requested,
      url,
      text: raw.slice(0, 60000),
      links,
      partial: raw.length > 60000 || $("a[href]").length > 200,
      rendered: true,
    },
    html,
  );
}
const humanChallenge = (text: string) =>
  /human visitor|what code is in the image|verify (?:that )?you are human|تحقق.*بشري/i.test(
    text,
  );
export async function renderPublicSource(o: {
  browser: Browser;
  url: string;
  storageState?: any;
  readTabs?: string[];
  onChallenge?: (image: string) => Promise<string | null>;
}) {
  await publicDestination(o.url);
  const context = await o.browser.newContext({
    storageState: o.storageState,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const allowed = new Map<string, boolean>();
    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        if (["media", "font"].includes(request.resourceType()))
          return await route.abort();
        const url = new URL(request.url());
        if (!allowed.has(url.origin)) {
          await publicDestination(url.href);
          allowed.set(url.origin, true);
        }
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    const page = await context.newPage();
    await page.goto(o.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await page.locator("body").innerText();
      if (!humanChallenge(text)) break;
      const field = page
        .locator('#ans, input[name="answer"], input[name*="captcha" i]')
        .first();
      const submit = page
        .locator('#jar, button[type="submit"], input[type="submit"]')
        .first();
      if (
        !o.onChallenge ||
        !(await field.isVisible()) ||
        !(await submit.isVisible())
      )
        throw Error("SOURCE_HUMAN_VERIFICATION_REQUIRED");
      // The human sees the exact live challenge. No OCR, answer generation or
      // CAPTCHA-solving provider is used, and no login form is submitted.
      const picture = await page
        .locator("body")
        .screenshot({ type: "png", timeout: 10000 });
      if (picture.length > 145000)
        throw Error("SOURCE_HUMAN_VERIFICATION_REQUIRED");
      const answer = await o.onChallenge(
        "data:image/png;base64," + picture.toString("base64"),
      );
      if (!answer) throw Error("SOURCE_HUMAN_VERIFICATION_REQUIRED");
      await field.fill(answer);
      await submit.click();
      await page
        .waitForLoadState("domcontentloaded", { timeout: 15000 })
        .catch(() => {});
      await page
        .waitForLoadState("networkidle", { timeout: 10000 })
        .catch(() => {});
    }
    const text = await page.locator("body").innerText();
    if (humanChallenge(text)) throw Error("SOURCE_HUMAN_VERIFICATION_REQUIRED");
    if (
      await page
        .locator('input[type="password"]')
        .isVisible()
        .catch(() => false)
    )
      throw Error("SOURCE_LOGIN_REQUIRED");
    const detailWarnings = await readPublicTabs(page, o.readTabs || []);
    await publicDestination(page.url());
    const html = await page.content();
    if (Buffer.byteLength(html) > 1048576) throw Error("SOURCE_TOO_LARGE");
    return {
      page: {
        ...renderedPage(html, page.url(), o.url),
        ...(detailWarnings.length ? { detail_warnings: detailWarnings } : {}),
      },
      state: await context.storageState(),
    };
  } finally {
    await context.close();
  }
}

export async function processBrowserRequest(
  gateway: Gateway,
  browser: Browser,
) {
  const request = (await gateway("claim", {})) as Request | null;
  if (!request) return false;
  const args = { request_id: request.id, lease: request.lease_token };
  const host = new URL(request.url).hostname;
  let result: Awaited<ReturnType<typeof renderPublicSource>> | undefined;
  let code: string | null = null;
  try {
    result = await renderPublicSource({
      browser,
      url: request.url,
      readTabs: request.read_tabs,
      storageState: (await gateway("session_load", args)) ?? undefined,
      onChallenge: async (image) => {
        await gateway("challenge", { ...args, image });
        const deadline = Date.now() + 175000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const data = await gateway("challenge", args);
          if (data?.expired) return null;
          if (data?.answer) return data.answer;
        }
        return null;
      },
    });
    await gateway("session_save", { ...args, state: result.state });
  } catch (error) {
    const name = error instanceof Error ? error.message : "";
    code = [
      "SOURCE_HUMAN_VERIFICATION_REQUIRED",
      "SOURCE_LOGIN_REQUIRED",
      "UNSAFE_DESTINATION",
      "SOURCE_TOO_LARGE",
    ].includes(name)
      ? name
      : error instanceof Error && error.name === "TimeoutError"
        ? "SOURCE_TIMEOUT"
        : "SOURCE_BROWSER_FAILED";
  }
  await gateway("complete", {
    ...args,
    page: result?.page ?? null,
    error_code: code,
  });
  console.log(JSON.stringify({ host, outcome: code || "rendered" }));
  return true;
}
export function actionsGateway(): Gateway {
  const audience =
    "https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/source-browser";
  let cached: { value: string; expires: number } | undefined;
  const identity = async () => {
    if (cached && cached.expires > Date.now() / 1000 + 60) return cached.value;
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken)
      throw Error("GitHub Actions id-token: write is required");
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("GitHub Actions identity is unavailable");
    const body = await response.json();
    if (typeof body.value !== "string") throw Error("Invalid Actions identity");
    cached = {
      value: body.value,
      expires: JSON.parse(
        Buffer.from(body.value.split(".")[1], "base64url").toString(),
      ).exp,
    };
    return cached.value;
  };
  return async (action, payload) => {
    const token = await identity();
    const response = await fetch(audience, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        const claims = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString(),
        );
        const fields = [
          "iss",
          "aud",
          "sub",
          "repository",
          "ref",
          "workflow_ref",
          "iat",
          "exp",
          "nbf",
        ];
        console.error(
          "Browser identity rejected",
          JSON.stringify(
            Object.fromEntries(fields.map((key) => [key, claims[key]])),
          ),
        );
      }
      throw Error(`Browser queue request failed: HTTP ${response.status}`);
    }
    return (await response.json()).data;
  };
}
async function main() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const browser = await chromium.launch({
    channel:
      process.env.SOURCE_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    proxy: proxy ? { server: proxy } : undefined,
  });
  try {
    const gateway = actionsGateway();
    const started = Date.now();
    for (let i = 0; i < 8 && Date.now() - started < 9 * 60 * 1000; i++)
      if (!(await processBrowserRequest(gateway, browser))) break;
    for (let i = 0; i < 10 && Date.now() - started < 9 * 60 * 1000; i++)
      if (!(await processNoticeOcrRequest(gateway))) break;
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Browser worker failed",
    );
    process.exitCode = 1;
  });
