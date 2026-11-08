import type { Backend, BackendEnvironment } from "./backend.ts";
import {
  FreeModelProvider,
  ModelDeferred,
  ModelError,
  parseModelPool,
  tryAvailable,
  type AttemptMetadata,
  type Ledger,
  type ModelConfiguration,
  type ModelTask,
  type Reference,
} from "./model.ts";
import {
  capabilitySchema,
  executionProfileSchema,
  type StructuredRequest,
} from "./modelContract.ts";

type Pending = NonNullable<Awaited<ReturnType<NonNullable<Ledger["resume"]>>>>;
type JobIdentity = { id: string; lease_token: string };
type Binding = {
  job: JobIdentity;
  requestPrefix: string;
  operation: ModelTask;
  attemptId: string;
  pending: Pending;
  configuration: ModelConfiguration;
};
const same = (left: unknown, right: unknown): boolean => {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
};
const target = (config: ModelConfiguration) => [
  config.provider,
  config.model,
  config.project_ref,
  config.connection_id,
  config.model_config_id,
];

/** Invocation-local, one-use GET result. It never accepts content or settles usage. */
export class AcceptedPollReceipt {
  #consumed = false;
  #attached = false;
  constructor(
    private readonly binding: Binding,
    private readonly response: {
      interaction?: any;
      error?: unknown;
      telemetry: AttemptMetadata;
    },
  ) {}
  get available() {
    return !this.#attached && !this.#consumed;
  }
  attempt(o: {
    job?: JobIdentity;
    requestPrefix?: string;
    task: ModelTask;
    inputHash: string;
    configuration: ModelConfiguration;
  }): string {
    const b = this.binding;
    if (
      this.#consumed ||
      this.#attached ||
      !o.job ||
      o.job.id !== b.job.id ||
      o.job.lease_token !== b.job.lease_token ||
      o.requestPrefix !== b.requestPrefix ||
      o.task !== b.operation ||
      o.inputHash !== b.pending.execution_metadata?.input_hash ||
      !same(target(o.configuration), target(b.configuration))
    )
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    this.#attached = true;
    return b.attemptId;
  }
  consume(request: StructuredRequest, pending: Pending) {
    const b = this.binding,
      saved: any = b.pending.execution_metadata;
    if (
      this.#consumed ||
      !this.#attached ||
      !pending ||
      pending.id !== b.pending.id ||
      pending.remote_request_id !== b.pending.remote_request_id ||
      pending.remote_deadline !== b.pending.remote_deadline ||
      !same(pending.execution_metadata, b.pending.execution_metadata) ||
      request.task !== b.operation ||
      request.inputHash !== saved?.input_hash ||
      request.promptVersion !== saved.prompt_version ||
      request.schemaVersion !== saved.schema_version ||
      request.contractVersion !== saved.contract_version ||
      !same(request.profile, saved.profile) ||
      !same(request.capabilities, saved.capabilities) ||
      !same(
        request.reasoningControl ?? null,
        saved.reasoning_control ?? null,
      ) ||
      request.routeRevision !== (saved.route_revision ?? null) ||
      !same(
        [
          request.target.provider,
          request.target.model,
          request.target.project,
          request.target.connectionId,
          request.target.modelId,
        ],
        target(b.configuration),
      )
    )
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    this.#consumed = true;
    return this.response;
  }
}

/** Cheap unfinished polling after the original outer input hash is proved,
 * before LangGraph replay and repeated phase prompt construction. */
export async function prepareAcceptedModelPoll(o: {
  backend: Backend;
  job: JobIdentity & { checkpoint?: Record<string, any> };
  threadId: string;
  graphInputHash: string;
  manifest: Reference[];
  environments: BackendEnvironment["models"];
  fetcher: typeof fetch;
}): Promise<AcceptedPollReceipt | null> {
  const checkpoint = o.job.checkpoint;
  if (
    checkpoint?.model_executor !== 2 ||
    checkpoint.graph_thread !== o.threadId ||
    Object.hasOwn(checkpoint, "verifier_recheck") ||
    !checkpoint.model_round?.input_hash
  )
    return null;
  const first = checkpoint.model_round.remaining?.[0];
  const frozen = checkpoint.model_routing?.providers?.find(
    (config: ModelConfiguration) =>
      first && same(target(config), target(first)),
  );
  if (!frozen) return null;
  const environment =
    o.backend.resolveModelEnvironment?.(frozen) ??
    (o.environments[frozen.provider as keyof typeof o.environments] && {
      ...o.environments[frozen.provider as keyof typeof o.environments]!,
      model: frozen.model,
      projectRef: frozen.project_ref,
    });
  if (!environment?.key || !tryAvailable(frozen, environment)) return null;
  const prepared = await o.backend.internal("prepare_accepted_model_poll", {
    job_id: o.job.id,
    lease: o.job.lease_token,
    thread_id: o.threadId,
    graph_input_hash: o.graphInputHash,
    manifest: o.manifest,
  });
  if (prepared === null) return null;
  if (
    prepared?.version !== 1 ||
    typeof prepared.request_prefix !== "string" ||
    !/^[1-9][0-9]*$/.test(prepared.attempt_id ?? "") ||
    !prepared.pending?.execution_metadata
  )
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const configuration = parseModelPool({
    providers: [prepared.configuration],
    routing_mode: "round_robin",
    executor_version: 2,
  }).providers[0];
  if (!same(target(configuration), target(frozen)))
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  const pending: Pending = prepared.pending;
  const binding: Binding = {
    job: { id: o.job.id, lease_token: o.job.lease_token },
    requestPrefix: prepared.request_prefix,
    operation: prepared.operation,
    attemptId: prepared.attempt_id,
    pending,
    configuration,
  };
  const saved = pending.execution_metadata!;
  const profile = executionProfileSchema.parse(saved.profile);
  const capabilities = capabilitySchema.parse(saved.capabilities);
  const remoteDeadline = Date.parse(pending.remote_deadline);
  const issuanceDeadline = prepared.issuance_request
    ? Date.parse(prepared.issuance_request.deadline_at)
    : Infinity;
  if (!capabilities.background || !Number.isFinite(remoteDeadline))
    throw new ModelError("MODEL_IDENTITY_CHANGED");
  if (remoteDeadline <= Date.now())
    return new AcceptedPollReceipt(binding, {
      error: new ModelError("MODEL_RESULT_EXPIRED"),
      telemetry: {},
    });
  if (
    !(issuanceDeadline > Date.now()) ||
    (prepared.issuance_request &&
      prepared.issuance_request.outcome !== "active")
  )
    throw new ModelError("PROPOSAL_ISSUANCE_TIMEOUT");
  const provider = new FreeModelProvider(
    environment,
    o.fetcher,
    20000,
    false,
    configuration,
    1,
    0,
    false,
    Number.isFinite(issuanceDeadline) ? issuanceDeadline : undefined,
  );
  provider.usePreparedRequest(profile, capabilities);
  let interaction: any, error: unknown;
  try {
    interaction = await provider.pollBackground(pending.remote_request_id);
    if (interaction.id !== pending.remote_request_id)
      throw new ModelError("MODEL_IDENTITY_CHANGED");
  } catch (caught) {
    error = caught;
  }
  if (!error && ["in_progress", "queued"].includes(interaction.status)) {
    await o.backend.internal("finish_model_attempt", {
      attempt_id: prepared.attempt_id,
      lease: o.job.lease_token,
      result_code: "MODEL_IN_PROGRESS",
      sent: false,
      usage_id: pending.id,
      metadata: { ...provider.telemetry, retry_after: null },
    });
    await o.backend.internal("defer_pending_model_request", {
      job_id: o.job.id,
      lease: o.job.lease_token,
      reservation: pending.id,
    });
    throw new ModelDeferred();
  }
  return new AcceptedPollReceipt(binding, {
    interaction,
    error,
    telemetry: { ...provider.telemetry },
  });
}
