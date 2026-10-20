import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite,
  type ChannelVersions,
  type CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Backend } from "./backend.ts";

type Stored = { type: string; data: string };
const encode = (bytes: Uint8Array) => {
  let value = "";
  for (let i = 0; i < bytes.length; i += 16384)
    value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Actual LangGraph saver interface, backed by lease-checked database RPCs. */
export class ModelGraphStore extends BaseCheckpointSaver {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private backend: Pick<Backend, "internal">,
    readonly job: { id: string; lease_token: string },
    readonly thread: string,
  ) {
    super();
  }
  action(action: string, payload: Record<string, unknown> = {}): Promise<any> {
    const result = this.pending.then(() =>
      this.backend.internal("model_graph_store", {
        job_id: this.job.id,
        lease: this.job.lease_token,
        thread_id: this.thread,
        action,
        payload,
      }),
    );
    this.pending = result.catch(() => undefined);
    return result;
  }
  async flush() {
    await this.pending;
  }
  private identity(config: RunnableConfig) {
    const c = config.configurable;
    if (c?.thread_id !== this.thread) throw new Error("GRAPH_THREAD_MISMATCH");
    return {
      namespace: String(c.checkpoint_ns ?? ""),
      checkpoint_id: c.checkpoint_id ?? null,
    };
  }
  private config(namespace: string, checkpoint_id: string): RunnableConfig {
    return {
      configurable: {
        thread_id: this.thread,
        checkpoint_ns: namespace,
        checkpoint_id,
      },
    };
  }
  private async pack(value: unknown): Promise<Stored> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return { type, data: encode(bytes) };
  }
  private unpack(value: Stored) {
    return this.serde.loadsTyped(value.type, decode(value.data));
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const row = await this.action("get", this.identity(config));
    if (!row) return undefined;
    const ordered = row.writes.sort((a: any, b: any) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.idx),
        writesSortKey(b.task_path, b.task_id, b.idx),
      ),
    );
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      ordered.map(
        async (w: any) =>
          [
            w.task_id,
            w.channel,
            await this.unpack(w.value),
          ] as CheckpointPendingWrite,
      ),
    );
    return {
      config: this.config(row.namespace, row.checkpoint_id),
      checkpoint: await this.unpack(row.checkpoint),
      metadata: await this.unpack(row.metadata),
      ...(row.parent_id
        ? { parentConfig: this.config(row.namespace, row.parent_id) }
        : {}),
      pendingWrites,
    };
  }
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const identity = this.identity(config);
    if (options.limit !== undefined && options.limit <= 0) return;
    const rows = await this.action("list", {
      namespace: identity.namespace,
      checkpoint_id: options.before?.configurable?.checkpoint_id ?? null,
      limit: 128,
    });
    let remaining = options.limit ?? 128;
    for (const row of rows) {
      if (
        identity.checkpoint_id &&
        identity.checkpoint_id !== row.checkpoint_id
      )
        continue;
      const tuple = await this.getTuple(
        this.config(identity.namespace, row.checkpoint_id),
      );
      if (
        !tuple ||
        (options.filter &&
          !Object.entries(options.filter).every(
            ([key, value]) => (tuple.metadata as any)?.[key] === value,
          ))
      )
        continue;
      yield tuple;
      if (--remaining <= 0) return;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _versions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const identity = this.identity(config);
    const [checkpointData, metadataData] = await Promise.all([
      this.pack(checkpoint),
      this.pack(metadata),
    ]);
    await this.action("put", {
      namespace: identity.namespace,
      checkpoint_id: checkpoint.id,
      parent_id: identity.checkpoint_id,
      checkpoint: checkpointData,
      metadata: metadataData,
    });
    return this.config(identity.namespace, checkpoint.id);
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    const identity = this.identity(config);
    await this.action("writes", {
      ...identity,
      task_id: taskId,
      task_path: taskPath,
      writes: await Promise.all(
        writes.map(async ([channel, value], idx) => ({
          channel,
          idx: WRITES_IDX_MAP[channel] ?? idx,
          value: await this.pack(value),
        })),
      ),
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.thread) throw new Error("GRAPH_THREAD_MISMATCH");
    await this.action("delete");
  }
}
