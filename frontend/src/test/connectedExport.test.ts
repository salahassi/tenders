// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  createConnectedExport,
  retryConnectedExport,
  ExportPackageBlockedError,
  sha256,
  type DurableExportPackage,
} from "../lib/connectedExport";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture(separate = false) {
  const blobs = separate
    ? [
        new Blob(["verified technical bytes"]),
        new Blob(["verified financial bytes"]),
      ]
    : [new Blob(["verified combined bytes"])];
  const saved: DurableExportPackage = {
    id: id(1),
    revision: 1,
    status: "ready",
    mode: "draft",
    proposal_version_id: id(2),
    accepted_at: "2026-11-04T00:00:00Z",
    deadline_at: "2026-11-04T00:10:00Z",
    server_now: "2026-11-04T00:00:05Z",
    job: { status: "succeeded", error_code: null, next_attempt_at: null },
    artifacts: await Promise.all(
      blobs.map(async (blob, i) => ({
        id: id(10 + i),
        volume: separate ? (i ? "financial" : "technical") : "combined",
        status: "ready",
        content_hash: await sha256(blob),
        expected_size: blob.size,
        original_name: `${i}.docx`,
        mime_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })),
    ),
  };
  const click = vi.fn();
  vi.stubGlobal("document", {
    createElement: () => ({ click, href: "", download: "" }),
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw Error("Browser rendering is prohibited for durable export");
      }
    },
  );
  const requests: { path: string; options: any }[] = [];
  const client = {
    request: vi.fn(async (path: string, options: any = {}) => {
      requests.push({ path, options });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (path.startsWith("/v1/proposal-versions/"))
        return { data: { id: id(2), revision: 3, separate_volumes: separate } };
      if (path === "/v1/commands") return { data: [structuredClone(saved)] };
      if (path === `/v1/export-packages/${saved.id}`)
        return { data: structuredClone(saved) };
      throw Error("Unexpected route");
    }),
    downloadArtifact: vi.fn(
      async (artifactId: string) => blobs[Number(artifactId.slice(-12)) - 10],
    ),
  };
  return { saved, blobs, click, client, requests };
}
it("ordinary draft export prepares once on server and downloads only the complete stored verified package", async () => {
  const f = await fixture(true);
  f.client.downloadArtifact.mockImplementation(async (artifact) => {
    expect(f.click).not.toHaveBeenCalled();
    return f.blobs[Number(artifact.slice(-12)) - 10];
  });
  await createConnectedExport(f.client as any, id(2), "draft");
  expect(f.click).toHaveBeenCalledTimes(2);
  expect(
    f.requests
      .filter((r) => r.path === "/v1/commands")
      .map((r) => r.options.body.commands[0]),
  ).toEqual([
    {
      operation: "export.package.prepare",
      input: {
        proposal_version_id: id(2),
        expected_revision: 3,
        mode: "draft",
      },
    },
  ]);
  expect(f.requests.some((r) => r.path.includes("/exports/"))).toBe(false);
});
it.each(["download", "hash", "late-currentness"])(
  "releases no partial file on %s failure",
  async (failure) => {
    const f = await fixture(true);
    if (failure === "late-currentness")
      f.client.request.mockImplementation(async (path) => {
        if (path.startsWith("/v1/proposal-versions/"))
          return { data: { id: id(2), revision: 3, separate_volumes: true } };
        if (path === "/v1/commands") return { data: [f.saved] };
        throw Error("Approval or source changed");
      });
    else
      f.client.downloadArtifact.mockImplementation(async (artifact) => {
        if (artifact === id(10)) return f.blobs[0];
        if (failure === "download") throw Error("Membership revoked");
        return new Blob(["corrupt bytes"]);
      });
    await expect(
      createConnectedExport(f.client as any, id(2), "draft"),
    ).rejects.toThrow();
    expect(f.click).not.toHaveBeenCalled();
  },
);
it("rejects pending volumes disguised as a ready package", async () => {
  const f = await fixture(true);
  f.saved.artifacts[1].status = "pending";
  await expect(
    createConnectedExport(f.client as any, id(2), "draft"),
  ).rejects.toThrow("complete");
  expect(f.client.downloadArtifact).not.toHaveBeenCalled();
});
it("closing a wait aborts only client observation, and a fresh UI key re-enters the same immutable package", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    controller = new AbortController();
  f.saved.status = "preparing";
  f.saved.job.status = "running";
  const first = createConnectedExport(f.client as any, id(2), "draft", {
    signal: controller.signal,
  }).catch((e) => e);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await first).name).toBe("AbortError");
  expect(f.click).not.toHaveBeenCalled();
  f.saved.status = "ready";
  f.saved.job.status = "succeeded";
  await createConnectedExport(f.client as any, id(2), "draft");
  expect(f.click).toHaveBeenCalledOnce();
  const commands = f.requests.filter((r) => r.path === "/v1/commands");
  expect(commands).toHaveLength(2);
  expect(commands[0].options.idempotencyKey).not.toBe(
    commands[1].options.idempotencyKey,
  );
  expect(
    commands.every(
      (r) => r.options.body.commands[0].operation === "export.package.prepare",
    ),
  ).toBe(true);
  expect(f.saved.deadline_at).toBe("2026-11-04T00:10:00Z");
});
it("uses server time despite skewed browser clock, and never resets deadline while polling", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01"));
  const f = await fixture();
  f.saved.status = "preparing";
  f.saved.job.status = "queued";
  const work = createConnectedExport(f.client as any, id(2), "draft");
  await vi.advanceTimersByTimeAsync(0);
  f.saved.status = "ready";
  f.saved.job.status = "succeeded";
  await vi.advanceTimersByTimeAsync(1500);
  await work;
  expect(f.click).toHaveBeenCalledOnce();
  expect(f.requests.filter((r) => r.path === "/v1/commands")).toHaveLength(1);
});
it("requires a separate explicit retry for a blocked package and uses expected revision", async () => {
  const f = await fixture();
  f.saved.status = "blocked";
  f.saved.job.status = "failed";
  f.saved.job.error_code = "EXPORT_RENDER_TIMEOUT";
  const error = await createConnectedExport(
    f.client as any,
    id(2),
    "draft",
  ).catch((e) => e);
  expect(error).toBeInstanceOf(ExportPackageBlockedError);
  expect(f.requests.filter((r) => r.path === "/v1/commands")).toHaveLength(1);
  f.saved.status = "ready";
  f.saved.job.status = "succeeded";
  f.saved.revision = 2;
  f.saved.accepted_at = "2026-11-04T00:10:00Z";
  f.saved.deadline_at = "2026-11-04T00:20:00Z";
  await retryConnectedExport(f.client as any, error.saved);
  expect(
    f.requests.filter((r) => r.path === "/v1/commands")[1].options.body
      .commands[0],
  ).toEqual({
    operation: "export.package.retry",
    input: { id: id(1), expected_revision: 1 },
  });
  expect(f.click).toHaveBeenCalledOnce();
});
it("does not turn a draft package into final export or bypass denied final authorization", async () => {
  const f = await fixture();
  await expect(
    createConnectedExport(f.client as any, id(2), "final"),
  ).rejects.toThrow("does not match");
  expect(f.click).not.toHaveBeenCalled();
  f.client.request.mockImplementation(async (path) => {
    if (path.startsWith("/v1/proposal-versions/"))
      return { data: { id: id(2), revision: 3, separate_volumes: true } };
    throw Error("Final approval required");
  });
  await expect(
    createConnectedExport(f.client as any, id(2), "final"),
  ).rejects.toThrow("Final approval");
  expect(f.client.downloadArtifact).not.toHaveBeenCalled();
});

it("rejects an unexpected authorization clock reset during polling without issuing a retry", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.saved.status = "preparing";
  f.saved.job.status = "queued";
  const work = createConnectedExport(f.client as any, id(2), "draft").catch(
    (e) => e,
  );
  await vi.advanceTimersByTimeAsync(0);
  f.saved.accepted_at = "2026-11-04T00:05:00Z";
  f.saved.deadline_at = "2026-11-04T00:15:00Z";
  f.saved.status = "ready";
  f.saved.job.status = "succeeded";
  await vi.advanceTimersByTimeAsync(1500);
  expect((await work).message).toContain("authorization changed");
  expect(f.click).not.toHaveBeenCalled();
  expect(f.requests.filter((r) => r.path === "/v1/commands")).toHaveLength(1);
});
it("does not fabricate a retryable server failure from an expired observation", async () => {
  const f = await fixture();
  f.saved.status = "preparing";
  f.saved.job.status = "queued";
  f.saved.server_now = f.saved.deadline_at;
  const error = await createConnectedExport(
    f.client as any,
    id(2),
    "draft",
  ).catch((e) => e);
  expect(error).not.toBeInstanceOf(ExportPackageBlockedError);
  expect(error.message).toContain("deadline");
  expect(f.click).not.toHaveBeenCalled();
  expect(f.requests.filter((r) => r.path === "/v1/commands")).toHaveLength(1);
});
