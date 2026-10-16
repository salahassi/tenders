// @vitest-environment node
import { it, expect, vi } from "vitest";
import {
  collect,
  parseSource,
  publicAddress,
  type SourceInput,
} from "../../supabase/functions/_shared/collector";
import { createWorkerHandler } from "../../supabase/functions/worker/handler";
import type {
  Backend,
  BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { modelEnvironments } from "../../supabase/functions/_shared/backend";
const source: SourceInput = {
  id: crypto.randomUUID(),
  url: "https://feed.example.test/rss",
  kind: "rss",
  approval: "approved",
  approved_hosts: ["feed.example.test"],
  policy_note: "Synthetic permitted fixture",
  adapter_config: {},
};
const resolve = async () => ["93.184.216.34"];
const rss =
  "<rss><channel><item><guid>1</guid><title>Software procurement</title><description>Contact person: Person\nEmail test@example.test\nProvide a software platform.</description><link>https://feed.example.test/t/1?utm_source=test</link></item></channel></rss>";
it("parses RSS and Atom and strips contact fields without inferring dates", () => {
  const r = parseSource(source, rss);
  expect(r.items[0]).toMatchObject({
    identity_key: "external:1",
    canonical_url: "https://feed.example.test/t/1",
    deadline_at: null,
  });
  expect(r.items[0].description).not.toMatch(/Person|test@example/);
  const atom = parseSource(
    source,
    '<feed><entry><id>2</id><title>Platform</title><link href="https://feed.example.test/2"/><summary>Integrate systems.</summary></entry></feed>',
  );
  expect(atom.items[0].canonical_url).toBe("https://feed.example.test/2");
});
it("validates declarative JSON paths and marks truncation; rejects entity expansion", () => {
  expect(() =>
    parseSource(source, '<!DOCTYPE rss [<!ENTITY x "unsafe">]><rss/>'),
  ).toThrow("UNSAFE_XML");
  const json = {
    ...source,
    kind: "json_feed",
    adapter_config: { items: "data", fields: { title: "name", url: "link" } },
  };
  expect(
    parseSource(
      json,
      JSON.stringify({
        data: Array.from({ length: 101 }, (_, i) => ({
          name: `Synthetic ${i}`,
          link: `https://feed.example.test/${i}`,
        })),
      }),
    ).warnings,
  ).toContain("ITEM_LIMIT_REACHED");
  expect(() =>
    parseSource({ ...json, adapter_config: { items: "__proto__.x" } }, "{}"),
  ).toThrow();
});
it("rejects proposed, unapproved-host, private and mixed DNS destinations without fetching", async () => {
  const fetcher = vi.fn();
  await expect(
    collect({ ...source, approval: "proposed" }, [], resolve, fetcher),
  ).rejects.toThrow("SOURCE_PERMISSION_REQUIRED");
  await expect(collect(source, [], resolve, fetcher)).rejects.toThrow(
    "DEPLOYMENT_HOST_APPROVAL_REQUIRED",
  );
  await expect(
    collect(
      source,
      source.approved_hosts,
      async () => ["93.184.216.34", "127.0.0.1"],
      fetcher,
    ),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  expect(fetcher).not.toHaveBeenCalled();
  for (const address of [
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.1.1",
    "100.64.1.1",
    "::1",
    "0.0.0.0",
    "198.18.0.1",
  ])
    expect(publicAddress(address)).toBe(false);
});
it("revalidates every redirect and respects 304 validators", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.test/" },
      }),
  );
  await expect(
    collect(source, source.approved_hosts, resolve, fetcher),
  ).rejects.toThrow("DEPLOYMENT_HOST_APPROVAL_REQUIRED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const conditional = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 304 }),
  );
  expect(
    (
      await collect(
        { ...source, etag: '"v1"' },
        source.approved_hosts,
        resolve,
        conditional,
      )
    ).items,
  ).toEqual([]);
  expect(conditional.mock.calls[0]?.[1]).toMatchObject({
    headers: { "If-None-Match": '"v1"' },
  });
});
it("bounded streams and login walls do not yield success; unknown 429 reset stays unknown", async () => {
  await expect(
    collect(
      source,
      source.approved_hosts,
      resolve,
      async () => new Response("x".repeat(1048577)),
    ),
  ).rejects.toThrow("SOURCE_TOO_LARGE");
  await expect(
    collect(
      source,
      source.approved_hosts,
      resolve,
      async () => new Response('<input type="password">'),
    ),
  ).rejects.toThrow("MANUAL_SOURCE_REQUIRED");
  try {
    await collect(
      source,
      source.approved_hosts,
      resolve,
      async () => new Response(null, { status: 429 }),
    );
    expect.unreachable();
  } catch (e) {
    expect(e).toMatchObject({ code: "SOURCE_QUOTA_WAIT", retryAfter: null });
  }
});
it("directory discovery emits bounded candidates without visiting them", async () => {
  const f = vi.fn(
    async () =>
      new Response(
        '<a href="/tenders">Tenders</a><a href="javascript:alert(1)">Bad</a>',
      ),
  );
  const r = await collect(
    { ...source, kind: "link_directory" },
    source.approved_hosts,
    resolve,
    f,
  );
  expect(r.candidates).toEqual([
    { url: "https://feed.example.test/tenders", name: "Tenders" },
  ]);
  expect(f).toHaveBeenCalledTimes(1);
});
it("worker authenticates before claiming and commits only the validated source result", async () => {
  const env: BackendEnvironment = {
    url: "https://synthetic.supabase.co",
    publishableKey: "fixture",
    serviceKey: "fixture",
    workerSecret: "fixture-only-secret",
    allowedOrigins: [],
    collectionHosts: source.approved_hosts,
    models: modelEnvironments(() => undefined),
  };
  const job = {
    id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
    type: "source_collect",
  };
  const backend = {
    claim: vi.fn(async () => job),
    internal: vi.fn(async (name: string) =>
      name === "collection_context"
        ? source
        : name === "claim_storage_cleanup"
          ? []
          : { processed: 1 },
    ),
    finish: vi.fn(),
  };
  const f = vi.fn(async () => new Response(rss));
  const handler = createWorkerHandler(
    env,
    resolve,
    () => backend as unknown as Backend,
    f,
  );
  expect(
    (await handler(new Request("https://worker.test", { method: "POST" })))
      .status,
  ).toBe(401);
  expect(backend.claim).not.toHaveBeenCalled();
  expect(
    (
      await handler(
        new Request("https://worker.test", {
          method: "POST",
          headers: { "x-worker-secret": env.workerSecret },
        }),
      )
    ).status,
  ).toBe(200);
  expect(backend.internal).toHaveBeenCalledWith(
    "complete_collection",
    expect.objectContaining({
      job_id: job.id,
      lease: job.lease_token,
      result: expect.objectContaining({ items: expect.any(Array) }),
    }),
  );
});

it("bounds DNS lookup time before any outbound HTTP request", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn();
    const promise = collect(
      source,
      source.approved_hosts,
      () => new Promise(() => {}),
      fetcher,
    );
    const assertion = expect(promise).rejects.toThrow("SOURCE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
