export const LIMITS: {
  models: number;
  generations: number;
  outputTokens: number;
  pollsPerCase: number;
};
export const EXTENDED_LIMITS: typeof LIMITS;
export function limitsForSuite(suite?: "core" | "extended"): typeof LIMITS;
export function fixtures(suite?: "core" | "extended"): Promise<any[]>;
export function validateTargets(
  targets: unknown,
  suite?: "core" | "extended",
): void;
export function evaluate(
  targets: any[],
  fetcher?: typeof fetch,
  pause?: (ms: number) => Promise<void>,
  progress?: (value: any) => void,
  suite?: "core" | "extended",
): Promise<any>;
