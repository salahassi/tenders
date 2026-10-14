import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "idb-keyval";
import type { KnowledgeDocument } from "../types";
import {
  clearLocalFiles,
  getEnabledKnowledgeContext,
  getLocalFile,
  removeLocalFile,
  saveLocalFile,
} from "./knowledgeFiles";

const readable: KnowledgeDocument = {
  id: "reference-a",
  name: "Company profile.txt",
  size: 45,
  uploadedAt: "2026-10-14T12:00:00Z",
  text: "A company profile with approved public facts.",
  status: "ready",
  classification: "public",
  hash: "sha256-example",
  category: "company",
  enabled: true,
};

afterEach(async () => {
  await clearLocalFiles();
});

describe("browser-local reference originals", () => {
  it("persists original bytes independently from metadata and removes only the selected original", async () => {
    const file = new NodeBlob(["original file content"], {
      type: "text/plain",
    });
    await saveLocalFile("file-a", file as Blob);
    await saveLocalFile("file-b", new NodeBlob(["keep this file"]) as Blob);
    const persisted = await getLocalFile("file-a");
    expect(await persisted?.text()).toBe("original file content");
    expect(persisted?.type).toBe("text/plain");
    await removeLocalFile("file-a");
    expect(await getLocalFile("file-a")).toBeUndefined();
    expect(await (await getLocalFile("file-b"))?.text()).toBe("keep this file");
  });

  it("clears attachment keys without deleting workspace state", async () => {
    await set("workspace-marker", { preserved: true });
    await saveLocalFile("file-a", new NodeBlob(["original"]) as Blob);
    await clearLocalFiles();
    expect(await getLocalFile("file-a")).toBeUndefined();
    expect(await get("workspace-marker")).toEqual({ preserved: true });
  });
});

describe("knowledge context selection", () => {
  it("exposes traceable readable text while excluding opted-out, unreadable, failed, and empty references", () => {
    const items = [
      readable,
      { ...readable, id: "excluded", enabled: false },
      { ...readable, id: "scanned", status: "needs_ocr" as const },
      { ...readable, id: "failed", status: "error" as const },
      { ...readable, id: "empty", text: "  " },
    ];
    expect(getEnabledKnowledgeContext(items)).toEqual([
      {
        id: readable.id,
        name: readable.name,
        category: readable.category,
        text: readable.text,
        hash: readable.hash,
        classification: readable.classification,
      },
    ]);
  });
});
