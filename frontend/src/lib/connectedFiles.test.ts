import { reviewOriginalEligibility } from "./contentEligibility";
import { it, expect, vi, beforeEach } from "vitest";
import { ConnectedRepository } from "./connectedRepository";
import type { BackendClient } from "./backendClient";
import type { DocumentRecord } from "../types";
vi.mock("./contentEligibility", () => ({
  reviewOriginalEligibility: vi.fn(async () => true),
}));
const originals = new Map<string, Blob>();
vi.mock("./knowledgeFiles", () => ({
  getLocalFile: async (id: string) => originals.get(id),
}));
const w = "00000000-0000-4000-8000-000000000010",
  o = "00000000-0000-4000-8000-000000000011",
  actor = "00000000-0000-4000-8000-000000000012";
beforeEach(() => originals.clear());
function fixture(fail = false) {
  const commands: { operation: string; input: any }[] = [],
    parts: string[] = [],
    documents: any[] = [];
  let pending: any;
  const request = vi.fn(async (path: string, options?: any) => {
    if (path === "/v1/bootstrap")
      return {
        data: {
          membership: { workspace_id: w, role: "Owner", user_id: actor },
          workspace: { id: w, revision: 1, name: "Synthetic", settings: {} },
          operations: null,
        },
      };
    if (path === "/v1/commands") {
      expect(
        new TextEncoder().encode(JSON.stringify(options.body)).length,
      ).toBeLessThan(1048576);
      const results = options.body.commands.map((c: any) => {
        commands.push(c);
        if (c.operation === "document.prepare") {
          pending = {
            ...c.input,
            id: c.input.client_id,
            revision: 1,
            storage_key: `${w}/${c.input.client_id}`,
            status: "pending",
            original_hash: c.input.hash,
            created_at: "2026-10-15T00:00:00Z",
            created_by: actor,
          };
          return pending;
        }
        if (c.operation === "document.extraction") {
          expect(
            new TextEncoder().encode(JSON.stringify(c.input.parts)).length,
          ).toBeLessThan(262144);
          for (const x of c.input.parts) parts[x.ordinal] = x.text;
        }
        return { id: c.input.id, revision: 1 };
      });
      return { data: results };
    }
    if (path.endsWith("/complete-upload")) {
      if (fail) throw new Error("Server verification failed");
      documents.push({
        ...pending,
        status: "ready",
        extracted_text: parts.join(""),
      });
      return { data: documents[0] };
    }
    return {
      data: {
        records: path.startsWith("/v1/opportunities?")
          ? [
              {
                id: o,
                revision: 1,
                title: "Synthetic",
                reference: "T1",
                language: "ar",
                decision: "shortlisted",
                created_at: "2026-10-15T00:00:00Z",
              },
            ]
          : path.startsWith("/v1/documents?")
            ? documents
            : [],
        next_cursor: null,
      },
    };
  });
  const uploadOriginal = vi.fn(async () => {});
  return {
    repository: new ConnectedRepository({
      request,
      uploadOriginal,
    } as unknown as BackendClient),
    commands,
    parts,
    request,
    uploadOriginal,
  };
}
function file(text: string): DocumentRecord {
  return {
    id: crypto.randomUUID(),
    name: "synthetic.txt",
    text,
    hash: "a".repeat(64),
    size: 50,
    status: "ready",
    uploadedAt: "2026-10-15T00:00:00Z",
    classification: "unspecified",
  };
}
it("uploads original then bounded Unicode parts; only completed server documents enter state", async () => {
  const f = fixture(),
    previous = await f.repository.load(),
    next = structuredClone(previous),
    d = file("نص عربي 🪄 ".repeat(25000));
  originals.set(d.id, new Blob(["Synthetic original"]));
  next.opportunities[0].documents.push(d);
  const result = await f.repository.save(previous, next);
  expect(f.parts.join("")).toBe(d.text);
  expect(f.uploadOriginal).toHaveBeenCalledTimes(1);
  expect(result.opportunities[0].documents[0]).toMatchObject({
    persisted: true,
    text: d.text,
    extractionConfirmed: false,
  });
  expect(f.commands[0].operation).toBe("document.prepare");
});
it("does not report acceptance when server verification fails, and preserves upload steps on retry", async () => {
  const f = fixture(true),
    previous = await f.repository.load(),
    next = structuredClone(previous),
    d = file("Synthetic text");
  originals.set(d.id, new Blob(["Synthetic original"]));
  next.opportunities[0].documents.push(d);
  await expect(f.repository.save(previous, next)).rejects.toThrow(
    "Server verification failed",
  );
  await expect(f.repository.save(previous, next)).rejects.toThrow(
    "Server verification failed",
  );
  expect(f.uploadOriginal).toHaveBeenCalledTimes(1);
  expect(previous.opportunities[0].documents).toEqual([]);
});
it("rejects a file without actual original bytes before any upload or accepted-state write", async () => {
  const f = fixture(),
    previous = await f.repository.load(),
    next = structuredClone(previous);
  next.opportunities[0].documents.push(file("Synthetic"));
  await expect(f.repository.save(previous, next)).rejects.toThrow(
    "original is missing",
  );
  expect(f.uploadOriginal).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});

it("sends neither a reservation nor original bytes before original eligibility is confirmed", async () => {
  const f = fixture(),
    previous = await f.repository.load(),
    next = structuredClone(previous),
    d = file("Synthetic text");
  originals.set(d.id, new Blob(["Synthetic original"]));
  next.opportunities[0].documents.push(d);
  vi.mocked(reviewOriginalEligibility).mockRejectedValueOnce(
    new Error("Original review canceled"),
  );
  await expect(f.repository.save(previous, next)).rejects.toThrow(
    "Original review canceled",
  );
  expect(f.commands).toHaveLength(0);
  expect(f.uploadOriginal).not.toHaveBeenCalled();
});
