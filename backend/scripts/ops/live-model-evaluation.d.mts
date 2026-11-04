export const LIMITS: {
  models: number;
  generations: number;
  outputTokens: number;
  pollsPerCase: number;
};
export const EXTENDED_LIMITS: typeof LIMITS;
export const SEMANTIC_LIMITS: typeof LIMITS;
export const RECHECK_LIMITS: typeof LIMITS;
export const PLANNING_LIMITS: typeof LIMITS;
export const VERIFICATION_LIMITS: typeof LIMITS;
export const RECHECK_PAIRS: readonly (readonly string[])[];
export type EvaluationSuite =
  | "core"
  | "extended"
  | "extended_recheck"
  | "planning_repair"
  | "analysis_verification"
  | "analysis_authority"
  | "semantic_en"
  | "semantic_ar"
  | "semantic_v2_en"
  | "semantic_v2_ar";
export function limitsForSuite(suite?: EvaluationSuite): typeof LIMITS;
export function fixtures(suite?: EvaluationSuite): Promise<any[]>;
export function validateTargets(
  targets: unknown,
  suite?: EvaluationSuite,
): void;
export function evaluate(
  targets: any[],
  fetcher?: typeof fetch,
  pause?: (ms: number) => Promise<void>,
  progress?: (value: any) => void,
  suite?: EvaluationSuite,
): Promise<any>;
