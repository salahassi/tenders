// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { createApiHandler } from "../../supabase/functions/api/handler";
import type {
  Backend,
  BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import {
  environment,
  modelEnvironments,
} from "../../supabase/functions/_shared/backend";
import {
  AppError,
  readJson,
  secretMatches,
} from "../../supabase/functions/_shared/http";
import { validateOriginal } from "../../supabase/functions/_shared/originals";
import { commandSchemas } from "../../supabase/functions/_shared/contracts";
const actor = "00000000-0000-4000-8000-000000000001",
  source = "00000000-0000-4000-8000-000000000002";
const env: BackendEnvironment = {
  url: "https://example.supabase.co",
  publishableKey: "synthetic-public-key",
  serviceKey: "synthetic-server-test-value",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic-worker-secret",
  models: modelEnvironments(() => undefined),
};
function fixture() {
  const backend = {
    authenticate: vi.fn(async () => ({ id: actor })),
    membership: vi.fn(async () => ({ workspace_id: source, role: "Owner" })),
    operations: vi.fn(async () => ({ last_heartbeat_at: null })),
    command: vi.fn(async () => ({ id: source, revision: 1 })),
    list: vi.fn(async () => ({ records: [], next_cursor: null })),
    one: vi.fn(),
    download: vi.fn(),
    object: vi.fn(),
    verifyPages: vi.fn(),
    extraction: vi.fn(),
    accept: vi.fn(async () => ({ id: source, revision: 2 })),
  };
  const factory = vi.fn(() => backend as unknown as Backend);
  return { backend, factory, handle: createApiHandler(env, factory) };
}
function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: env.allowedOrigins[0],
      authorization: "Bearer synthetic-user-token",
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": "synthetic-request-1",
          }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
describe("backend HTTP boundaries without a live provider", () => {
  it("batches operational history while keeping bounded authenticated pagination", async () => {
    const f = fixture();
    for (const resource of ["jobs", "audit-events"]) {
      expect(
        (await f.handle(request(`${resource}?limit=500&cursor=${source}`)))
          .status,
      ).toBe(200);
      expect(f.backend.list).toHaveBeenLastCalledWith(
        "synthetic-user-token",
        resource.replaceAll("-", "_"),
        {},
        500,
        source,
      );
      expect((await f.handle(request(`${resource}?limit=501`))).status).toBe(
        400,
      );
    }
    expect((await f.handle(request("documents?limit=500"))).status).toBe(400);
  });
  it("reads provider and legacy secret metadata for the Owner without returning secret values", async () => {
    const f = fixture();
    const secrets: Record<string, string> = {
      APP_MODEL_PROVIDER: "gemini_free",
      APP_MODEL_NAME: "legacy-model",
      APP_MODEL_PROJECT: "legacy-project",
      APP_MODEL_KEY: "synthetic-legacy-key-never-return",
      APP_MODEL_GEMINI_NAME: "gemini-3.8-flash",
      APP_MODEL_GROQ_KEY: "synthetic-other-key-never-return",
      APP_MODEL_OPENAI_KEY: "synthetic-openai-key-never-return",
      APP_MODEL_OPENAI_NAME: "owner-openai-model",
      APP_MODEL_CLAUDE_KEY: "synthetic-claude-key-never-return",
      APP_MODEL_CLAUDE_NAME: "owner-claude-model",
      APP_MODEL_ZAI_KEY: "synthetic-zai-key-never-return",
      APP_MODEL_ZAI_NAME: "owner-selected-model",
      APP_MODEL_ZAI_PROJECT: "synthetic-account",
    };
    const handle = createApiHandler(
      { ...env, models: modelEnvironments((name) => secrets[name]) },
      f.factory,
    );
    const response = await handle(request("model-environment"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.providers).toHaveLength(8);
    expect(body.data.providers[0]).toEqual({
      provider: "gemini_free",
      model: "gemini-3.8-flash",
      project_ref: "legacy-project",
      key_configured: true,
    });
    expect(body.data.providers[1]).toEqual({
      provider: "qwen_free",
      model: "",
      project_ref: "",
      key_configured: false,
    });
    expect(JSON.stringify(body)).not.toContain(secrets.APP_MODEL_KEY);
    expect(JSON.stringify(body)).not.toContain(secrets.APP_MODEL_GROQ_KEY);
    expect(
      body.data.providers.find((p: any) => p.provider === "zai_free"),
    ).toEqual({
      provider: "zai_free",
      model: "owner-selected-model",
      project_ref: "synthetic-account",
      key_configured: true,
    });
    expect(JSON.stringify(body)).not.toContain(secrets.APP_MODEL_ZAI_KEY);
    for (const [provider, model, key] of [
      ["openai", "owner-openai-model", secrets.APP_MODEL_OPENAI_KEY],
      ["anthropic", "owner-claude-model", secrets.APP_MODEL_CLAUDE_KEY],
    ]) {
      expect(
        body.data.providers.find((p: any) => p.provider === provider),
      ).toEqual({
        provider,
        model,
        project_ref: "default",
        key_configured: true,
      });
      expect(JSON.stringify(body)).not.toContain(key);
    }
    expect(JSON.stringify(body)).not.toContain(env.serviceKey);
    expect(f.backend.command).not.toHaveBeenCalled();
  });
  it("denies model setup metadata to anonymous users and non-Owners", async () => {
    const f = fixture();
    expect(
      (
        await f.handle(
          request("model-environment", undefined, { authorization: "" }),
        )
      ).status,
    ).toBe(401);
    f.backend.authenticate.mockRejectedValueOnce(
      new AppError(401, "UNAUTHENTICATED", "Invalid token."),
    );
    expect((await f.handle(request("model-environment"))).status).toBe(401);
    for (const role of ["Editor", "Reviewer"]) {
      f.backend.membership.mockResolvedValueOnce({
        workspace_id: source,
        role,
      });
      const response = await f.handle(request("model-environment"));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("OWNER_REQUIRED");
    }
  });
  it("reads current platform key maps and supports existing legacy deployments", () => {
    const values: Record<string, string> = {
      SUPABASE_URL: env.url,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
        default: "synthetic-new-public",
      }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "synthetic-new-secret" }),
      SUPABASE_ANON_KEY: "synthetic-old-public",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-old-secret",
    };
    const configured = environment((name) => values[name]);
    expect(configured.publishableKey).toBe("synthetic-new-public");
    expect(configured.serviceKey).toBe("synthetic-new-secret");
    values.SUPABASE_SECRET_KEYS = "malformed";
    expect(environment((name) => values[name]).serviceKey).toBe(
      "synthetic-old-secret",
    );
  });
  it("validates an uploaded original and passes the completion idempotency key to SQL", async () => {
    const f = fixture();
    const original = new Blob(["Synthetic upload"]);
    f.backend.one.mockResolvedValue({
      id: source,
      created_by: actor,
      expected_size: original.size,
      storage_key: "synthetic-workspace/synthetic-original",
      original_name: "answer.txt",
      mime_type: "text/plain",
    });
    f.backend.object.mockResolvedValue(original);
    const response = await f.handle(
      request(`documents/${source}/complete-upload`, {
        status: "ready",
        extracted_text: "Synthetic upload",
      }),
    );
    expect(response.status).toBe(200);
    expect(f.backend.accept).toHaveBeenCalledWith(
      source,
      actor,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      original.size,
      "Synthetic upload",
      "ready",
      "synthetic-request-1",
    );
  });
  it("serves minimal public health without opening privileged dependencies", async () => {
    const { handle, factory } = fixture();
    const response = await handle(
      new Request("https://edge.example.test/api/v1/health"),
    );
    expect(response.status).toBe(200);
    expect(factory).not.toHaveBeenCalled();
    expect((await response.json()).data).toEqual({ status: "available" });
  });
  it("rejects absent or invalid user authentication before membership commands", async () => {
    const f = fixture();
    expect(
      (await f.handle(request("sources", undefined, { authorization: "" })))
        .status,
    ).toBe(401);
    expect(f.backend.authenticate).not.toHaveBeenCalled();
    f.backend.authenticate.mockRejectedValueOnce(
      new AppError(401, "UNAUTHENTICATED", "Invalid user token."),
    );
    expect((await f.handle(request("sources"))).status).toBe(401);
    expect(f.backend.membership).not.toHaveBeenCalled();
  });
  it("rejects unauthorized origins and allows preflight for scoped review saves", async () => {
    const { handle, factory } = fixture();
    expect(
      (
        await handle(
          request("sources", undefined, {
            origin: "https://untrusted.example.test",
          }),
        )
      ).status,
    ).toBe(403);
    expect(factory).not.toHaveBeenCalled();
    const preflight = await handle(
      new Request(
        "https://edge.example.test/api/v1/proposals/x/review-inputs",
        { method: "OPTIONS", headers: { origin: env.allowedOrigins[0] } },
      ),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );
  });
  it("rejects arbitrary command fields, requires idempotency and ignores no supplied role", async () => {
    const f = fixture();
    expect(
      (
        await f.handle(
          request("sources", { name: "Manual", kind: "manual", role: "Owner" }),
        )
      ).status,
    ).toBe(400);
    expect(f.backend.command).not.toHaveBeenCalled();
    expect(
      (
        await f.handle(
          request(
            "sources",
            { name: "Manual", kind: "manual" },
            { "idempotency-key": "" },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.handle(request("sources", { name: "Manual", kind: "manual" })))
        .status,
    ).toBe(201);
    expect(f.backend.command).toHaveBeenCalledWith(
      "synthetic-user-token",
      "source.create",
      expect.objectContaining({ name: "Manual", kind: "manual" }),
      "synthetic-request-1",
    );
  });
  it("does not claim model execution in connected bootstrap", async () => {
    const { handle } = fixture();
    const response = await handle(request("bootstrap"));
    expect((await response.json()).data.model).toEqual({
      enabled: false,
      blocker: "MODEL_NOT_CONFIGURED",
    });
  });
  it("preserves separate section/question inputs and empty text in a file-only response", async () => {
    const { handle, backend } = fixture();
    const base = {
      base_version_id: source,
      source_signature: "synthetic",
      expected_revision: 2,
      inputs: [
        { target_kind: "section", target_id: "scope", body: "عدّل النطاق" },
        { target_kind: "section", target_id: "terms", body: "Update validity" },
        { target_kind: "question", target_id: actor, body: "" },
      ],
    };
    const response = await handle(
      new Request(
        `https://edge.example.test/api/v1/proposals/${actor}/review-inputs`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer synthetic-user-token",
            "content-type": "application/json",
            "idempotency-key": "review-batch",
          },
          body: JSON.stringify(base),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(backend.command).toHaveBeenCalledWith(
      "synthetic-user-token",
      "review.save",
      { ...base, id: actor },
      "review-batch",
    );
  });
  it("bounds streamed request bytes independently of Content-Length", async () => {
    const req = new Request("https://edge.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(100) }),
    });
    await expect(readJson(req, 64)).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
  it("does not leak server errors, SQL or secret values", async () => {
    const f = fixture();
    f.backend.command.mockRejectedValueOnce(
      new Error(`SQL diagnostics ${env.serviceKey}`),
    );
    const response = await f.handle(
      request("sources", { name: "Manual", kind: "manual" }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(env.serviceKey);
  });
  it("checks fixed scheduler credentials without accepting publishable keys", async () => {
    expect(await secretMatches("", env.workerSecret)).toBe(false);
    expect(await secretMatches(env.publishableKey, env.workerSecret)).toBe(
      false,
    );
    expect(await secretMatches(env.workerSecret, env.workerSecret)).toBe(true);
  });
  it("rejects file signature mismatches and private URL shortcuts", () => {
    expect(() =>
      validateOriginal(
        "fake.pdf",
        "application/pdf",
        new TextEncoder().encode("not a PDF"),
      ),
    ).toThrow("PDF signature");
    expect(() =>
      validateOriginal(
        "bad.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        new Uint8Array([80, 75, 3, 4]),
      ),
    ).toThrow("expected Office");
    for (const url of [
      "http://example.test",
      "https://127.0.0.1",
      "https://localhost",
      "https://[::1]",
      "https://user:password@example.test",
    ])
      expect(
        commandSchemas["source.create"].safeParse({
          name: "Invalid",
          kind: "rss",
          url,
        }).success,
      ).toBe(false);
  });
});

it("validates model log filters and a descending numeric cursor before querying tenant-scoped records", async () => {
  const f = fixture();
  const response = await f.handle(
    request(
      `model-activity?provider=zai_free&status=failed&opportunity=${source}&cursor=123&limit=25`,
    ),
  );
  expect(response.status).toBe(200);
  expect(f.backend.list).toHaveBeenCalledWith(
    "synthetic-user-token",
    "model_activity",
    { provider: "zai_free", status: "failed", opportunity_id: source },
    25,
    "123",
  );
  for (const query of [
    "cursor=abc",
    "provider=arbitrary",
    "status=anything",
    "opportunity=bad",
  ]) {
    const calls = f.backend.list.mock.calls.length;
    expect((await f.handle(request("model-activity?" + query))).status).toBe(
      400,
    );
    expect(f.backend.list).toHaveBeenCalledTimes(calls);
  }
});
