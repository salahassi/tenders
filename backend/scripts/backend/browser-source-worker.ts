import { chromium, type Browser } from "playwright";
import { resolve4 } from "node:dns/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import {
  publicAddress,
  canonical,
  inertText,
} from "../../supabase/functions/_shared/collector.ts";

type Request = {
  id: string;
  url: string;
  workspace_id: string;
  lease_token: string;
};
type Query = (sql: string) => Promise<any[]>;
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
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
export function sealSession(state: unknown, secret: string, host: string) {
  const key = createHash("sha256")
    .update("tenderdesk-browser-session-v1\0" + secret)
    .digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(host));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(state)),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64");
}
export function openSession(sealed: string, secret: string, host: string) {
  try {
    const bytes = Buffer.from(sealed, "base64");
    const key = createHash("sha256")
      .update("tenderdesk-browser-session-v1\0" + secret)
      .digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(host));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  } catch {
    return undefined;
  }
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
  return {
    requested_url: requested,
    url,
    text: raw.slice(0, 60000),
    links,
    partial: raw.length > 60000 || $("a[href]").length > 200,
    rendered: true,
  };
}
const humanChallenge = (text: string) =>
  /human visitor|what code is in the image|verify (?:that )?you are human|تحقق.*بشري/i.test(
    text,
  );
export async function renderPublicSource(o: {
  browser: Browser;
  url: string;
  storageState?: any;
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
    await publicDestination(page.url());
    const html = await page.content();
    if (Buffer.byteLength(html) > 1048576) throw Error("SOURCE_TOO_LARGE");
    return {
      page: renderedPage(html, page.url(), o.url),
      state: await context.storageState(),
    };
  } finally {
    await context.close();
  }
}

export async function processBrowserRequest(
  query: Query,
  browser: Browser,
  secret: string,
) {
  const request = (
    await query("select public.claim_source_browser_page() data")
  )[0]?.data as Request | null;
  if (!request) return false;
  const args = `${literal(request.id)}::uuid,${literal(request.lease_token)}::uuid`;
  const host = new URL(request.url).hostname;
  const sessionScope = request.workspace_id + ":" + host;
  let result: Awaited<ReturnType<typeof renderPublicSource>> | undefined;
  let code: string | null = null;
  try {
    const sealed = (
      await query(`select public.source_browser_session(${args}) data`)
    )[0]?.data;
    result = await renderPublicSource({
      browser,
      url: request.url,
      storageState: sealed
        ? openSession(sealed, secret, sessionScope)
        : undefined,
      onChallenge: async (image) => {
        await query(
          `select public.source_browser_challenge(${args},${literal(image)})`,
        );
        const deadline = Date.now() + 175000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const data = (
            await query(`select public.source_browser_challenge(${args}) data`)
          )[0]?.data;
          if (data?.expired) return null;
          if (data?.answer) return data.answer;
        }
        return null;
      },
    });
    await query(
      `select public.source_browser_session(${args},${literal(sealSession(result.state, secret, sessionScope))})`,
    );
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
  const page = result
    ? literal(JSON.stringify(result.page)) + "::jsonb"
    : "null";
  await query(
    `select public.complete_source_browser_page(${args},${page},${code ? literal(code) : "null"})`,
  );
  console.log(JSON.stringify({ host, outcome: code || "rendered" }));
  return true;
}

export function managementQuery(token: string): Query {
  return async (sql) => {
    const response = await fetch(
      "https://api.supabase.com/v1/projects/nqfwbqeozmuiuwbiowil/database/query",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw Error(
        `Browser queue database request failed: HTTP ${response.status}`,
      );
    const result = await response.json();
    if (!Array.isArray(result)) throw Error("Invalid browser queue response");
    return result;
  };
}
async function main() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw Error("SUPABASE_ACCESS_TOKEN is required");
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const browser = await chromium.launch({
    proxy: proxy ? { server: proxy } : undefined,
  });
  try {
    const query = managementQuery(token);
    for (let i = 0; i < 3; i++)
      if (!(await processBrowserRequest(query, browser, token))) break;
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
