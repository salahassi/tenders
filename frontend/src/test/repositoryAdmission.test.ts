// @vitest-environment node
import { expect, it, vi } from "vitest";
import { ConnectedRepository } from "../lib/connectedRepository";
import { BackendClient, BackendRequestError } from "../lib/backendClient";
vi.mock("../lib/deployment", () => ({ deployment: {} }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const auth = {
  auth: {
    getSession: async () => ({
      data: {
        session: { access_token: "synthetic-token", user: { id: id(1) } },
      },
      error: null,
    }),
  },
};
const envelope = (data: unknown) => ({
  data,
  meta: { request_id: "synthetic" },
});
const boot = (name = "Current workspace") =>
  envelope({
    membership: { workspace_id: id(1), role: "Owner" },
    workspace: { id: id(1), revision: 1, name, settings: {} },
    operations: null,
  });
const empty = () => envelope({ records: [], next_cursor: null });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it("serializes complete required tables and preserves one-record content pages plus terminal empty page", async () => {
  let active = 0,
    peak = 0;
  const rows = [2, 3].map((n) => ({
    id: id(n),
    revision: 1,
    category: "company",
    title: `Evidence ${n}`,
    content: "يجب تسليم 12 وحدة، ولا يجوز حذف الاستثناء.",
    evidence: "Original source",
    verified: true,
  }));
  const request = vi.fn(async (path: string) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (path === "/v1/bootstrap") return boot();
    if (path.startsWith("/v1/knowledge?")) {
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      const n = cursor === id(2) ? 1 : cursor === id(3) ? 2 : 0;
      return envelope({
        records: n < rows.length ? [rows[n]] : [],
        next_cursor: n < rows.length ? rows[n].id : null,
      });
    }
    return empty();
  });
  const state = await new ConnectedRepository({
    request,
    auth,
  } as unknown as BackendClient).load();
  expect(peak).toBe(1);
  expect(request).toHaveBeenCalledTimes(19);
  expect(
    state.knowledge.map(({ id, content, evidence }) => ({
      id,
      content,
      evidence,
    })),
  ).toEqual(
    rows.map(({ id, content, evidence }) => ({ id, content, evidence })),
  );
  expect(
    request.mock.calls
      .filter(([p]) => p.startsWith("/v1/knowledge?"))
      .at(-1)?.[0],
  ).toContain(`cursor=${id(3)}`);
});

it("serializes overlapping loads and does not send or publish superseded queued loads", async () => {
  const held = deferred<ReturnType<typeof boot>>();
  const request = vi.fn(async (path: string) =>
    path === "/v1/bootstrap"
      ? request.mock.calls.length === 1
        ? held.promise
        : boot("Newest")
      : empty(),
  );
  const repository = new ConnectedRepository({
    request,
    auth,
  } as unknown as BackendClient);
  const old = repository.load();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const oldFailure = expect(old).rejects.toThrow("newer workspace request");
  const replaced = repository.load();
  const replacedFailure = expect(replaced).rejects.toThrow(
    "newer workspace request",
  );
  const latest = repository.load();
  expect(request).toHaveBeenCalledTimes(1);
  held.resolve(boot("Old"));
  await oldFailure;
  await replacedFailure;
  expect((await latest).settings.companyName).toBe("Newest");
  expect(
    request.mock.calls.filter(([p]) => p === "/v1/bootstrap"),
  ).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(18);
});

it("stops superseded pagination before another page and leaves the next load usable", async () => {
  const page = deferred<ReturnType<typeof empty>>();
  let held = false;
  const request = vi.fn(async (path: string) => {
    if (path === "/v1/bootstrap") return boot();
    if (path.startsWith("/v1/knowledge?") && !held) {
      held = true;
      return page.promise;
    }
    return empty();
  });
  const repository = new ConnectedRepository({
    request,
    auth,
  } as unknown as BackendClient);
  const old = repository.load();
  await vi.waitFor(() => expect(held).toBe(true));
  const rejected = expect(old).rejects.toThrow("newer workspace request");
  const next = repository.load();
  page.resolve(
    envelope({ records: [{ id: id(2), revision: 1 }], next_cursor: id(2) }),
  );
  await rejected;
  await next;
  expect(request.mock.calls.some(([p]) => p.includes(`cursor=${id(2)}`))).toBe(
    false,
  );
});

it("does not retry external busy and releases load sequencing for explicit refresh", async () => {
  const busy = new BackendRequestError(
    "FILE_PROCESSING_BUSY",
    "A file request is already running. Try again when it finishes.",
    503,
  );
  let fail = true;
  const request = vi.fn(async (path: string) => {
    if (path === "/v1/bootstrap") return boot();
    if (path.startsWith("/v1/documents?") && fail) throw busy;
    return empty();
  });
  const repository = new ConnectedRepository({
    request,
    auth,
  } as unknown as BackendClient);
  await expect(repository.load()).rejects.toBe(busy);
  expect(
    request.mock.calls.filter(([p]) => p.startsWith("/v1/documents?")),
  ).toHaveLength(1);
  fail = false;
  expect((await repository.refresh()).settings.companyName).toBe(
    "Current workspace",
  );
});
