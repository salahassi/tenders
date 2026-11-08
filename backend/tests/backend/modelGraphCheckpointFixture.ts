import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import type { Backend } from "../../supabase/functions/_shared/backend.ts";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore.ts";

/** Capture the real saver wire format, replacing only its SQL transport. */
export async function modelGraphCheckpointFixture(
  reportRef: string,
  checkpointId = "0001",
) {
  let written: any;
  const backend = {
    internal: async (name: string, args: any) => {
      if (name !== "model_graph_store" || args.action !== "put")
        throw new Error("UNEXPECTED_CHECKPOINT_FIXTURE_OPERATION");
      written = args.payload;
      return {};
    },
  } as unknown as Pick<Backend, "internal">;
  const thread = "f".repeat(64);
  const saver = new ModelGraphStore(
    backend,
    { id: crypto.randomUUID(), lease_token: crypto.randomUUID() },
    thread,
  );
  const checkpoint = emptyCheckpoint();
  checkpoint.id = checkpointId;
  checkpoint.channel_values = { reportRef };
  await saver.put(
    { configurable: { thread_id: thread } },
    checkpoint,
    { source: "update", step: 0, parents: {} },
    {},
  );
  await saver.flush();
  if (!written) throw new Error("CHECKPOINT_FIXTURE_NOT_WRITTEN");
  return written as {
    checkpoint: { type: string; data: string };
    metadata: { type: string; data: string };
  };
}
