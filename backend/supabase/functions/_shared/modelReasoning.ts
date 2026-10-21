import type { ExecutionProfile, ModelCapabilities } from "./modelContract.ts";

export const geminiReasoningTransport = (background: boolean) =>
  background ? "interactions:v1beta:2026-05-20" : "generate_content:v1beta";

/** Negotiate an optional provider field, never infer support from a model name.
 * An explicit provider-default profile remains provider default. In particular,
 * minimal is not silently rewritten to a different user-requested level.
 */
export function geminiReasoningConfiguration(
  capabilities: ModelCapabilities,
  requested: ExecutionProfile,
  allowed: boolean,
) {
  if (!allowed || requested.reasoning === "none")
    return {
      capabilities: {
        ...capabilities,
        reasoning: "none" as const,
        reasoning_values: [],
      },
      profile: { ...requested, reasoning: "none" as const },
    };
  if (["low", "medium", "high"].includes(requested.reasoning))
    return {
      capabilities: {
        ...capabilities,
        reasoning: "gemini_level" as const,
        reasoning_values: [requested.reasoning],
      },
      profile: requested,
    };
  return null;
}

/** Only an explicit rejection of the exact optional field/value sent permits
 * another generation. Generic 400s, schema errors and ambiguous sends do not.
 */
export function rejectedGeminiReasoning(o: {
  provider: string;
  phase?: string;
  status: number;
  sentLevel?: string;
  error: unknown;
}) {
  if (
    o.provider !== "gemini_free" ||
    o.phase !== "generation" ||
    ![400, 422].includes(o.status) ||
    !["minimal", "low", "medium", "high"].includes(
      o.sentLevel?.toLowerCase() ?? "",
    ) ||
    !o.error ||
    typeof o.error !== "object" ||
    Array.isArray(o.error)
  )
    return false;
  const error = o.error as Record<string, any>;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const rejection = message.replace(/^Invalid JSON payload received\.\s*/i, "");
  const parameter = typeof error.param === "string" ? error.param : "";
  const field =
    /^(?:(?:generation_config|generationConfig)\.)?(?:(?:thinking_config|thinkingConfig)\.)?(?:thinking_level|thinkingLevel|thinking_config|thinkingConfig)$/;
  const unsupported =
    /unsupported|not supported|does not support|unknown|unrecognized|cannot find field/i;
  // A response schema may itself contain these words. That is not evidence
  // that the generation control was rejected.
  if (/schema|response[_ ]?format|responseJsonSchema/i.test(message))
    return false;
  if (
    field.test(parameter) &&
    unsupported.test(message + " " + String(error.code ?? ""))
  )
    return true;
  for (const detail of Array.isArray(error.details) ? error.details : [])
    for (const violation of Array.isArray(detail?.fieldViolations)
      ? detail.fieldViolations
      : [])
      if (
        typeof violation.field === "string" &&
        field.test(violation.field) &&
        typeof violation.description === "string" &&
        unsupported.test(violation.description)
      )
        return true;
  const named =
    "(?:thinking[_ ]?level|thinkingLevel|thinking[_ ]?config|thinkingConfig)";
  if (
    new RegExp(
      `^(?:unknown|unrecognized|unsupported)\\s+(?:(?:parameter|field|argument|name)\\s*)?[:'\"\\s]*${named}\\b`,
      "i",
    ).test(rejection) ||
    new RegExp(
      `^${named}\\b(?:['\"\\s]+(?:is|are))?['\"\\s]+(?:not supported|unsupported)\\b`,
      "i",
    ).test(rejection) ||
    new RegExp(
      `^(?:(?:this|the)\\s+)?(?:model\\s+)?(?:does not support|not support)\\s+(?:the\\s+)?${named}\\b`,
      "i",
    ).test(rejection)
  )
    return true;
  // A typed enum rejection must name both the exact control and the value sent.
  return (
    /^(?:invalid value|invalid enum|unsupported value)/i.test(rejection) &&
    /thinking_level|thinkingLevel|thinking level/i.test(message) &&
    /TYPE_ENUM|enum|supported values|allowed values/i.test(message) &&
    new RegExp(`\\b${o.sentLevel}\\b`, "i").test(rejection)
  );
}
