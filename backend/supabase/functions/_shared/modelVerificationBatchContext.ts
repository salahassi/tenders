import { ModelError } from "./model.ts";
import {
  sameVerificationPartition,
  type VerificationPolicy,
} from "./modelVerification.ts";

/** Version 5 changes only analysis input visibility, not the partition sizes,
 * scoped IDs, output schema or acceptance rules. Older pins stay exact. */
export function newVerificationBatchPin(
  task: string,
  policy?: VerificationPolicy,
) {
  const partition = policy ? { version: 4, policy } : { version: 3 };
  return task === "analyze_chunk"
    ? { version: 5, context_format: 3, partition }
    : partition;
}

export function verificationBatchPartition(pin: any, task: string) {
  if (pin?.version !== 5) return pin;
  const partition = pin.partition;
  if (
    task !== "analyze_chunk" ||
    Object.keys(pin).length !== 3 ||
    pin.context_format !== 3 ||
    !partition ||
    typeof partition !== "object" ||
    Array.isArray(partition) ||
    !(
      (partition.version === 3 && Object.keys(partition).length === 1) ||
      (partition.version === 4 &&
        partition.policy?.version === 2 &&
        Number.isSafeInteger(partition.policy.outputTokens) &&
        partition.policy.outputTokens >= 1024 &&
        partition.policy.outputTokens <= 131072 &&
        sameVerificationPartition(partition, partition.policy))
    )
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  return partition;
}

export function verificationBatchContext(
  context: any,
  candidate: unknown,
  pin: any,
) {
  if (pin?.version !== 5) return context;
  verificationBatchPartition(pin, context.original_task);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !["content_batch", "requirements_only"].includes(context.verification_scope)
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  // Keep the JSON field hierarchy and typed values. The original scoped
  // content_units still exclusively determine permissible quotations and IDs.
  return {
    ...context,
    candidate,
    response_style: "compact-verification-v3",
  };
}
