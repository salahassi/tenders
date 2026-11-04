// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { FreeModelProvider } from "../../supabase/functions/_shared/model";
import {
  providerFailure,
  providerFailureAffects,
} from "../../supabase/functions/_shared/modelProviderErrors";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const input = {
  status: 403,
  method: "POST",
  model: "model-a",
  project: "project-a",
};
it.each([
  [{ code: "insufficient_quota" }, "PROVIDER_QUOTA_WAIT", "unknown"],
  [{ code: "model_quota_exceeded" }, "PROVIDER_QUOTA_WAIT", "model"],
  [{ code: "project_quota_exceeded" }, "PROVIDER_QUOTA_WAIT", "project"],
  [
    { code: "project_quota_exceeded", project: "" },
    "PROVIDER_QUOTA_WAIT",
    "unknown",
  ],
  [{ code: "account_quota_exceeded" }, "PROVIDER_QUOTA_WAIT", "account"],
  [{ code: "credit_balance_exhausted" }, "PROVIDER_QUOTA_WAIT", "account"],
  [
    { status: 401, reason: "usage_limit" },
    "PROVIDER_AUTH_FAILED",
    "connection",
  ],
  [
    { code: "invalid_api_key", reason: "usage_limit" },
    "PROVIDER_AUTH_FAILED",
    "connection",
  ],
  [
    { code: "permission_denied", reason: "usage_limit" },
    "PROVIDER_REQUEST_REJECTED",
    "connection",
  ],
  [{ status: 403 }, "PROVIDER_REQUEST_REJECTED", "connection"],
  [{ status: 429 }, "PROVIDER_QUOTA_WAIT", "unknown"],
  [{ status: 500 }, "MODEL_NETWORK_UNCERTAIN", "model"],
  [{ status: 400 }, "PROVIDER_REQUEST_INVALID", "model"],
  [{ status: 404, method: "GET" }, "MODEL_RESULT_EXPIRED", "model"],
  [
    {
      reason: "usage_limit",
      error: { quota_scope: "model", model: "model-a" },
    },
    "PROVIDER_QUOTA_WAIT",
    "model",
  ],
  [
    { reason: "usage_limit", error: { quota_scope: "model", model: "other" } },
    "PROVIDER_QUOTA_WAIT",
    "unknown",
  ],
])("normalizes safe reason and proven scope %j", (override, code, scope) => {
  expect(providerFailure({ ...input, ...override })).toMatchObject({
    code,
    scope,
  });
});
it("shares unknown/account scope, isolates proven model/project/connection scope", () => {
  const a = {
    provider: "qwencloud",
    model: "model-a",
    project_ref: "p",
    connection_id: "a",
  };
  const same = { ...a, model: "model-b" },
    otherProject = { ...same, connection_id: "b", project_ref: "q" };
  expect(providerFailureAffects(a, same, "model")).toBe(false);
  expect(providerFailureAffects(a, same, "connection")).toBe(true);
  expect(providerFailureAffects(a, otherProject, "project")).toBe(false);
  for (const scope of ["unknown", "account"] as const)
    expect(providerFailureAffects(a, otherProject, scope)).toBe(true);
  expect(
    providerFailureAffects(a, { ...same, provider: "openai" }, "account"),
  ).toBe(false);
});
it.each(["90", "Wed, 04 Nov 2026 12:01:30 GMT"])(
  "classifies real adapter 403 quota without echoing provider text; Retry-After %s",
  async (retry) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new FreeModelProvider(
      {
        provider: "qwencloud",
        model: "model-a",
        projectRef: "p",
        key: "secret-fixture-key",
      },
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "insufficient_quota",
              message:
                "Free quota exhausted. secret-fixture-key private fixture text",
              quota_scope: "model",
              model: "model-a",
            },
          }),
          { status: 403, headers: { "retry-after": retry } },
        ),
    );
    await expect(
      provider.generate("analyze_chunk", "JSON", {}),
    ).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_WAIT",
      retryAfter: "2026-11-04T12:01:30.000Z",
    });
    expect(provider.telemetry).toMatchObject({
      http_status: 403,
      provider_error_code: "insufficient_quota",
      provider_error_reason: "usage_limit",
      provider_error_scope: "model",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /secret-fixture-key|private fixture text/,
    );
  },
);
