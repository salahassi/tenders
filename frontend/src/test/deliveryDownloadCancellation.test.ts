// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  downloadDeliveryPackage,
  type DeliveryPackage,
} from "../lib/deliveryDownload";
import { sha256 } from "../lib/connectedExport";
import { BackendClient } from "../lib/backendClient";
vi.mock("../lib/deployment", () => ({
  deployment: {
    projectUrl: "https://api.example.test",
    publishableKey: "synthetic-public",
  },
}));
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth }) }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("does not click either volume after cancellation while a non-cooperative fetch is pending", async () => {
  const blobs = [
    new Blob(["synthetic technical"]),
    new Blob(["synthetic financial"]),
  ];
  const saved: DeliveryPackage = {
    snapshot: {
      id: "one",
      ordinal: 1,
      language: "en",
      content_state: "source_draft",
      input_state: "available",
      assurance_state: "unreviewed",
      gap_count: 1,
    },
    status: "ready",
    artifacts: await Promise.all(
      blobs.map(async (blob, index) => ({
        id: String(index),
        volume: index ? "financial" : "technical",
        status: "ready",
        content_hash: await sha256(blob),
        expected_size: blob.size,
        original_name: `${index}.docx`,
        mime_type: "application/docx",
      })),
    ),
  };
  const click = vi.fn();
  vi.stubGlobal("document", {
    createElement: () => ({ click, href: "", download: "" }),
  });
  const createUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:synthetic");
  let finish!: (value: Blob) => void;
  const client = {
    downloadDeliveryArtifact: vi.fn(async (id: string) =>
      id === "0"
        ? blobs[0]
        : new Promise<Blob>((resolve) => {
            finish = resolve;
          }),
    ),
  };
  const controller = new AbortController();
  const download = downloadDeliveryPackage(
    client as unknown as BackendClient,
    saved,
    controller.signal,
  );
  controller.abort();
  finish(blobs[1]);
  await expect(download).rejects.toMatchObject({ name: "AbortError" });
  expect(client.downloadDeliveryArtifact.mock.calls).toEqual([
    ["0", controller.signal],
    ["1", controller.signal],
  ]);
  expect(createUrl).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});

it("allows only the exact authenticated delivery recovery file path and transports cancellation to fetch", async () => {
  auth.getSession.mockResolvedValue({
    data: { session: { access_token: "synthetic-token" } },
    error: null,
  });
  const fetcher = vi.fn(async () => new Response("synthetic persisted bytes"));
  vi.stubGlobal("fetch", fetcher);
  const client = new BackendClient(
    "https://api.example.test",
    "synthetic-public",
  );
  const id = "00000000-0000-4000-8000-000000000001";
  const controller = new AbortController();
  await client.downloadDeliveryArtifact(id, controller.signal);
  expect(fetcher).toHaveBeenLastCalledWith(
    `https://api.example.test/functions/v1/api/v1/delivery-artifacts/${id}/download`,
    {
      headers: { Authorization: "Bearer synthetic-token" },
      signal: controller.signal,
    },
  );
  await client.downloadBytes(
    `/v1/recovery/files/proposal_delivery_artifacts/${id}`,
    controller.signal,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const path of [
    `/v1/recovery/files/proposal_delivery_snapshots/${id}`,
    `/v1/recovery/files/proposal_delivery_artifacts/${id}?actor_id=other`,
    `https://other.example.test/${id}`,
    `/v1/recovery/files/proposal_delivery_artifacts/../${id}`,
  ])
    await expect(client.downloadBytes(path)).rejects.toThrow(
      "Invalid file path",
    );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not start a file fetch if navigation aborts while authentication is being read", async () => {
  const controller = new AbortController();
  auth.getSession.mockImplementation(async () => {
    controller.abort();
    return {
      data: { session: { access_token: "synthetic-token" } },
      error: null,
    };
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new BackendClient(
    "https://api.example.test",
    "synthetic-public",
  );
  await expect(
    client.downloadDeliveryArtifact(
      "00000000-0000-4000-8000-000000000001",
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
