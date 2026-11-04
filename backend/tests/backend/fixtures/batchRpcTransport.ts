import { postgrestBatchBody } from "../../../supabase/functions/_shared/batchTransport.ts";
import { AppError } from "../../../supabase/functions/_shared/http.ts";

// Real canonical SQL behind a synthetic PostgREST transport. The adapter emits
// each small manifest/chunk separately and exercises the production consumer;
// it does not qualify real PostgREST memory, TLS or hosted authentication.
export function batchRpcBody(
  rpc: (
    name: string,
    args: Record<string, unknown>,
    token: string,
  ) => Promise<unknown>,
  token: string,
  commands: unknown[],
  idempotencyKey: string,
  signal: AbortSignal,
) {
  return postgrestBatchBody({
    url: "https://synthetic.invalid",
    publishableKey: "synthetic-key",
    token,
    commands,
    idempotencyKey,
    signal,
    fetch: async (url, init) => {
      const name = new URL(String(url)).pathname.split("/").at(-1)!;
      if (!["app_batch_prepare", "app_batch_result_chunk"].includes(name))
        throw new Error("Unexpected fixture RPC");
      try {
        return Response.json(
          await rpc(name, JSON.parse(init!.body as string), token),
        );
      } catch (error) {
        const value = error as {
          message: string;
          code?: string;
          details?: unknown;
        };
        return Response.json(
          {
            message: error instanceof AppError ? error.code : value.message,
            code: error instanceof AppError ? "P0001" : value.code,
            details:
              typeof value.details === "string"
                ? value.details
                : JSON.stringify(value.details ?? null),
          },
          { status: 400 },
        );
      }
    },
  });
}
