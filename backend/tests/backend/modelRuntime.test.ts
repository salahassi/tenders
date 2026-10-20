import { describe, expect, it, vi } from "vitest";
import {
  disableExternalModelTracing,
  verificationContext,
} from "../../supabase/functions/_shared/modelGraph";

describe("read-only Edge runtime environment", () => {
  it("does not assign absent or disabled tracing flags", () => {
    const env = new Proxy(
      { LANGSMITH_TRACING: "false" },
      {
        set() {
          throw new Error("Deno.env.set is not supported");
        },
      },
    );
    expect(() => disableExternalModelTracing(env)).not.toThrow();
  });

  it("fails closed if inherited tracing cannot be disabled", () => {
    const env = new Proxy(
      { LANGSMITH_TRACING: "true" },
      {
        set() {
          throw new Error("Do not expose platform diagnostics");
        },
      },
    );
    expect(() => disableExternalModelTracing(env)).toThrow(
      "MODEL_TRACING_CONFIGURATION_UNSAFE",
    );
  });
});

it("keeps accepted verification input unchanged and pins compact requests across later polls", async () => {
  const original = {
    candidate_hash: "a".repeat(64),
    candidate: { text: "All assertions" },
    candidate_text: "All assertions",
    content_units: [{ id: "content-0", text: "All assertions" }],
    original_context: { scope: "fixture" },
  };
  let saved: any = null;
  const action = vi.fn(async (op, payload) =>
    op === "result_put" ? (saved = { value: payload.value }) : saved,
  );
  const pending = {
    preflight: vi.fn(async () => ({
      pending_model_config_id: "accepted-model",
    })),
  } as any;
  expect(
    await verificationContext({ action } as any, pending, original, []),
  ).toEqual(original);
  expect(saved).toBeNull();
  const fresh = { preflight: vi.fn(async () => ({ providers: [] })) } as any;
  const compact = await verificationContext(
    { action } as any,
    fresh,
    original,
    [],
  );
  expect(compact).toEqual({
    candidate_hash: original.candidate_hash,
    content_units: original.content_units,
    original_context: original.original_context,
    response_style: "compact-verification-v2",
  });
  const later = { preflight: vi.fn() } as any;
  expect(
    await verificationContext({ action } as any, later, original, []),
  ).toEqual(compact);
  expect(later.preflight).not.toHaveBeenCalled();
});
