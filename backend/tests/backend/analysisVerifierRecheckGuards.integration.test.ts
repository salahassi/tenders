// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  createRecheckFixture,
  recheckHelpers,
} from "./analysisVerifierRecheckFixture";
import { taskRegistry } from "../../supabase/functions/_shared/modelContract";
import { sha256 } from "../../supabase/functions/_shared/model";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function childFixture() {
  const s = await createRecheckFixture(f);
  const created = await s.createChild().catch((error) => {
    throw new Error(`createChild: ${error.message}; ${error.where ?? ""}`);
  });
  const child = await s.claimChild(created).catch((error) => {
    throw new Error(`claimChild: ${error.message}; ${error.where ?? ""}`);
  });
  return { ...s, child, created };
}
type Child = Awaited<ReturnType<typeof childFixture>>;
const identity = (s: Child) => ({
  job_id: s.child.job.id,
  lease: s.child.job.lease_token,
});
const target = (s: Child) => ({
  target_model: s.model.id,
  target_connection: s.connection.id,
});
async function verifierRoute(s: Child) {
  await s.rpc("prepare_task_model_route", {
    ...identity(s),
    task_name: "verify_grounding",
    default_profile: taskRegistry.verify_grounding.profile,
  });
}
async function deniedUnchanged(
  s: Child,
  run: () => Promise<unknown>,
  code: string,
) {
  const before = await s.snapshot();
  await expect(run()).rejects.toThrow(code);
  expect(await s.snapshot()).toEqual(before);
}

async function preparedVerifier(s: Child, corrective = false) {
  await verifierRoute(s);
  const phase = `${s.child.prefix}:verification${corrective ? "-repair" : ""}-${s.candidateHash}`;
  const phaseHash = await sha256(phase);
  const inputHash = await sha256(`Synthetic verifier input: ${phase}`);
  await s.child.store.action("result_put", {
    key: "candidate-0",
    value: s.candidate.value,
  });
  for (const policy of ["verification", "semantic"])
    await s.child.store.action("result_put", {
      key: `${policy}-instructions-${phaseHash}`,
      value: { version: 4 },
    });
  const attemptId = await s.rpc("start_task_model_attempt", {
    ...identity(s),
    ...target(s),
    operation_name: "verify_grounding",
  });
  await s.rpc("record_model_request_metadata", {
    attempt_id: attemptId,
    lease: s.child.job.lease_token,
    metadata: {
      contract_version: 1,
      schema_version: 1,
      prompt_version:
        "tenderdesk-grounding-v4-analysis-boundary.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1",
      input_hash: inputHash,
      route_revision: 1,
      profile: taskRegistry.verify_grounding.profile,
      capabilities: s.model.capabilities,
    },
  });
  return {
    phase,
    phaseHash,
    inputHash,
    attemptId,
    args: {
      ...identity(s),
      ...target(s),
      input_hash: inputHash,
      call_key: `${phase}:${inputHash.slice(0, 16)}:${s.child.job.attempts}:${s.model.id}`,
      manifest: s.input.manifest,
      input_tokens: 10,
      output_tokens: 1024,
    },
  };
}

it("keeps lineage and privileged recheck helpers inaccessible to browser and service roles", async () => {
  const helpers = [
    "app_private.recheck_analysis_verifier(jsonb,text)",
    "app_private.analysis_recheck_binding(uuid)",
    "app_private.guard_analysis_recheck_graph(uuid,text,text,jsonb)",
    "app_private.guard_analysis_recheck_request(uuid,text,text)",
    "app_private.guard_analysis_recheck_reservation(uuid,uuid,text,text,uuid,uuid)",
  ];
  const h = recheckHelpers(f);
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of helpers)
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_function_privilege($1,$2,'execute') allowed",
            [role, signature],
          )
        ).rows[0].allowed,
      ).toBe(false);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      expect(
        (
          await f.db.query<{ allowed: boolean }>(
            "select has_table_privilege($1,'app_private.analysis_verifier_rechecks',$2) allowed",
            [role, privilege],
          )
        ).rows[0].allowed,
      ).toBe(false);
    await expect(
      h.attempt(async () => {
        await f.db.exec(`set local role ${role}`);
        await f.db.query("select app_private.analysis_recheck_binding($1)", [
          crypto.randomUUID(),
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
  }
});

it("denies writer routing and attempts through modern and legacy entry points without side effects", async () => {
  const s = await childFixture();
  for (const operation of ["analyze_chunk", "repair_result", "draft_section"])
    await deniedUnchanged(
      s,
      () =>
        s.rpc("prepare_task_model_route", {
          ...identity(s),
          task_name: operation,
          default_profile: taskRegistry.analyze_chunk.profile,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
  await verifierRoute(s);
  for (const operation of ["analyze_chunk", "repair_result", "draft_section"])
    await deniedUnchanged(
      s,
      () =>
        s.rpc("start_task_model_attempt", {
          ...identity(s),
          ...target(s),
          operation_name: operation,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
  for (const operation of ["analyze_chunk", "verify_grounding"])
    await deniedUnchanged(
      s,
      () =>
        s.rpc("start_model_attempt", {
          ...identity(s),
          provider_id: "qwencloud",
          model_name: s.model.model,
          project_name: s.connection.project_ref,
          operation_name: operation,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
});

it.each([false, true])(
  "records the retained writer's configuration in verifier telemetry (distinct verifier=%s)",
  async (distinct) => {
    const original = await createRecheckFixture(f);
    const history = async () => ({
      attempts: (
        await f.db.query(
          "select * from public.model_attempts where job_id=$1 order by id",
          [original.parent.id],
        )
      ).rows,
      usage: (
        await f.db.query(
          "select * from public.provider_usage where job_id=$1 order by id",
          [original.parent.id],
        )
      ).rows,
    });
    const before = await history();
    const model = distinct
      ? await f.command("model.configuration.save", {
          connection_id: original.connection.id,
          label: "Synthetic distinct verifier configuration",
          model: "fixture-distinct-verifier",
          enabled: true,
          capabilities: original.model.capabilities,
          expected_revision: 0,
        })
      : original.model;
    await f.command("model.task_route.save", {
      task: "verify_grounding",
      model_ids: [model.id],
      inherit_default: false,
      strategy: "priority",
      profile: null,
      expected_revision: 0,
    });
    const created = await original.createChild();
    const child = await original.claimChild(created);
    const s = { ...original, model, created, child };
    const prepared = await preparedVerifier(s);
    const attempt = await s.row("public.model_attempts", prepared.attemptId);
    expect(attempt).toMatchObject({
      job_id: child.job.id,
      model_config_id: model.id,
      operation: "verify_grounding",
      execution_metadata: {
        same_model_verification: !distinct,
        graph_thread: child.threadId,
      },
    });
    expect(
      (
        await f.db.query(
          "select id from public.model_attempts where job_id=$1 and operation<>'verify_grounding'",
          [child.job.id],
        )
      ).rows,
    ).toEqual([]);
    expect(await history()).toEqual(before);
  },
);

it("denies writer, foreign-candidate and unscoped usage reservations and resumptions", async () => {
  const s = await childFixture();
  await verifierRoute(s);
  const input = "d".repeat(64);
  const base = {
    ...identity(s),
    ...target(s),
    input_hash: input,
    manifest: [],
  };
  for (const phase of [
    `${s.child.prefix}:candidate-0`,
    `${s.child.prefix}:candidate-1`,
    `${s.child.prefix}:verification-${"f".repeat(64)}`,
    `${s.child.prefix}:verification-repair-${"f".repeat(64)}`,
    `${s.prefix}:verification-${s.candidateHash}`,
    `${s.child.prefix}:verification-${s.candidateHash}:candidate-0`,
  ]) {
    await deniedUnchanged(
      s,
      () =>
        s.rpc("reserve_task_model_call", {
          ...base,
          call_key: `${phase}:${input.slice(0, 16)}:1:${s.model.id}`,
          input_tokens: 10,
          output_tokens: 1024,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
    await deniedUnchanged(
      s,
      () =>
        s.rpc("resume_task_model_request_phase", {
          ...base,
          request_prefix: phase,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
  }
  await deniedUnchanged(
    s,
    () => s.rpc("resume_task_model_request", base),
    "MODEL_RECHECK_WRITER_FORBIDDEN",
  );
  const legacy = {
    ...identity(s),
    input_hash: input,
    manifest: [],
    target_provider: "qwencloud",
  };
  await deniedUnchanged(
    s,
    () =>
      s.rpc("reserve_model_call", {
        ...legacy,
        call_key: `${s.child.prefix}:verification-${s.candidateHash}`,
        input_tokens: 10,
        output_tokens: 1024,
      }),
    "MODEL_RECHECK_WRITER_FORBIDDEN",
  );
  await deniedUnchanged(
    s,
    () => s.rpc("resume_model_request", legacy),
    "MODEL_RECHECK_WRITER_FORBIDDEN",
  );
});

it.each([false, true])(
  "admits an exact pinned verifier reservation (corrective=%s) through canonical RPCs",
  async (corrective) => {
    const s = await childFixture();
    const request = await preparedVerifier(s, corrective);
    const usage = await s.rpc("reserve_task_model_call", request.args);
    expect(usage).toMatchObject({
      job_id: s.child.job.id,
      lease_token: s.child.job.lease_token,
      model_config_id: s.model.id,
      connection_id: s.connection.id,
      input_hash: request.inputHash,
      call_key: request.args.call_key,
      state: "reserved",
    });
    expect(await s.row("public.provider_usage", s.usage.id)).toEqual(s.usage);
  },
);

it.each([
  "missing-verification-pin",
  "wrong-semantic-pin",
  "missing-seed",
  "attempt-finished",
  "attempt-wrong-prompt",
  "attempt-wrong-hash",
  "attempt-wrong-thread",
  "wrong-call-attempt",
])("rejects %s before reserving any new tokens", async (reason) => {
  const s = await childFixture();
  const request = await preparedVerifier(s);
  if (reason === "missing-verification-pin")
    await f.db.query(
      "delete from app_private.model_graph_results where thread_id=$1 and result_key=$2",
      [s.child.threadId, `verification-instructions-${request.phaseHash}`],
    );
  if (reason === "wrong-semantic-pin")
    await f.db.query(
      "update app_private.model_graph_results set value=jsonb_set(value,'{version}','2') where thread_id=$1 and result_key=$2",
      [s.child.threadId, `semantic-instructions-${request.phaseHash}`],
    );
  if (reason === "missing-seed")
    await f.db.query(
      "delete from app_private.model_graph_results where thread_id=$1 and result_key='candidate-0'",
      [s.child.threadId],
    );
  if (reason === "attempt-finished")
    await f.db.query(
      "update public.model_attempts set status='failed',result_code='MODEL_CORRECTION_EXHAUSTED' where id=$1",
      [request.attemptId],
    );
  if (reason.startsWith("attempt-wrong-")) {
    const field =
      reason === "attempt-wrong-prompt"
        ? "prompt_version"
        : reason === "attempt-wrong-hash"
          ? "input_hash"
          : "graph_thread";
    await f.db.query(
      "update public.model_attempts set execution_metadata=jsonb_set(execution_metadata,$2::text[],to_jsonb($3::text)) where id=$1",
      [request.attemptId, [field], "f".repeat(64)],
    );
  }
  if (reason === "wrong-call-attempt")
    request.args.call_key = `${request.phase}:${request.inputHash.slice(0, 16)}:${s.child.job.attempts + 1}:${s.model.id}`;
  await deniedUnchanged(
    s,
    () => s.rpc("reserve_task_model_call", request.args),
    "MODEL_RECHECK_IDENTITY_CHANGED",
  );
});

it.each(["writer", "verifier", "repair"])(
  "rejects reuse of a parent %s request hash despite matching child policy and attempt metadata",
  async (source) => {
    const s = await childFixture();
    const request = await preparedVerifier(s);
    const historical =
      source === "writer"
        ? s.usage
        : s.historicalVerificationUsage[source === "verifier" ? 0 : 3];
    request.args.input_hash = historical.input_hash;
    request.args.call_key = `${request.phase}:${historical.input_hash.slice(0, 16)}:${s.child.job.attempts}:${s.model.id}`;
    await f.db.query(
      "update public.model_attempts set execution_metadata=jsonb_set(execution_metadata,'{input_hash}',to_jsonb($2::text)) where id=$1",
      [request.attemptId, historical.input_hash],
    );
    await deniedUnchanged(
      s,
      () => s.rpc("reserve_task_model_call", request.args),
      "MODEL_RECHECK_IDENTITY_CHANGED",
    );
  },
);

it("cannot create a writer allowance, replace the retained candidate, or downgrade its verifier pin", async () => {
  const s = await childFixture();
  for (const unit of [
    undefined,
    "writer",
    "writer-repair",
    `verifier-${"f".repeat(64)}`,
    `verifier-repair-${"f".repeat(64)}`,
  ]) {
    const payload = unit === undefined ? {} : { unit };
    await deniedUnchanged(
      s,
      () => s.child.store.action("candidate_budget", payload),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
    await deniedUnchanged(
      s,
      () =>
        s.child.store.action("candidate_received", {
          ...payload,
          usage_id: s.usage.id,
        }),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
  }
  for (const payload of [
    { key: "candidate-1", value: s.candidate.value },
    {
      key: "candidate-0",
      value: {
        ...s.candidate.value,
        result: {
          ...s.candidate.value.result,
          summary: "Changed writer result.",
        },
      },
    },
    {
      key: "accepted",
      value: { ...s.candidate.value.result, summary: "Changed writer result." },
    },
  ])
    await deniedUnchanged(
      s,
      () => s.child.store.action("result_put", payload),
      "MODEL_RECHECK_WRITER_FORBIDDEN",
    );
  await deniedUnchanged(
    s,
    () =>
      s.child.store.action("result_put", {
        key: "verification-instructions-" + "a".repeat(64),
        value: { version: 2 },
      }),
    "MODEL_RECHECK_IDENTITY_CHANGED",
  );
  await deniedUnchanged(
    s,
    () => s.child.store.action("delete"),
    "MODEL_RECHECK_WRITER_FORBIDDEN",
  );
});

it.each([
  "marker-missing",
  "marker-candidate-changed",
  "lineage-missing",
  "owner-demoted",
  "owner-inactive",
  "allowlist-inactive",
])(
  "fails closed after %s before allowing any new verifier attempt",
  async (reason) => {
    const s = await childFixture();
    await verifierRoute(s);
    if (reason === "marker-missing")
      await f.db.query(
        "update public.jobs set checkpoint=checkpoint-'verifier_recheck' where id=$1",
        [s.child.job.id],
      );
    if (reason === "marker-candidate-changed")
      await f.db.query(
        "update public.jobs set checkpoint=jsonb_set(checkpoint,'{verifier_recheck,candidate_hash}',to_jsonb(repeat('f',64))) where id=$1",
        [s.child.job.id],
      );
    if (reason === "lineage-missing")
      await f.db.query(
        "delete from app_private.analysis_verifier_rechecks where child_job_id=$1",
        [s.child.job.id],
      );
    if (reason === "owner-demoted")
      await f.db.query(
        "update public.memberships set role='Editor' where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    if (reason === "owner-inactive")
      await f.db.query(
        "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    if (reason === "allowlist-inactive")
      await f.db.query(
        "update public.identity_allowlist set status='inactive' where workspace_id=$1 and user_id=$2",
        [f.w, f.owner],
      );
    await deniedUnchanged(
      s,
      () =>
        s.rpc("start_task_model_attempt", {
          ...identity(s),
          ...target(s),
          operation_name: "verify_grounding",
        }),
      reason.startsWith("owner-") || reason === "allowlist-inactive"
        ? "ROLE_FORBIDDEN"
        : "MODEL_RECHECK_IDENTITY_CHANGED",
    );
  },
);

it.each([
  ["verifier", 3],
  ["verifier-repair", 1],
] as const)(
  "limits %s to %i paid candidates and preserves duplicate receipts",
  async (kind, cap) => {
    const s = await childFixture();
    const unit = `${kind}-${s.candidateHash}`;
    const phase = `${s.child.prefix}:${kind === "verifier" ? "verification" : "verification-repair"}-${s.candidateHash}`;
    const ids: string[] = [];
    for (let index = 0; index <= cap; index++) {
      const usage = (
        await f.db.query<any>(
          `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
      application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,
      state,graph_candidate_recorded,connection_id,model_config_id,execution_metadata,created_by,remote_project_ref)
      select workspace_id,$2,$3,$4,provider,model,input_hash,application_day,settings_revision,
      reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,'settled',false,
      connection_id,model_config_id,jsonb_build_object('graph_thread',$5::text),created_by,remote_project_ref
      from public.provider_usage where id=$1 returning id`,
          [
            s.usage.id,
            s.child.job.id,
            s.child.job.lease_token,
            `${phase}:${s.writerHash.slice(0, 16)}:${index + 1}:${s.model.id}`,
            s.child.threadId,
          ],
        )
      ).rows[0];
      ids.push(usage.id);
    }
    for (let index = 0; index < cap; index++) {
      expect(
        await s.child.store.action("candidate_budget", { unit }),
      ).toMatchObject({ count: index });
      expect(
        await s.child.store.action("candidate_received", {
          unit,
          usage_id: ids[index],
        }),
      ).toMatchObject({ count: index + 1 });
    }
    await deniedUnchanged(
      s,
      () => s.child.store.action("candidate_budget", { unit }),
      "MODEL_CORRECTION_EXHAUSTED",
    );
    await verifierRoute(s);
    const inputHash = "d".repeat(64);
    await deniedUnchanged(
      s,
      () =>
        s.rpc("reserve_task_model_call", {
          ...identity(s),
          ...target(s),
          input_hash: inputHash,
          call_key: `${phase}:${inputHash.slice(0, 16)}:${s.child.job.attempts}:${s.model.id}`,
          manifest: [],
          input_tokens: 10,
          output_tokens: 1024,
        }),
      "MODEL_CORRECTION_EXHAUSTED",
    );
    await deniedUnchanged(
      s,
      () =>
        s.child.store.action("candidate_received", {
          unit,
          usage_id: ids[cap],
        }),
      "MODEL_CORRECTION_EXHAUSTED",
    );
    const before = await s.snapshot();
    expect(
      await s.child.store.action("candidate_received", {
        unit,
        usage_id: ids[0],
      }),
    ).toMatchObject({ count: cap });
    expect(await s.snapshot()).toEqual(before);
    expect(
      (
        await f.db.query<any>(
          "select candidate_count from app_private.model_graph_threads where id=$1",
          [s.child.threadId],
        )
      ).rows[0].candidate_count,
    ).toBe(0);
    expect(
      (
        await f.db.query<any>(
          "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
          [s.child.threadId],
        )
      ).rows,
    ).toEqual([]);
  },
);
