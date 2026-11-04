export const LIMITS: {
  bytes: number;
  json: number;
  requests: number;
  report: number;
};
export function validateInput(value: any): any;
export function classifySnapshot(value: any): string;
export function checkIssuance(value: any, input: any): any;
export function acceptDeliverySnapshot(
  input: any,
  fetcher?: typeof fetch,
  clock?: { now(): number; wait(ms: number): Promise<void> },
): Promise<any>;
