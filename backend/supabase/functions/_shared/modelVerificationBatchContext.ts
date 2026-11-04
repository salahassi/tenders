import { ModelError } from "./model.ts";
import { primaryModelTasks } from "./modelSchemas.ts";
import {
  typedCandidateStructure,
  TYPED_BATCH_CONTEXT_INSTRUCTION,
} from "./modelTypedCandidate.ts";
import {
  sameVerificationPartition,
  type VerificationPolicy,
} from "./modelVerification.ts";

/** Versions 5/6 add typed visibility without changing partition sizes, scoped
 * IDs, output schema or acceptance. Version 6 covers other primary tasks. */
export function newVerificationBatchPin(
  task: string,
  policy?: VerificationPolicy,
) {
  if (!primaryModelTasks.includes(task as any) || task === "connection_probe")
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const partition = policy ? { version: 4, policy } : { version: 3 };
  return task === "analyze_chunk"
    ? { version: 5, context_format: 3, partition }
    : { version: 6, context_format: 4, partition };
}

export function verificationBatchPartition(pin: any, task: string) {
  if (![5, 6].includes(pin?.version)) return pin;
  const partition = pin.partition;
  if (
    (pin.version === 5
      ? task !== "analyze_chunk"
      : task === "analyze_chunk" ||
        task === "connection_probe" ||
        !primaryModelTasks.includes(task as any)) ||
    Object.keys(pin).length !== 3 ||
    pin.context_format !== (pin.version === 5 ? 3 : 4) ||
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
  if (![5, 6].includes(pin?.version)) return context;
  verificationBatchPartition(pin, context.original_task);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !["content_batch", "requirements_only"].includes(context.verification_scope)
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  if (pin.version === 6) {
    const typed = typedCandidateStructure(candidate);
    if (
      !Array.isArray(context.content_units) ||
      context.content_units.some(
        (unit: any) =>
          !typed.units.some(
            (original) =>
              original.id === unit.id && original.text === unit.text,
          ),
      )
    )
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    const { candidate: _candidate, candidate_text: _text, ...scoped } = context;
    return {
      ...scoped,
      typed_candidate_structure: typed.structure,
      typed_content_manifest: {
        version: 1,
        content_unit_ids: typed.units.map((unit) => unit.id),
        scoped_content_ids: context.content_units.map((unit: any) => unit.id),
      },
      typed_context_instruction: TYPED_BATCH_CONTEXT_INSTRUCTION,
      response_style: "compact-verification-v4",
    };
  }
  // Preserve the exact version-5 analysis payload. The original scoped
  // content_units still exclusively determine permissible quotations and IDs.
  return {
    ...context,
    candidate,
    response_style: "compact-verification-v3",
  };
}
