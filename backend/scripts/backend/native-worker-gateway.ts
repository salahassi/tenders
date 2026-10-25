export type NativeGateway = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<any>;

/** Fail closed before selecting any credential or making an outbound request. */
export function nativeGatewayConfiguration(
  get: (key: string) => string | undefined,
) {
  const nativeSecret = get("APP_NATIVE_WORKER_SECRET") || "";
  const address = get(
    nativeSecret ? "APP_NATIVE_WORKER_URL" : "APP_BROWSER_GATEWAY_URL",
  );
  if (!address) throw Error("Native worker gateway URL is not configured");
  const url = new URL(address);
  const internal =
    /^(?:source-browser(?:\.[a-z0-9-]+\.svc(?:\.cluster\.local)?)?|localhost|127\.0\.0\.1)$/.test(
      url.hostname,
    );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (nativeSecret && !internal) ||
    url.pathname !== "/functions/v1/source-browser" ||
    (url.protocol !== "https:" &&
      !(nativeSecret && internal && url.protocol === "http:")) ||
    (nativeSecret && (nativeSecret.length < 32 || nativeSecret.length > 512))
  )
    throw Error("Native worker gateway configuration is invalid");
  return {
    url: url.href,
    nativeSecret,
    audience: get("APP_BROWSER_OIDC_AUDIENCE") || "tenderdesk-source-browser",
  };
}

export function actionsGateway(
  get: (key: string) => string | undefined = (key) => process.env[key],
  fetcher: typeof fetch = fetch,
): NativeGateway {
  const configuration = nativeGatewayConfiguration(get);
  let cached: { value: string; expires: number } | undefined;
  const identity = async () => {
    if (cached && cached.expires > Date.now() / 1000 + 60) return cached.value;
    const requestUrl = get("ACTIONS_ID_TOKEN_REQUEST_URL");
    const requestToken = get("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    if (!requestUrl || !requestToken)
      throw Error("GitHub Actions id-token: write is required");
    const url = new URL(requestUrl);
    url.searchParams.set("audience", configuration.audience);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("GitHub Actions identity is unavailable");
    const body = await response.json();
    if (typeof body.value !== "string") throw Error("Invalid Actions identity");
    cached = {
      value: body.value,
      expires: JSON.parse(
        Buffer.from(body.value.split(".")[1], "base64url").toString(),
      ).exp,
    };
    return cached.value;
  };
  return async (action, payload) => {
    const credentials: Record<string, string> = configuration.nativeSecret
      ? { "x-native-worker-secret": configuration.nativeSecret }
      : { Authorization: `Bearer ${await identity()}` };
    const response = await fetcher(configuration.url, {
      method: "POST",
      headers: { ...credentials, "Content-Type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw Error(
        `Native worker queue request failed: HTTP ${response.status}`,
      );
    return (await response.json()).data;
  };
}
