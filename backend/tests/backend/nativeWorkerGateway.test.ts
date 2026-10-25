// @vitest-environment node
import { expect, it } from "vitest";
import {
  actionsGateway,
  nativeGatewayConfiguration,
} from "../../scripts/backend/native-worker-gateway.ts";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway.ts";
import { environment } from "../../supabase/functions/_shared/backend.ts";

const secret = "automated-fixture-native-secret-123456789";
const values = {
  APP_NATIVE_WORKER_SECRET: secret,
  APP_NATIVE_WORKER_URL:
    "http://source-browser:8080/functions/v1/source-browser",
};
const get = (entries: Record<string, string>) => (key: string) => entries[key];

it("requires explicit gateway configuration and limits shared-secret delivery to internal service DNS", () => {
  expect(() => nativeGatewayConfiguration(get({}))).toThrow("not configured");
  for (const url of [
    "http://example.test/functions/v1/source-browser",
    "https://example.test/functions/v1/source-browser",
    "http://source-browser.attacker/functions/v1/source-browser",
    "http://source-browser:8080/functions/v1/api",
    "http://source-browser:8080/functions/v1/source-browser?leak=1",
    "http://user:password@source-browser:8080/functions/v1/source-browser",
  ])
    expect(() =>
      nativeGatewayConfiguration(
        get({ ...values, APP_NATIVE_WORKER_URL: url }),
      ),
    ).toThrow("invalid");
  expect(nativeGatewayConfiguration(get(values)).url).toBe(
    values.APP_NATIVE_WORKER_URL,
  );
  expect(
    nativeGatewayConfiguration(
      get({
        ...values,
        APP_NATIVE_WORKER_URL:
          "http://source-browser.tenderdesk.svc.cluster.local:8080/functions/v1/source-browser",
      }),
    ).nativeSecret,
  ).toBe(secret);
  expect(() =>
    nativeGatewayConfiguration(
      get({ ...values, APP_NATIVE_WORKER_SECRET: "short" }),
    ),
  ).toThrow("invalid");
});

it("delivers only the dedicated native credential, forbids redirects, and never requests GitHub identity", async () => {
  const calls: { address: string; options: RequestInit }[] = [];
  const gateway = actionsGateway(get(values), (async (input, options) => {
    calls.push({ address: String(input), options: options! });
    return Response.json({ data: { id: "fixture-request" } });
  }) as typeof fetch);
  expect(await gateway("ocr_claim", {})).toEqual({ id: "fixture-request" });
  expect(calls).toHaveLength(1);
  expect(calls[0].address).toBe(values.APP_NATIVE_WORKER_URL);
  expect(
    new Headers(calls[0].options.headers).get("x-native-worker-secret"),
  ).toBe(secret);
  expect(new Headers(calls[0].options.headers).has("authorization")).toBe(
    false,
  );
  expect(calls[0].options.redirect).toBe("error");
});

it("rejects absent, short, wrong and service credentials before privileged RPCs and retains action validation", async () => {
  let calls = 0;
  const env = environment(
    get({
      APP_NATIVE_WORKER_SECRET: secret,
      SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key",
    }),
  );
  const handler = createBrowserGateway(
    env,
    () =>
      ({
        internal: async (action: string) => {
          calls++;
          return { action };
        },
      }) as any,
    (async () => {
      throw Error("OIDC must not be contacted in native mode");
    }) as typeof fetch,
  );
  const request = (credential: string, action = "claim") =>
    new Request("http://source-browser:8080/functions/v1/source-browser", {
      method: "POST",
      headers: {
        "x-native-worker-secret": credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, payload: {} }),
    });
  for (const credential of [
    "",
    "wrong",
    "fixture-service-key",
    "x".repeat(513),
  ])
    expect((await handler(request(credential))).status).toBe(401);
  expect(calls).toBe(0);
  expect((await handler(request(secret, "execute_sql"))).status).toBe(400);
  expect(calls).toBe(0);
  const accepted = await handler(request(secret, "ocr_claim"));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({
    data: { action: "claim_notice_ocr" },
  });
  expect(calls).toBe(1);
  const misconfigured = createBrowserGateway(
    { ...env, nativeWorkerSecret: "short" },
    () => {
      throw Error("unauthorized");
    },
  );
  expect((await misconfigured(request("short"))).status).toBe(401);
});

it("keeps explicit HTTPS GitHub Actions transport separate from Kubernetes mode", () => {
  expect(
    nativeGatewayConfiguration(
      get({
        APP_BROWSER_GATEWAY_URL:
          "https://new.example.test/functions/v1/source-browser",
        APP_BROWSER_OIDC_AUDIENCE: "fixture-migrated-audience",
      }),
    ),
  ).toEqual({
    url: "https://new.example.test/functions/v1/source-browser",
    nativeSecret: "",
    audience: "fixture-migrated-audience",
  });
  expect(() =>
    nativeGatewayConfiguration(
      get({
        APP_BROWSER_GATEWAY_URL: "http://localhost/functions/v1/source-browser",
      }),
    ),
  ).toThrow("invalid");
});
