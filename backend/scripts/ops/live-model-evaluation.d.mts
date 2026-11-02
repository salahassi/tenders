export const LIMITS: {
  models: number;
  generations: number;
  outputTokens: number;
  pollsPerCase: number;
};
export function fixtures(): Promise<any[]>;
export function validateTargets(targets: unknown): void;
export function evaluate(
  targets: any[],
  fetcher?: typeof fetch,
  pause?: (ms: number) => Promise<void>,
): Promise<any>;
