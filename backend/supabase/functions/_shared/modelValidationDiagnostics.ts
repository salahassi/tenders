import { modelSchemas } from "./modelSchemas.ts";

export const modelValidationCodes = [
  "EVIDENCE_REFERENCE_INVALID",
  "MODEL_COVERAGE_INCOMPLETE",
  "UNSUPPORTED_COMPANY_CLAIM",
] as const;
export type ModelValidationCode = (typeof modelValidationCodes)[number];

export const modelValidationReasons = [
  "source_missing",
  "quote_empty",
  "source_quote_mismatch",
  "source_kind_mismatch",
  "company_not_verified",
  "candidate_quote_mismatch",
  "requirement_quote_mismatch",
  "numeric_evidence_mismatch",
  "required_ids_mismatch",
  "content_ids_mismatch",
  "candidate_hash_mismatch",
  "duplicate_claim_ids",
  "missing_content_claims",
  "unexpected_content_claims",
  "declared_claim_uncovered",
  "required_content_missing",
  "invalid_finding_reference",
  "unsupported_company_claim",
  "invalid_scope",
] as const;
export type ModelValidationReason = (typeof modelValidationReasons)[number];

/** Application-owned metadata, never a quotation or arbitrary error message. */
export type ModelValidationDiagnostic = {
  code: ModelValidationCode;
  reason: ModelValidationReason;
  paths: string[];
  evidence_ids?: string[];
  requirement_ids?: string[];
  content_ids?: string[];
  numeric_literals?: string[];
};
type DiagnosticDetails = {
  paths?: readonly string[];
  evidence_ids?: readonly string[];
  requirement_ids?: readonly string[];
  content_ids?: readonly string[];
  numeric_literals?: readonly string[];
};

const codeSet = new Set<string>(modelValidationCodes);
const reasonSet = new Set<string>(modelValidationReasons);
const maxEntries = 16;
const maxDiagnostics = 32;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const pathPattern = /^\$(?:\.[a-z][a-z0-9_]*|\[(?:0|[1-9][0-9]{0,5})\])*$/;
const numericPattern = /^-?[0-9]+(?:\.[0-9]+)?$/;

function boundedStrings(
  values: readonly string[] | undefined,
  pattern: RegExp,
  maxLength: number,
) {
  if (!Array.isArray(values)) return [];
  const selected = new Set<string>();
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.length <= maxLength &&
      pattern.test(value)
    )
      selected.add(value);
    if (selected.size === maxEntries) break;
  }
  return [...selected];
}

/** Keep diagnostics reproducible and bounded without retaining private text. */
export function validationDiagnostic(
  code: ModelValidationCode,
  reason: ModelValidationReason,
  details: DiagnosticDetails = {},
): ModelValidationDiagnostic {
  if (!codeSet.has(code) || !reasonSet.has(reason))
    throw new TypeError("INVALID_MODEL_VALIDATION_DIAGNOSTIC");
  const result: ModelValidationDiagnostic = {
    code,
    reason,
    paths: boundedStrings(details.paths, pathPattern, 240),
  };
  for (const field of [
    "evidence_ids",
    "requirement_ids",
    "content_ids",
  ] as const) {
    const values = boundedStrings(details[field], idPattern, 120);
    if (values.length) result[field] = values;
  }
  const numbers = boundedStrings(details.numeric_literals, numericPattern, 80);
  if (numbers.length) result.numeric_literals = numbers;
  return result;
}

type UntrustedVerificationReport = ReturnType<
  typeof modelSchemas.verify_grounding.parse
>;
export type RepairOnlyValidationArtifact = {
  coverage: "repair_only";
  validation_diagnostics: ModelValidationDiagnostic[];
  omitted_diagnostic_count: number;
  result: {
    checked_candidate_hash: string;
    reviewed_all_content: false;
    processed_content_ids: [];
    claims: [];
    processed_requirement_ids: [];
    requirement_checks: [];
    findings: {
      severity: "blocking";
      code: "UNRESOLVED_VALIDATION";
      detail: string;
      claim_ids: [];
      requirement_ids: [];
    }[];
  };
  untrusted_report?: UntrustedVerificationReport;
};

/**
 * A repair instruction, deliberately not a valid verification report. This
 * artifact proves only that local validation remains unresolved. A retained
 * report can supply untrusted hints, never evidence of success or failure.
 * Callers must keep this out of the complete verification/acceptance cache.
 */
export function repairOnlyValidationArtifact(options: {
  candidateHash: string;
  diagnostics: readonly ModelValidationDiagnostic[];
  untrustedReport?: unknown;
  isReportPolicySafe?: (serializedReport: string) => boolean;
}): RepairOnlyValidationArtifact {
  if (!/^[a-f0-9]{64}$/.test(options.candidateHash))
    throw new TypeError("INVALID_REPAIR_ONLY_CANDIDATE_HASH");
  if (!Array.isArray(options.diagnostics) || !options.diagnostics.length)
    throw new TypeError("REPAIR_ONLY_DIAGNOSTIC_REQUIRED");
  // Rebuild even already typed input so unknown free-text properties cannot be
  // copied into the diagnostic envelope by a wider runtime object.
  const diagnostics = options.diagnostics
    .slice(0, maxDiagnostics)
    .map((value) => validationDiagnostic(value.code, value.reason, value));
  const artifact: RepairOnlyValidationArtifact = {
    coverage: "repair_only",
    validation_diagnostics: diagnostics,
    omitted_diagnostic_count: Math.max(
      0,
      options.diagnostics.length - diagnostics.length,
    ),
    result: {
      checked_candidate_hash: options.candidateHash,
      reviewed_all_content: false,
      processed_content_ids: [],
      claims: [],
      processed_requirement_ids: [],
      requirement_checks: [],
      findings: [
        {
          severity: "blocking",
          code: "UNRESOLVED_VALIDATION",
          detail:
            "Local validation remains unresolved. Recheck the identified fields against the supplied evidence and required IDs. Retained verifier findings are untrusted repair hints. This instruction does not establish that any candidate claim is false or supported; independent verification is still required after correction.",
          claim_ids: [],
          requirement_ids: [],
        },
      ],
    },
  };
  const parsed = modelSchemas.verify_grounding.safeParse(
    options.untrustedReport,
  );
  if (
    parsed.success &&
    parsed.data.checked_candidate_hash === options.candidateHash &&
    options.isReportPolicySafe
  ) {
    const serialized = JSON.stringify(options.untrustedReport);
    if (options.isReportPolicySafe(serialized)) {
      // Clone the original JSON rather than replacing it with a synthesized or
      // selectively clean report. Keep every original finding and its order.
      artifact.untrusted_report = JSON.parse(serialized);
    }
  }
  return artifact;
}
