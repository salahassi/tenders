import { ModelError } from "./model.ts";
import {
  mergeModelValidationDiagnostics,
  modelValidationCodes,
} from "./modelValidationDiagnostics.ts";

const contextualCodes = new Set<string>(modelValidationCodes);

/** Run independent checks only. Malformed schemas, missing prerequisites and
 * unexpected exceptions stop immediately; they are never repair evidence.
 * A dependent check belongs in the same closure as its prerequisite. */
export function runModelValidationChecks(checks: readonly (() => unknown)[]) {
  const failures: ModelError[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (error) {
      if (
        !(error instanceof ModelError) ||
        !contextualCodes.has(error.code) ||
        !error.validationDiagnostics.length
      )
        throw error;
      failures.push(error);
    }
  }
  if (failures.length) {
    const merged = mergeModelValidationDiagnostics(
      ...failures.map((error) => ({
        diagnostics: error.validationDiagnostics,
        omittedCount: error.omittedValidationDiagnosticCount,
      })),
    );
    // Preserve the same first validation code/retry policy as the serial path.
    throw new ModelError(
      failures[0].code,
      failures[0].retryAfter,
      merged.diagnostics,
      merged.omittedCount,
    );
  }
}
