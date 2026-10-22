// @vitest-environment node
import { expect, it, vi } from "vitest";
import { readPublicPostback } from "../../supabase/functions/_shared/publicPostback";
import { publicPostbackSchema } from "../../supabase/functions/_shared/publicPostbackConfig";
import type { SourceInput } from "../../supabase/functions/_shared/collector";

const source: SourceInput = {
  id: crypto.randomUUID(),
  kind: "link_directory",
  approval: "approved",
  url: "https://public.example.test/notices.aspx",
  approved_hosts: ["public.example.test"],
  policy_note: "Synthetic public navigation fixture",
  adapter_config: {},
};
const config = {
  url: source.url,
  rows: "#notices tr",
  title: ".title",
  reference: ".ref",
  link: "a.detail",
};
const notice = { title: "Synthetic software services", reference: "T-1" };
const row = `<tr><td class="title">Synthetic software services</td><td class="ref">T-1</td><td><a class="detail" href="javascript:__doPostBack('notices$ctl02$lnkdetails','')">Details</a></td></tr>`;
const listing = (rows = row, extra = "", action = "notices.aspx") =>
  `<form method="post" action="${action}"><input type="hidden" name="__VIEWSTATE" value="synthetic-viewstate"><input type="hidden" name="__EVENTVALIDATION" value="synthetic-eventvalidation"><input type="hidden" name="unsafe_command" value="never-send"><input name="bid_amount" value="100">${extra}<table id="notices">${rows}</table></form>`;
const resolve = vi.fn(async () => ["93.184.216.34"]);
const run = (
  fetcher: typeof fetch,
  options: {
    html?: string;
    config?: any;
    notice?: any;
    source?: SourceInput;
    hosts?: string[];
    resolve?: (host: string) => Promise<string[]>;
    signal?: AbortSignal;
  } = {},
) =>
  readPublicPostback(
    options.config || config,
    options.notice || notice,
    options.source || source,
    options.hosts || source.approved_hosts,
    options.resolve || resolve,
    fetcher,
    options.signal || new AbortController().signal,
  );

it("follows one exact observed public detail link with scoped anonymous session state and only protocol fields", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (seen.length === 1)
      return new Response(listing(), {
        headers: {
          "set-cookie": "ASP.NET_SessionId=synthetic123; Path=/; HttpOnly",
        },
      });
    if (seen.length === 2)
      return new Response(null, {
        status: 302,
        headers: { location: "/show.aspx" },
      });
    return new Response("<article>Synthetic detail</article>");
  }) as typeof fetch;
  const result = await run(fetcher);
  expect(result.url).toBe("https://public.example.test/show.aspx");
  expect(result.title).toBe(notice.title);
  expect(new TextDecoder().decode(result.bytes)).toContain("Synthetic detail");
  expect(Object.keys(result).sort()).toEqual([
    "bytes",
    "contentType",
    "title",
    "url",
  ]);
  expect(seen.map((x) => x.init?.method)).toEqual(["GET", "POST", "GET"]);
  expect(
    [...new URLSearchParams(seen[1].init?.body as string).keys()].sort(),
  ).toEqual([
    "__EVENTARGUMENT",
    "__EVENTTARGET",
    "__EVENTVALIDATION",
    "__VIEWSTATE",
  ]);
  expect(new Headers(seen[1].init?.headers).get("cookie")).toBe(
    "ASP.NET_SessionId=synthetic123",
  );
  expect(new Headers(seen[2].init?.headers).get("cookie")).toBe(
    "ASP.NET_SessionId=synthetic123",
  );
});

it("normalizes spacing but requires exact title and configured reference, never first-row fallback", async () => {
  const fetcher = vi.fn(
    async (_url: any, init?: RequestInit) =>
      new Response(init?.method === "POST" ? "Detail" : listing()),
  );
  await run(fetcher as typeof fetch, {
    notice: { title: " Synthetic   software services ", reference: " T-1 " },
  });
  for (const input of [
    { ...notice, title: "Synthetic software" },
    { ...notice, reference: "T-2" },
  ]) {
    fetcher.mockClear();
    await expect(
      run(fetcher as typeof fetch, { notice: input }),
    ).rejects.toThrow("PUBLIC_NOTICE_IDENTITY_UNRESOLVED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("rejects duplicate matching rows and multiple links before posting", async () => {
  for (const html of [
    listing(row + row),
    listing(
      row.replace(
        "</td></tr>",
        `<a class="detail" href="javascript:__doPostBack('notices$ctl03$lnkdetails','')">Other</a></td></tr>`,
      ),
    ),
  ]) {
    const fetcher = vi.fn(async () => new Response(html));
    await expect(run(fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it.each([
  "delete",
  "submit",
  "btnPurchase",
  "lnkLogin",
  "lnkApprove",
  "lnkdetails','unsafe",
  "Buy$lnkdetails",
])("rejects an unsafe observed postback target %s", async (target) => {
  const html = listing().replace("notices$ctl02$lnkdetails", target);
  const fetcher = vi.fn(async () => new Response(html));
  await expect(run(fetcher as typeof fetch)).rejects.toThrow(
    "PUBLIC_POSTBACK_UNSAFE_NAVIGATION",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not submit buttons, forms with active login/CAPTCHA or missing protocol tokens", async () => {
  for (const html of [
    listing().replace(
      /<a class="detail"[^>]*>Details<\/a>/,
      '<button class="detail">Details</button>',
    ),
    listing(row, '<input type="password">'),
    listing(row, '<div class="captcha">Verify</div>'),
    listing().replace('name="__EVENTVALIDATION"', 'name="unrelated"'),
  ]) {
    const fetcher = vi.fn(async () => new Response(html));
    await expect(run(fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("rejects cross-origin form action, redirects and configuration without sending session state", async () => {
  for (const fetcher of [
    vi.fn(
      async () =>
        new Response(listing(row, "", "https://other.example.test/post")),
    ),
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://other.example.test/detail",
            "set-cookie": "ASP.NET_SessionId=synthetic",
          },
        }),
    ),
  ]) {
    await expect(run(fetcher as typeof fetch)).rejects.toThrow(
      "UNSAFE_DESTINATION",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher = vi.fn();
  await expect(
    run(fetcher as typeof fetch, {
      config: { ...config, url: "https://other.example.test/list" },
    }),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  expect(fetcher).not.toHaveBeenCalled();
});

it("checks both host permissions and public DNS on every hop", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await expect(run(fetcher as typeof fetch, { hosts: [] })).rejects.toThrow(
    "DEPLOYMENT_HOST_APPROVAL_REQUIRED",
  );
  expect(fetcher).not.toHaveBeenCalled();
  const resolver = vi
    .fn()
    .mockResolvedValueOnce(["93.184.216.34"])
    .mockResolvedValue(["127.0.0.1"]);
  await expect(
    run(fetcher as typeof fetch, { resolve: resolver }),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never forwards authentication cookies and does not reuse anonymous sessions between reads", async () => {
  const cookies: Array<string | null> = [];
  let calls = 0;
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    cookies.push(new Headers(init?.headers).get("cookie"));
    calls++;
    if (calls % 2 === 1)
      return new Response(listing(), {
        headers: [
          ["set-cookie", "ASP.NET_SessionId=synthetic123; Path=/"],
          ["set-cookie", ".ASPXAUTH=never-forward; Path=/"],
        ],
      });
    return new Response("Detail");
  });
  await run(fetcher as typeof fetch);
  await run(fetcher as typeof fetch);
  expect(cookies).toEqual([
    null,
    "ASP.NET_SessionId=synthetic123",
    null,
    "ASP.NET_SessionId=synthetic123",
  ]);
});

it("bounds redirects, total requests, streamed bytes and canceled work", async () => {
  const looping = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await expect(run(looping as typeof fetch)).rejects.toThrow("REDIRECT_LIMIT");
  expect(looping).toHaveBeenCalledTimes(4);
  let count = 0;
  const budget = vi.fn(async () =>
    ++count === 4
      ? new Response(listing())
      : new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await expect(run(budget as typeof fetch)).rejects.toThrow(
    "PUBLIC_POSTBACK_REQUEST_LIMIT",
  );
  expect(budget).toHaveBeenCalledTimes(6);
  await expect(
    run(
      (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch,
    ),
  ).rejects.toThrow("SOURCE_TOO_LARGE");
  const controller = new AbortController();
  controller.abort();
  const canceled = vi.fn();
  await expect(
    run(canceled as typeof fetch, { signal: controller.signal }),
  ).rejects.toThrow("SOURCE_TIMEOUT");
  expect(canceled).not.toHaveBeenCalled();
});

it("does not replay a public navigation POST through a preserving redirect", async () => {
  let count = 0;
  const fetcher = vi.fn(async () =>
    ++count === 1
      ? new Response(listing())
      : new Response(null, {
          status: 307,
          headers: { location: "/other-post" },
        }),
  );
  await expect(run(fetcher as typeof fetch)).rejects.toThrow(
    "PUBLIC_POSTBACK_UNSAFE_NAVIGATION",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("stops waiting for unresolved DNS at the supplied request deadline", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn();
  const pending = run(fetcher as typeof fetch, {
    resolve: async () => new Promise<string[]>(() => {}),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow("SOURCE_TIMEOUT");
  expect(fetcher).not.toHaveBeenCalled();
});

it("validates selectors and rejects unrelated configuration fields", () => {
  expect(publicPostbackSchema.safeParse({ ...config, rows: "[" }).success).toBe(
    false,
  );
  expect(
    publicPostbackSchema.safeParse({ ...config, submit: "purchase" }).success,
  ).toBe(false);
});
