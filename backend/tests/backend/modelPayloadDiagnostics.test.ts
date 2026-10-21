// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { FreeModelProvider } from "../../supabase/functions/_shared/model";
import { taskJsonSchema } from "../../supabase/functions/_shared/modelContract";
import { geminiAdapter } from "../../supabase/functions/_shared/modelAdapters/gemini";

afterEach(() => vi.restoreAllMocks());

const env = {
  provider: "gemini_free",
  model: "fixture-model",
  projectRef: "private-project-reference",
  key: "fixture-private-api-credential",
};
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const completed = () =>
  Response.json({
    candidates: [
      { finishReason: "STOP", content: { parts: [{ text: "{}" }] } },
    ],
  });

it("fingerprints the exact POST bytes and real wire schema without logging their contents", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  let sent = "";
  const client = new FreeModelProvider(env, async (_url, init) => {
    sent = String(init?.body);
    return Response.json(
      { id: "accepted-fixture-id", status: "in_progress" },
      { headers: { "x-goog-request-id": "fixture-request-id" } },
    );
  });
  const prompt = 'Private fixture نص عربي 🔍 with "quotes"\nand a newline';
  const schema = taskJsonSchema("analyze_chunk");
  await client.startBackground("analyze_chunk", prompt, schema);
  const wireSchema = JSON.parse(sent).response_format.schema;
  const [event, encoded] = info.mock.calls[0];
  const diagnostic = JSON.parse(String(encoded));
  expect(event).toBe("provider_payload_diagnostic");
  expect(diagnostic).toEqual({
    provider: "gemini_free",
    model: env.model,
    task: "analyze_chunk",
    endpoint: "interactions",
    api_version: "v1beta",
    api_revision: "2026-05-20",
    wire_sha256: digest(sent),
    wire_bytes: Buffer.byteLength(sent, "utf8"),
    schema_sha256: digest(JSON.stringify(wireSchema)),
    schema_bytes: Buffer.byteLength(JSON.stringify(wireSchema), "utf8"),
    max_output_tokens: JSON.parse(sent).generation_config.max_output_tokens,
    reasoning: "provider_default",
    background: true,
  });
  expect(info.mock.calls[1]).toEqual([
    "provider_payload_result",
    JSON.stringify({
      wire_sha256: digest(sent),
      status: 200,
      request_id: "fixture-request-id",
      response_id: "accepted-fixture-id",
    }),
  ]);
  const logs = JSON.stringify(info.mock.calls);
  for (const privateValue of [
    prompt,
    "Private fixture",
    "نص عربي",
    env.key,
    env.projectRef,
    "processed_block_ids",
    "system_instruction",
    "x-goog-api-key",
  ])
    expect(logs).not.toContain(privateValue);
});

it("serializes a synchronous payload once and fingerprints that exact serialization", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  let sent = "";
  let serializations = 0;
  const schema = {
    type: "object",
    properties: { fixture: { type: "string" } },
  };
  const prepare = geminiAdapter.prepare;
  vi.spyOn(geminiAdapter, "prepare").mockImplementationOnce((...args) => {
    const request = prepare(...args);
    const body = request.body as any;
    request.body = {
      toJSON() {
        serializations++;
        return {
          ...body,
          generationConfig: {
            ...body.generationConfig,
            responseJsonSchema: {
              type: "object",
              properties: {
                [`fixture${serializations}`]: { type: "string" },
              },
            },
          },
        };
      },
    };
    return request;
  });
  const client = new FreeModelProvider(env, async (_url, init) => {
    sent = String(init?.body);
    return completed();
  });
  await client.generate("connection_probe", "private fixture input", schema);
  expect(serializations).toBe(1);
  const wireSchema = JSON.parse(sent).generationConfig.responseJsonSchema;
  const diagnostic = JSON.parse(String(info.mock.calls[0][1]));
  expect(diagnostic).toMatchObject({
    wire_sha256: digest(sent),
    schema_sha256: digest(JSON.stringify(wireSchema)),
    endpoint: "generate_content",
    api_revision: null,
    background: false,
  });
  expect(JSON.stringify(info.mock.calls)).not.toContain("fixture1");
});

it("keeps polling bodyless without reusing a submission hash as a GET payload hash", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const requests: RequestInit[] = [];
  const client = new FreeModelProvider(env, async (_url, init) => {
    requests.push(init!);
    return Response.json({ id: "fixture-id", status: "in_progress" });
  });
  await client.startBackground("connection_probe", "fixture", {});
  expect(info).toHaveBeenCalledTimes(2);
  info.mockClear();
  await client.pollBackground("fixture-id");
  expect(requests[1].method).toBe("GET");
  expect(requests[1].body).toBeUndefined();
  expect(info).not.toHaveBeenCalled();
  expect(client.telemetry).not.toHaveProperty("wire_sha256");
});

it("does not emit payload diagnostics for countTokens calls", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const client = new FreeModelProvider(env, async () =>
    Response.json({ totalTokens: 12 }),
  );
  await client.countTokens("private fixture input", {});
  expect(info).not.toHaveBeenCalled();
});

it("joins rejected POSTs to their safe provider request ID without leaking error echoes", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const client = new FreeModelProvider(env, async () =>
    Response.json(
      {
        error: {
          code: "invalid_request",
          message: `Private fixture input ${env.key}`,
        },
      },
      { status: 400, headers: { "x-request-id": "rejected-fixture-request" } },
    ),
  );
  await expect(
    client.generate("connection_probe", "Private fixture input", {}),
  ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_INVALID" });
  const submission = JSON.parse(String(info.mock.calls[0][1]));
  expect(JSON.parse(String(info.mock.calls[1][1]))).toEqual({
    wire_sha256: submission.wire_sha256,
    status: 400,
    request_id: "rejected-fixture-request",
  });
  const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
  expect(logs).not.toContain("Private fixture input");
  expect(logs).not.toContain(env.key);
});

it("omits unsafe model identifiers and credential-shaped echoed response IDs", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const client = new FreeModelProvider(
    { ...env, model: "untrusted model\nprivate fixture text" },
    async () =>
      Response.json(
        { id: env.key, status: "in_progress" },
        { headers: { "x-request-id": env.key } },
      ),
  );
  await client.startBackground("connection_probe", "fixture", {});
  expect(JSON.parse(String(info.mock.calls[0][1]))).not.toHaveProperty("model");
  expect(JSON.parse(String(info.mock.calls[1][1]))).toEqual({
    wire_sha256: JSON.parse(String(info.mock.calls[0][1])).wire_sha256,
    status: 200,
  });
  const logs = JSON.stringify(info.mock.calls);
  expect(logs).not.toContain(env.key);
  expect(logs).not.toContain("private fixture text");
});

it("does not change generation outcome when diagnostic logging fails", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {
    throw new Error("fixture logger unavailable");
  });
  const fetcher = vi.fn(async () => completed());
  const client = new FreeModelProvider(env, fetcher);
  await expect(
    client.generate("connection_probe", "fixture", {}),
  ).resolves.toMatchObject({ text: "{}", complete: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("starts the network request without waiting for payload hashing", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    await gate;
    return originalDigest(...args);
  });
  const fetcher = vi.fn(async () => completed());
  const client = new FreeModelProvider(env, fetcher);
  const result = client.generate("connection_probe", "fixture", {});
  try {
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await expect(result).resolves.toMatchObject({ text: "{}", complete: true });
});
