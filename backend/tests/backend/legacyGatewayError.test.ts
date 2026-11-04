import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { AppError, databaseError } from "../../supabase/functions/_shared/http.ts";

// Exact legacy Backend.batch method body, retained from28689b9 before the
// bounded transport migration. The SDK and databaseError are the real pinned
// application implementations; only the HTTP transport is synthetic here.
class LegacyBatchAdapter {
  constructor(private readonly client: SupabaseClient) {}
  user(_token: string) { return this.client; }
  async batch(token: string, commands: unknown[], key: string) {
    const { data, error } = await this.user(token).rpc("app_batch", {
      commands,
      idempotency_key: key,
    });
    if (error) throw databaseError(error);
    return data;
  }
}

const config = readFileSync(new URL("../../deploy/kubernetes/gateway.conf", import.meta.url), "utf8");
const bodies = [...config.matchAll(/return 409 '([^']+)';/g)].map((match) => JSON.parse(match[1].replaceAll("$request_id", "a".repeat(32))));
const command = [{ operation: "opportunity.create", input: { title: "Synthetic unexecuted command" } }];
function adapter(body: unknown) {
  const sends: { pathname: string; body: unknown }[] = [];
  const client = createClient("http://synthetic.invalid", "synthetic-publishable-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      sends.push({ pathname: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } });
    } },
  });
  return { backend: new LegacyBatchAdapter(client), sends };
}

describe("legacy SDK consumption of the permanent gateway denial", () => {
  it("retains the actual nested-only SDK/databaseError TypeError reproduction", async () => {
    const historical = readFileSync(new URL("../../docs/evidence/legacy-batch-gateway-20261104.json", import.meta.url));
    expect(createHash("sha256").update(historical).digest("hex")).toBe("089b024a09e3306fe0fe95e7d5ef213469e57eaaff8ca09466723c7b34ca7711");
    const { backend, sends } = adapter({ error: bodies[0].error, request_id: "a".repeat(32) });
    await expect(backend.batch("synthetic-actor", command, "synthetic-key")).rejects.toBeInstanceOf(TypeError);
    expect(sends).toEqual([{ pathname: "/rest/v1/rpc/app_batch", body: { commands: command, idempotency_key: "synthetic-key" } }]);
  });
  it("every exact configured denial produces a typed nonretryable AppError without another send", async () => {
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body).toMatchObject({ code: "P0001", message: "TRANSPORT_UPGRADE_REQUIRED", details: null, hint: null,
        error: { code: "TRANSPORT_UPGRADE_REQUIRED", retryable: false, details: null } });
      const { backend, sends } = adapter(body);
      try { await backend.batch("synthetic-actor", command, "synthetic-key"); throw new Error("Expected denial"); }
      catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ status: 422, code: "TRANSPORT_UPGRADE_REQUIRED", retryable: false, details: null });
      }
      expect(sends).toEqual([{ pathname: "/rest/v1/rpc/app_batch", body: { commands: command, idempotency_key: "synthetic-key" } }]);
    }
  });
});
