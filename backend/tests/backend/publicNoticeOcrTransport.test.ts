// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({
  gets: [] as any[],
  tunnels: [] as any[],
  tls: [] as any[],
}));
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  return {
    ...actual,
    request: (url: URL, options: any, callback: (response: any) => void) => {
      transport.gets.push({ url, options });
      const request: any = new EventEmitter();
      request.end = () => {
        if (options.agent) options.agent.createConnection();
        const response: any = Readable.from([
          Buffer.from("public synthetic bytes"),
        ]);
        response.rawHeaders = ["Content-Type", "application/pdf"];
        response.statusCode = 200;
        callback(response);
      };
      return request;
    },
  };
});
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    request: (options: any) => {
      transport.tunnels.push(options);
      const request: any = new EventEmitter();
      request.end = () =>
        request.emit(
          "connect",
          { statusCode: 200 },
          new PassThrough(),
          Buffer.alloc(0),
        );
      return request;
    },
  };
});
vi.mock("node:tls", async (original) => {
  const actual = await original<typeof import("node:tls")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    connect: (options: any) => {
      transport.tls.push(options);
      return new PassThrough();
    },
  };
});
import {
  fetchOcrDocument,
  pinnedPublicGet,
} from "../../scripts/backend/public-notice-ocr-worker";
afterEach(() => {
  vi.unstubAllEnvs();
  transport.gets.length = 0;
  transport.tunnels.length = 0;
  transport.tls.length = 0;
});

it("pins the validated IPv4 for native HTTPS while retaining the official hostname", async () => {
  vi.stubEnv("HTTP_PROXY", "");
  vi.stubEnv("HTTPS_PROXY", "");
  const target = new URL("https://public.example.test/notice.pdf");
  const response = await pinnedPublicGet(
    target,
    "8.8.8.8",
    AbortSignal.timeout(1000),
  );
  expect(await response.text()).toBe("public synthetic bytes");
  const { url, options } = transport.gets[0];
  expect(url.hostname).toBe("public.example.test");
  const one = vi.fn();
  options.lookup("public.example.test", { all: false }, one);
  expect(one).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  const all = vi.fn();
  options.lookup("public.example.test", { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  expect(options.family).toBe(4);
  expect(transport.tunnels).toHaveLength(0);
});

it("uses the inherited proxy for the pinned public target and verifies TLS against the original hostname", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://session-proxy.example.test:8080");
  const response = await pinnedPublicGet(
    new URL("https://public.example.test/notice.pdf"),
    "8.8.4.4",
    AbortSignal.timeout(1000),
  );
  await response.text();
  expect(transport.tunnels[0]).toMatchObject({
    hostname: "session-proxy.example.test",
    port: "8080",
    method: "CONNECT",
    path: "8.8.4.4:443",
    headers: { Host: "public.example.test:443" },
  });
  expect(transport.tls[0]).toMatchObject({
    servername: "public.example.test",
    rejectUnauthorized: true,
  });
  expect(transport.tls[0].socket).toBeDefined();
});

it("shares one deadline across DNS and redirect requests", async () => {
  const request = {
    url: "https://public.example.test/a",
    sha256: "a".repeat(64),
    approved_hosts: ["public.example.test"],
  };
  const expiredLookup = vi.fn(async () => ["8.8.8.8"]);
  await expect(
    fetchOcrDocument(request, vi.fn(), expiredLookup, Date.now() - 1),
  ).rejects.toThrow("SOURCE_TIMEOUT");
  expect(expiredLookup).not.toHaveBeenCalled();
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    signals.push(options!.signal!);
    return new Response(null, { status: 302, headers: { location: "/next" } });
  });
  await expect(
    fetchOcrDocument(request, fetcher, async () => ["8.8.8.8"]),
  ).rejects.toThrow("UNSAFE_DESTINATION");
  expect(signals).toHaveLength(4);
  expect(new Set(signals).size).toBe(1);
});
