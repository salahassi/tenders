import { readFile } from "node:fs/promises";
import { expect, vi } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createApiHandler } from "../../supabase/functions/api/handler";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { AppError, databaseError } from "../../supabase/functions/_shared/http";
import { DOCX_MIME } from "../../supabase/functions/_shared/deliveryExport";
import type { FontData } from "../../../frontend/src/lib/renderDocx";

// Synthetic local transport only: real migrated SQL, API handlers and object
// receipts; local session tokens and Map storage do not establish hosted auth.
const env: BackendEnvironment = {
  url: "https://synthetic.supabase.co",
  publishableKey: "synthetic-public-key",
  serviceKey: "synthetic-service-key",
  allowedOrigins: ["https://app.example.test"],
  workerSecret: "synthetic-worker-secret",
  models: modelEnvironments(() => undefined),
};
export async function deliveryPipelineFixture() {
  const f = await workflowFixture();
  const fonts = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
  const identifier = (value: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(value))
      throw Error("Invalid test SQL identifier");
    return `"${value}"`;
  };
  async function sql(
    role: "authenticated" | "service_role",
    actor: string,
    query: string,
    args: unknown[] = [],
  ) {
    await f.db.exec("savepoint delivery_transport");
    try {
      await f.db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        actor,
      ]);
      await f.db.exec(`set local role ${role}`);
      return (await f.db.query<Record<string, any>>(query, args)).rows;
    } catch (error) {
      await f.db.exec("rollback to savepoint delivery_transport");
      throw databaseError(error as Error);
    } finally {
      await f.db.exec("reset role; release savepoint delivery_transport");
    }
  }
  function actorFor(token: string) {
    if (token !== "synthetic-owner")
      throw new AppError(401, "UNAUTHENTICATED", "Invalid synthetic session.");
    return f.owner;
  }
  async function rpc(
    name: string,
    args: Record<string, unknown> = {},
    token?: string,
  ) {
    const entries = Object.entries(args);
    const named = entries
      .map(([key], index) => `${identifier(key)} => $${index + 1}`)
      .join(",");
    const rows = await sql(
      token ? "authenticated" : "service_role",
      token ? actorFor(token) : "",
      `select public.${identifier(name)}(${named}) data`,
      entries.map(([, value]) =>
        value && typeof value === "object" ? JSON.stringify(value) : value,
      ),
    );
    return rows[0]?.data;
  }
  function transport() {
    const objects = new Map<string, Blob>();
    const state = { revokeOnRead: false };
    const backend = {
      authenticate: async (token: string) => ({ id: actorFor(token) }),
      membership: async (token: string) => {
        const [membership] = await sql(
          "authenticated",
          actorFor(token),
          "select * from public.current_membership()",
        );
        if (!membership)
          throw new AppError(
            403,
            "ACCESS_PENDING",
            "Membership is unavailable.",
          );
        return membership;
      },
      // Canonical SQL fixture; bounded raw HTTP streaming is qualified separately.
      batchStream: async (token: string, commands: unknown[], key: string) =>
        new Response(JSON.stringify(await rpc("app_batch", { commands, idempotency_key: key }, token))).body!,
      userRpc: (token: string, name: string, args: Record<string, unknown>) =>
        rpc(name, args, token),
      internal: vi.fn((name: string, args: Record<string, unknown> = {}) =>
        rpc(name, args),
      ),
      deliveryObject: vi.fn(async (key: string) => {
        const blob = objects.get(key) || null;
        if (state.revokeOnRead && blob) {
          state.revokeOnRead = false;
          await f.db.query(
            "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
            [f.w, f.owner],
          );
        }
        return blob;
      }),
      storeDeliveryObject: vi.fn(
        async (key: string, bytes: Uint8Array, mime: string) => {
          expect(mime).toBe(DOCX_MIME);
          if (objects.has(key))
            throw new Error("An immutable object must never be overwritten.");
          objects.set(key, new Blob([new Uint8Array(bytes)]));
        },
      ),
    };
    const handle = createApiHandler(env, () => backend as unknown as Backend);
    const request = (path: string, body?: unknown, key = crypto.randomUUID()) =>
      handle(
        new Request(`https://edge.example.test/functions/v1/api/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: env.allowedOrigins[0],
            authorization: "Bearer synthetic-owner",
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "idempotency-key": key,
                }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    return { backend, objects, state, request };
  }
  return { f, fonts, sql, rpc, transport };
}
export type DeliveryPipelineFixture = Awaited<
  ReturnType<typeof deliveryPipelineFixture>
>;
