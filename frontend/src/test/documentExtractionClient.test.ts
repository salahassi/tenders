// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { BackendClient } from "../lib/backendClient";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth }) }));
vi.mock("../lib/deployment", () => ({
  deployment: {
    projectUrl: "https://api.example.test",
    publishableKey: "synthetic-public",
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("transports page/source pins, explicit blank review, idempotency and cancellation to the dedicated authenticated correction route", async () => {
  auth.getSession.mockResolvedValue({
    data: { session: { access_token: "synthetic-token" } },
    error: null,
  });
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: { id: "saved" },
          meta: { request_id: "synthetic" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new BackendClient(
    "https://api.example.test",
    "synthetic-public",
  );
  const controller = new AbortController();
  const id = "00000000-0000-4000-8000-000000000001";
  await client.documentExtraction(id, controller.signal);
  const input = {
    id,
    expected_revision: 7,
    expected_original_hash: "a".repeat(64),
    expected_extraction_hash: "b".repeat(64),
    review_confirmed: true as const,
    pages: [
      {
        page: 3,
        expected_page_text_hash: "c".repeat(64),
        text: "",
        blank_confirmed: true,
      },
    ],
  };
  expect(
    await client.correctDocumentExtraction(
      input,
      "same-correction",
      controller.signal,
    ),
  ).toEqual({ id: "saved" });
  const [url, options] = fetcher.mock.calls[1] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe(
    `https://api.example.test/functions/v1/api/v1/documents/${id}/extraction`,
  );
  expect(JSON.parse(options.body as string)).toEqual(input);
  expect(options.signal).toBe(controller.signal);
  expect(options.headers).toMatchObject({
    Authorization: "Bearer synthetic-token",
    "Idempotency-Key": "same-correction",
  });
  expect(
    (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal,
  ).toBe(controller.signal);
});
