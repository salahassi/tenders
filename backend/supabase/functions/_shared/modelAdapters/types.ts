import type {
  ExecutionProfile,
  ModelCapabilities,
  TransportResult,
} from "../modelContract.ts";
import type { ModelProviderId } from "../modelProviders.ts";
export type AdapterEnvironment = {
  provider: string;
  model: string;
  projectRef: string;
  key: string;
};
export type AdapterInput = {
  task: string;
  prompt: string;
  system: string;
  schema: Record<string, any>;
  profile: ExecutionProfile;
  capabilities: ModelCapabilities;
  stream: boolean;
};
export type AdapterRequest = {
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  method?: "POST" | "GET" | "DELETE";
};
export interface ModelAdapter {
  provider: ModelProviderId;
  prepare(
    env: AdapterEnvironment,
    input: AdapterInput,
    background: boolean,
  ): AdapterRequest;
  poll?(
    env: AdapterEnvironment,
    remoteId: string,
    remove?: boolean,
  ): AdapterRequest;
  normalize(result: any, background: boolean): TransportResult;
}
export const unknownUsage = () => ({
  input: null,
  output: null,
  thinking: null,
});
export function validRemoteId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw new Error("PROVIDER_REQUEST_INVALID");
  return encodeURIComponent(value);
}
