// @vitest-environment node
import { it, expect } from "vitest";
import {
  registerOriginalReviewer,
  reviewOriginalEligibility,
} from "./contentEligibility";
import type { DocumentRecord } from "../types";
async function fixture(text = "Public synthetic procurement scope") {
  const blob = new Blob([text]);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    blob,
    document: {
      id: crypto.randomUUID(),
      name: "synthetic.txt",
      text,
      hash,
      size: blob.size,
      status: "ready",
      classification: "unspecified",
      uploadedAt: new Date().toISOString(),
    } as DocumentRecord,
  };
}
it("binds original review to exact bytes and requires review again for different content", async () => {
  let calls = 0;
  const remove = registerOriginalReviewer(async () => {
    calls++;
    return true;
  });
  try {
    const f = await fixture();
    await reviewOriginalEligibility(f.document, f.blob);
    await reviewOriginalEligibility(f.document, f.blob);
    expect(calls).toBe(1);
    await expect(
      reviewOriginalEligibility(f.document, new Blob(["Changed"])),
    ).rejects.toThrow("original changed");
    const other = await fixture("Different eligible public synthetic file");
    await reviewOriginalEligibility(other.document, other.blob);
    expect(calls).toBe(2);
  } finally {
    remove();
  }
});
it("rejects a prohibited original before review and cannot turn consent into eligibility", async () => {
  let calls = 0;
  const remove = registerOriginalReviewer(async () => {
    calls++;
    return true;
  });
  try {
    const f = await fixture("Contact synthetic.person@example.test");
    await expect(reviewOriginalEligibility(f.document, f.blob)).rejects.toThrow(
      "has not been uploaded",
    );
    expect(calls).toBe(0);
  } finally {
    remove();
  }
});
it("fails closed when the review screen is unavailable or canceled", async () => {
  const f = await fixture();
  await expect(reviewOriginalEligibility(f.document, f.blob)).rejects.toThrow(
    "unavailable",
  );
  const remove = registerOriginalReviewer(async () => false);
  try {
    await expect(reviewOriginalEligibility(f.document, f.blob)).rejects.toThrow(
      "Upload canceled",
    );
  } finally {
    remove();
  }
});
