const issuer = "https://token.actions.githubusercontent.com";
export const browserAudience =
  "https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/source-browser";
const workflow =
  "salahassi/tenders/.github/workflows/collect-browser-sources.yml@refs/heads/main";
let cached: { until: number; keys: JsonWebKey[] } | undefined;
function bytes(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
const json = (value: string) =>
  JSON.parse(new TextDecoder().decode(bytes(value)));
export async function verifyBrowserIdentity(
  token: string,
  fetcher: typeof fetch = fetch,
  now = Date.now() / 1000,
) {
  try {
    if (token.length > 16384) return false;
    const [headerPart, bodyPart, signature, extra] = token.split(".");
    if (!headerPart || !bodyPart || !signature || extra) return false;
    const header = json(headerPart),
      claims = json(bodyPart);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.iss !== issuer ||
      claims.aud !== browserAudience ||
      claims.sub !== "repo:salahassi/tenders:ref:refs/heads/main" ||
      claims.workflow_ref !== workflow ||
      claims.repository !== "salahassi/tenders" ||
      claims.ref !== "refs/heads/main" ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.exp <= now ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 900 ||
      (claims.nbf && claims.nbf > now + 30)
    )
      return false;
    let keys =
      fetcher === fetch && cached && cached.until > now
        ? cached.keys
        : undefined;
    if (!keys) {
      const response = await fetcher(issuer + "/.well-known/jwks", {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return false;
      keys = (await response.json()).keys;
      if (!Array.isArray(keys)) return false;
      if (fetcher === fetch) cached = { until: now + 600, keys };
    }
    const key = keys.find(
      (key: JsonWebKey & { kid?: string }) =>
        key.kid === header.kid && key.kty === "RSA",
    );
    if (!key) return false;
    const imported = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      imported,
      bytes(signature),
      new TextEncoder().encode(headerPart + "." + bodyPart),
    );
  } catch {
    return false;
  }
}
const encoded = (value: Uint8Array) => {
  let s = "";
  for (const b of value) s += String.fromCharCode(b);
  return btoa(s);
};
async function sessionKey(secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("tenderdesk-browser-session-v2\0" + secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function sealSession(
  state: unknown,
  secret: string,
  scope: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) },
      await sessionKey(secret),
      new TextEncoder().encode(JSON.stringify(state)),
    ),
  );
  const all = new Uint8Array(iv.length + ciphertext.length);
  all.set(iv);
  all.set(ciphertext, iv.length);
  return encoded(all);
}
export async function openSession(
  sealed: string,
  secret: string,
  scope: string,
) {
  try {
    const all = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: all.slice(0, 12),
        additionalData: new TextEncoder().encode(scope),
      },
      await sessionKey(secret),
      all.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
}
