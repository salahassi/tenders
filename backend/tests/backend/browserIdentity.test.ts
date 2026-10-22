// @vitest-environment node
import { it, expect } from "vitest";
import {
  verifyBrowserIdentity,
  browserAudience,
} from "../../supabase/functions/_shared/browserIdentity";
import { createBrowserGateway } from "../../supabase/functions/_shared/browserGateway";
const base = {
  iss: "https://token.actions.githubusercontent.com",
  aud: browserAudience,
  sub: "repo:salahassi/tenders:ref:refs/heads/main",
  repository: "salahassi/tenders",
  ref: "refs/heads/main",
  workflow_ref:
    "salahassi/tenders/.github/workflows/collect-browser-sources.yml@refs/heads/main",
};
async function identity(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const value =
    encode({ alg: "RS256", kid: "synthetic" }) +
    "." +
    encode({ ...base, iat: now, exp: now + 300, ...overrides });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(value),
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    token: value + "." + Buffer.from(signature).toString("base64url"),
    fetcher: (async () =>
      Response.json({ keys: [{ ...jwk, kid: "synthetic" }] })) as typeof fetch,
  };
}
it("accepts only signed short-lived identities for the exact repository/main/browser workflow", async () => {
  const valid = await identity();
  expect(await verifyBrowserIdentity(valid.token, valid.fetcher)).toBe(true);
  const immutable = await identity({
    sub: "repo:salahassi@1439837/tenders@1418689096:ref:refs/heads/main",
  });
  expect(await verifyBrowserIdentity(immutable.token, immutable.fetcher)).toBe(
    true,
  );
  for (const change of [
    { sub: "repo:salahassi@1/tenders@2:ref:refs/heads/main" },
    { repository: "attacker/tenders" },
    { ref: "refs/heads/other" },
    { aud: "other" },
    {
      workflow_ref:
        "salahassi/tenders/.github/workflows/other.yml@refs/heads/main",
    },
    { exp: 1 },
  ]) {
    const invalid = await identity(change);
    expect(await verifyBrowserIdentity(invalid.token, invalid.fetcher)).toBe(
      false,
    );
  }
  expect(
    await verifyBrowserIdentity(
      valid.token.slice(0, -4) + "AAAA",
      valid.fetcher,
    ),
  ).toBe(false);
});
it("rejects unauthenticated browser workers before any privileged operation and restricts the RPC allowlist", async () => {
  const valid = await identity();
  let calls = 0;
  const handler = createBrowserGateway(
    {} as any,
    () =>
      ({
        internal: async () => {
          calls++;
          return null;
        },
      }) as any,
    valid.fetcher,
  );
  expect(
    (
      await handler(
        new Request("https://synthetic.test", { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(401);
  expect(calls).toBe(0);
  const response = await handler(
    new Request("https://synthetic.test", {
      method: "POST",
      headers: {
        authorization: "Bearer " + valid.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "execute_sql",
        payload: { query: "select secret" },
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(calls).toBe(0);
  const claim = await handler(
    new Request("https://synthetic.test", {
      method: "POST",
      headers: {
        authorization: "Bearer " + valid.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "claim", payload: {} }),
    }),
  );
  expect(claim.status).toBe(200);
  expect(calls).toBe(1);
});
