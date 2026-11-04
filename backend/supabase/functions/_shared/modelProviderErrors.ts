/** Fixed labels only: provider messages may contain credentials or source text. */
export type ProviderFailureScope =
  "model" | "connection" | "project" | "account" | "unknown";
type Target = {
  provider: string;
  model: string;
  project_ref: string;
  connection_id?: string;
};

export function providerFailureAffects(
  source: Target,
  target: Target,
  scope: ProviderFailureScope,
) {
  if (source.provider !== target.provider) return false;
  if (scope === "model")
    return (
      source.model === target.model &&
      (source.connection_id
        ? source.connection_id === target.connection_id
        : source.project_ref === target.project_ref)
    );
  if (scope === "connection")
    return source.connection_id
      ? source.connection_id === target.connection_id
      : source.project_ref === target.project_ref;
  if (scope === "project")
    return (
      Boolean(source.project_ref) && source.project_ref === target.project_ref
    );
  // No account identifier is available in the current catalog. An account or
  // unscoped quota cannot safely be evaded through another project/connection.
  return true;
}

export function providerFailure(input: {
  status: number;
  method: string;
  reason?: string;
  code?: string;
  type?: string;
  error?: unknown;
  model: string;
  project: string;
}): { code: string; reason: string; scope: ProviderFailureScope } {
  const code = (input.code || "").toLowerCase(),
    type = (input.type || "").toLowerCase();
  const error =
    input.error && typeof input.error === "object"
      ? (input.error as Record<string, unknown>)
      : {};
  const quota =
    [
      "usage_limit",
      "insufficient_balance",
      "rate_limit",
      "concurrency_limit",
      "account_rate_restriction",
      "subscription_expired",
    ].includes(input.reason || "") ||
    /^(?:insufficient_quota|insufficient_balance|credit_balance_exhausted|(?:model|project|account)_quota_exceeded|(?:model|project|account)_rate_limit_exceeded|rate_limit_exceeded|resource_exhausted)$/.test(
      code,
    ) ||
    type === "resource_exhausted" ||
    input.status === 429;
  if (input.reason === "background_retrieval_failed")
    return {
      code: "PROVIDER_BACKGROUND_RETRIEVAL_FAILED",
      reason: input.reason,
      scope: "model",
    };
  // A genuine authentication response must not be downgraded by echoed text.
  if (input.status === 401)
    return {
      code: "PROVIDER_AUTH_FAILED",
      reason: "authentication_failed",
      scope: "connection",
    };
  if (
    input.status === 403 &&
    ([
      "invalid_api_key",
      "authentication_error",
      "invalid_authentication",
    ].includes(code) ||
      type === "authentication_error")
  )
    return {
      code: "PROVIDER_AUTH_FAILED",
      reason: "authentication_failed",
      scope: "connection",
    };
  if (
    input.status === 403 &&
    ["permission_denied", "access_denied", "forbidden"].includes(code)
  )
    return {
      code: "PROVIDER_REQUEST_REJECTED",
      reason: "permission_denied",
      scope: "connection",
    };
  if (quota) {
    let scope: ProviderFailureScope = "unknown";
    if (
      /^model_(?:quota|rate_limit)_exceeded$/.test(code) ||
      (error.quota_scope === "model" && error.model === input.model)
    )
      scope = "model";
    else if (
      Boolean(input.project) &&
      (/^project_(?:quota|rate_limit)_exceeded$/.test(code) ||
        (error.quota_scope === "project" && error.project === input.project))
    )
      scope = "project";
    else if (
      /^account_(?:quota|rate_limit)_exceeded$/.test(code) ||
      error.quota_scope === "account" ||
      ["insufficient_balance", "credit_balance_exhausted"].includes(code) ||
      input.reason === "insufficient_balance"
    )
      scope = "account";
    return {
      code: "PROVIDER_QUOTA_WAIT",
      reason:
        input.reason && input.reason !== "provider_rejected"
          ? input.reason
          : "usage_limit",
      scope,
    };
  }
  if (input.status === 403) {
    return {
      code: "PROVIDER_REQUEST_REJECTED",
      reason: "permission_denied",
      scope: "connection",
    };
  }
  return {
    code:
      input.status === 404
        ? input.method === "GET"
          ? "MODEL_RESULT_EXPIRED"
          : "PROVIDER_MODEL_NOT_FOUND"
        : [400, 422].includes(input.status)
          ? "PROVIDER_REQUEST_INVALID"
          : input.status >= 500
            ? "MODEL_NETWORK_UNCERTAIN"
            : "PROVIDER_REQUEST_REJECTED",
    reason: input.reason || "provider_rejected",
    scope: "model",
  };
}
