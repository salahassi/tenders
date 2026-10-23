// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { readPublicTabs } from "../../scripts/backend/public-browser-tabs";
function fixture(attributes = { tag: "A", role: "tab", href: "#details" }) {
  const tab = {
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async () => attributes,
    click: vi.fn(async () => {}),
  };
  const panel = {
    count: async () => 1,
    innerText: async () => "Synthetic public dates and submission details",
  };
  const routes: any[] = [];
  const page = {
    url: vi.fn(() => "https://public.example.test/notice?id=1"),
    route: vi.fn(async (_: string, fn: any) => {
      routes.push(fn);
    }),
    unroute: vi.fn(async () => {}),
    locator: vi.fn((s: string) => (s === "#datesTab" ? tab : panel)),
    waitForLoadState: vi.fn(async () => {}),
  };
  return { tab, panel, page: page as unknown as Page, routes, raw: page };
}
it("loads configured same-page tabs and blocks external navigation or form submission during the read", async () => {
  const f = fixture();
  await readPublicTabs(f.page, ["#datesTab"]);
  expect(f.tab.click).toHaveBeenCalledOnce();
  expect(f.raw.unroute).toHaveBeenCalledOnce();
  for (const [url, method, navigation, allowed] of [
    ["https://public.example.test/public-dates", "GET", false, true],
    ["https://public.example.test/purchase", "POST", false, false],
    ["https://other.example.test/", "GET", false, false],
    ["https://public.example.test/purchase", "GET", true, false],
  ] as const) {
    const route = {
      request: () => ({
        url: () => url,
        method: () => method,
        isNavigationRequest: () => navigation,
      }),
      abort: vi.fn(),
      fallback: vi.fn(),
    };
    await f.routes[0](route);
    expect(allowed ? route.fallback : route.abort).toHaveBeenCalledOnce();
  }
});
it.each([
  { tag: "BUTTON", role: "tab", href: "#details" },
  { tag: "A", role: "tab", href: "/purchase" },
  { tag: "A", role: "button", href: "#details" },
  { tag: "A", role: "tab", href: "javascript:submit()" },
])(
  "rejects non-tab or navigation controls before clicking",
  async (attributes) => {
    const f = fixture(attributes);
    await expect(readPublicTabs(f.page, ["#datesTab"])).rejects.toThrow(
      "SOURCE_BROWSER_FAILED",
    );
    expect(f.tab.click).not.toHaveBeenCalled();
    expect(f.raw.unroute).toHaveBeenCalledOnce();
  },
);
it("rejects an unexpected page change and bounds the number of reviewed tabs", async () => {
  const f = fixture();
  f.raw.url
    .mockReturnValueOnce("https://public.example.test/notice?id=1")
    .mockReturnValue("https://public.example.test/other");
  await expect(readPublicTabs(f.page, ["#datesTab"])).rejects.toThrow(
    "SOURCE_BROWSER_FAILED",
  );
  const untouched = fixture();
  await expect(
    readPublicTabs(untouched.page, [
      "#datesTab",
      "#datesTab",
      "#datesTab",
      "#datesTab",
    ]),
  ).rejects.toThrow("SOURCE_BROWSER_FAILED");
  expect(untouched.tab.click).not.toHaveBeenCalled();
});

it("retains a readable baseline when an optional lazy tab is blank or absent", async () => {
  const f = fixture();
  f.panel.innerText = async () => "";
  f.raw.waitForLoadState.mockRejectedValueOnce(
    new Error("Optional network timeout"),
  );
  await expect(readPublicTabs(f.page, ["#datesTab"])).resolves.toEqual([
    "NOTICE_DETAIL_TAB_UNREAD:#datesTab",
  ]);
  expect(f.raw.unroute).toHaveBeenCalledOnce();
  const absent = fixture();
  absent.tab.count = async () => 0;
  await expect(readPublicTabs(absent.page, ["#datesTab"])).resolves.toEqual([
    "NOTICE_DETAIL_TAB_UNREAD:#datesTab",
  ]);
  expect(absent.tab.click).not.toHaveBeenCalled();
  await expect(readPublicTabs(absent.page, [])).resolves.toEqual([]);
});

it("retains baseline evidence after an optional click timeout but still rejects page changes and other errors", async () => {
  const timeout = Object.assign(
    new Error("Synthetic overlay prevented optional tab click"),
    { name: "TimeoutError" },
  );
  const f = fixture();
  f.tab.click.mockRejectedValueOnce(timeout);
  await expect(readPublicTabs(f.page, ["#datesTab"])).resolves.toEqual([
    "NOTICE_DETAIL_TAB_UNREAD:#datesTab",
  ]);
  expect(f.raw.waitForLoadState).not.toHaveBeenCalled();
  expect(f.raw.unroute).toHaveBeenCalledOnce();
  const changed = fixture();
  changed.tab.click.mockRejectedValueOnce(timeout);
  changed.raw.url
    .mockReturnValueOnce("https://public.example.test/notice?id=1")
    .mockReturnValue("https://public.example.test/other");
  await expect(readPublicTabs(changed.page, ["#datesTab"])).rejects.toThrow(
    "SOURCE_BROWSER_FAILED",
  );
  const failed = fixture();
  failed.tab.click.mockRejectedValueOnce(new Error("Synthetic browser closed"));
  await expect(readPublicTabs(failed.page, ["#datesTab"])).rejects.toThrow(
    "Synthetic browser closed",
  );
});

it("bounds an optional panel read when the page removes the panel after clicking", async () => {
  const f = fixture();
  f.panel.innerText = vi.fn().mockRejectedValue(
    Object.assign(new Error("Synthetic detached lazy panel"), {
      name: "TimeoutError",
    }),
  );
  await expect(readPublicTabs(f.page, ["#datesTab"])).resolves.toEqual([
    "NOTICE_DETAIL_TAB_UNREAD:#datesTab",
  ]);
  expect(f.panel.innerText).toHaveBeenCalledWith({ timeout: 2000 });
});
