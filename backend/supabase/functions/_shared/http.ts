export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown = null,
    public retryable = false,
  ) {
    super(message);
  }
}
export async function readJson(
  request: Request,
  limit = 1048576,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new AppError(400, "CONTENT_TYPE_REQUIRED", "Use application/json.");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The request exceeds the allowed size.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "INVALID_JSON", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError(
          413,
          "PAYLOAD_TOO_LARGE",
          "The request exceeds the allowed size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(
      400,
      "INVALID_JSON",
      "The request body is not valid UTF-8 JSON.",
    );
  }
}
export function corsHeaders(
  request: Request,
  allowedOrigins: string[],
): Headers {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.includes(origin))
    throw new AppError(403, "ORIGIN_FORBIDDEN", "This origin is not allowed.");
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
  });
  if (origin) headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization,apikey,content-type,idempotency-key",
  );
  return headers;
}
export function databaseError(error: {
  message: string;
  details?: string;
  code?: string;
}): AppError {
  const code =
    error.message.match(/^[A-Z_]+$/)?.[0] || "DATABASE_COMMAND_FAILED";
  const status =
    code === "UNAUTHENTICATED"
      ? 401
      : code === "ACCESS_PENDING" ||
          code === "ROLE_FORBIDDEN" ||
          code === "WORKSPACE_MISMATCH"
        ? 403
        : code === "NOT_FOUND"
          ? 404
          : /CONFLICT|STALE_|ALREADY|INVALID_TRANSITION/.test(code)
            ? 409
            : /CAP_REACHED/.test(code)
              ? 429
              : /NOT_IMPLEMENTED|NOT_CONNECTED|CONFIGURED|PROVISIONING_REQUIRED/.test(
                    code,
                  )
                ? 503
                : code === "PAYLOAD_TOO_LARGE"
                  ? 413
                  : 422;
  let details: unknown = null;
  try {
    details = JSON.parse(error.details || "null");
  } catch {
    /* Never echo raw SQL or backend diagnostics. */
  }
  return new AppError(
    status,
    code,
    code === "DATABASE_COMMAND_FAILED"
      ? "The database command could not be completed."
      : code.toLowerCase().replaceAll("_", " "),
    details,
    status === 503,
  );
}
export async function secretMatches(
  supplied: string,
  expected: string,
): Promise<boolean> {
  if (!expected || !supplied) return false;
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
