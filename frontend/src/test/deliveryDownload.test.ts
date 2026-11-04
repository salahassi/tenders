// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  downloadDeliveryPackage,
  type DeliveryPackage,
} from "../lib/deliveryDownload";
import { sha256 } from "../lib/connectedExport";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture() {
  const blobs = [
    new Blob(["verified technical bytes"]),
    new Blob(["verified financial bytes"]),
  ];
  const saved: DeliveryPackage = {
    snapshot: {
      id: "snapshot",
      ordinal: 1,
      language: "en",
      content_state: "partial_draft",
      input_state: "available",
      assurance_state: "unreviewed",
      gap_count: 2,
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
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const client = {
    downloadDeliveryArtifact: vi.fn(async (id: string) => blobs[Number(id)]),
  };
  return { blobs, saved, click, client };
}

it("downloads both verified volumes only after the entire immutable package is fetched", async () => {
  const f = await fixture();
  f.client.downloadDeliveryArtifact.mockImplementation(async (id) => {
    expect(f.click).not.toHaveBeenCalled();
    return f.blobs[Number(id)];
  });
  await downloadDeliveryPackage(f.client as any, f.saved);
  expect(f.client.downloadDeliveryArtifact).toHaveBeenCalledTimes(2);
  expect(f.click).toHaveBeenCalledTimes(2);
});

it("never signals complete download when one volume fails or differs from its saved hash", async () => {
  for (const fail of ["transport", "hash"]) {
    const f = await fixture();
    f.client.downloadDeliveryArtifact.mockImplementation(async (id) => {
      if (id === "0") return f.blobs[0];
      if (fail === "transport") throw Error("authorization revoked");
      return new Blob(["unverified financial bytes"]);
    });
    await expect(
      downloadDeliveryPackage(f.client as any, f.saved),
    ).rejects.toThrow();
    expect(f.click).not.toHaveBeenCalled();
  }
});

it("rejects incomplete, duplicate and unready volume sets before downloading anything", async () => {
  for (const variant of ["missing", "duplicate", "pending"]) {
    const f = await fixture();
    if (variant === "missing") f.saved.artifacts.pop();
    if (variant === "duplicate") f.saved.artifacts[1].volume = "technical";
    if (variant === "pending") f.saved.status = "preparing";
    await expect(
      downloadDeliveryPackage(f.client as any, f.saved),
    ).rejects.toThrow();
    expect(f.client.downloadDeliveryArtifact).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  }
});
