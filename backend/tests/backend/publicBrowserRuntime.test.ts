// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { Browser } from "playwright";
vi.mock("node:dns/promises", () => ({ resolve4: async () => ["8.8.8.8"] }));
import { renderPublicSource } from "../../scripts/backend/browser-source-worker";

it("keeps a genuine initial navigation timeout fatal and closes the isolated browser context", async () => {
  const timeout = Object.assign(
    new Error("Synthetic initial navigation timeout"),
    { name: "TimeoutError" },
  );
  const page = { goto: vi.fn().mockRejectedValue(timeout) };
  const context = {
    routeWebSocket: vi.fn(),
    route: vi.fn(),
    newPage: async () => page,
    close: vi.fn(),
  };
  const browser = { newContext: async () => context } as unknown as Browser;
  await expect(
    renderPublicSource({
      browser,
      url: "https://public.example.test/notice",
      readTabs: ["#datesTab"],
    }),
  ).rejects.toMatchObject({ name: "TimeoutError", sourceStage: "navigation" });
  expect(page.goto).toHaveBeenCalledWith("https://public.example.test/notice", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  expect(context.close).toHaveBeenCalledOnce();
});
