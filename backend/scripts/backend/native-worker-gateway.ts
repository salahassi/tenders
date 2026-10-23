export type NativeGateway = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<any>;

export function actionsGateway(): NativeGateway {
  const audience =
    "https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/source-browser";
  let cached: { value: string; expires: number } | undefined;
  const identity = async () => {
    if (cached && cached.expires > Date.now() / 1000 + 60) return cached.value;
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken)
      throw Error("GitHub Actions id-token: write is required");
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
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
    const token = await identity();
    const response = await fetch(audience, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        const claims = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString(),
        );
        const fields = [
          "iss",
          "aud",
          "sub",
          "repository",
          "ref",
          "workflow_ref",
          "iat",
          "exp",
          "nbf",
        ];
        console.error(
          "Native worker identity rejected",
          JSON.stringify(
            Object.fromEntries(fields.map((key) => [key, claims[key]])),
          ),
        );
      }
      throw Error(
        `Native worker queue request failed: HTTP ${response.status}`,
      );
    }
    return (await response.json()).data;
  };
}
