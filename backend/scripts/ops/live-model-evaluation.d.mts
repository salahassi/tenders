export const LIMITS: {
  models: number;
  generations: number;
  outputTokens: number;
  pollsPerCase: number;
};
export const EXTENDED_LIMITS: typeof LIMITS;
export const RECHECK_LIMITS: typeof LIMITS;
export const RECHECK_PAIRS: readonly (readonly string[])[];
export type EvaluationSuite = "core" | "extended" | "extended_recheck";
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
