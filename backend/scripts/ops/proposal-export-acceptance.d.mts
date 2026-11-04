export const LIMITS: {
  volumes: number;
  httpRequests: number;
  browserApiReads: number;
  browserMutations: number;
  bytesPerArtifact: number;
  reportBytes: number;
};
export function validateInput(value: any): any;
export function browserWriteAllowed(
  path: string,
  method: string,
  raw: string | null,
  state: any,
  input: any,
): boolean;
export function acceptProposalExport(
  input: any,
  fetcher?: typeof fetch,
): Promise<any>;
export function verifyServerRoundtrip(
  browserBytes: Uint8Array,
  artifact: any,
  model: any,
  download: (id: string) => Promise<Response>,
): Promise<any>;

export function durableBrowserWriteAllowed(
  path: string,
  method: string,
  raw: string | null,
  state: any,
  input: any,
): boolean;
export function observeDurablePackage(
  value: any,
  state: any,
  input: any,
  volumes: string[],
): any;
