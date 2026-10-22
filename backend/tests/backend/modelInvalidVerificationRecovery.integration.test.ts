// @vitest-environment node
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { recoverInvalidVerification } from "../../supabase/functions/_shared/modelInvalidVerificationRecovery";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { verificationBatches } from "../../supabase/functions/_shared/modelVerification";
import { ModelDeferred, sha256 } from "../../supabase/functions/_shared/model";
import { executeGuardedModel } from "../../supabase/functions/_shared/modelGraph";
import {
  modelEnvironments,
  type Backend,
} from "../../supabase/functions/_shared/backend";
import { databaseError } from "../../supabase/functions/_shared/http";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const entries = Object.entries(args);
  await f.db.exec("savepoint invalid_recovery_rpc;set local role service_role");
  try {
    return (
      await f.db.query<any>(
        `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) value`,
        entries.map(([, v]) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      )
    ).rows[0]?.value;
  } catch (error) {
    await f.db.exec("rollback to savepoint invalid_recovery_rpc");
    throw databaseError(error as Error);
  } finally {
    await f.db.exec("reset role;release savepoint invalid_recovery_rpc");
  }
}
async function setup(
  batched = false,
  revalidated = false,
  graph = false,
  task: "draft_section" | "plan_commercial" = "draft_section",
) {
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await f.command("model.connection.save", {
    provider: "openai",
    label: "Synthetic account",
    credential_alias: "APP_MODEL_OPENAI_KEY",
    project_ref: "fixture-project",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic model",
    model: "fixture-model",
    enabled: true,
    capabilities: defaultCapabilities("openai"),
    expected_revision: 0,
  });
  await f.command("model.task_route.save", {
    task: "default",
    model_ids: [model.id],
    inherit_default: false,
    strategy: "priority",
    profile: null,
    expected_revision: 0,
  });
  await f.command("model.execution.configure", {
    enabled: true,
    expected_revision: 0,
  });
  await f.command("model.probe", {});
  let job = await rpc("claim_backend_job_v2");
  await rpc("prepare_task_model_route", {
    job_id: job.id,
    lease: job.lease_token,
    task_name: task,
    default_profile: taskRegistry[task].profile,
  });
  let candidate: any = {
    key: "approach",
    title: "Approach",
    content_blocks: [
      ...(batched
        ? [{ type: "paragraph", text: "Preparation activities. ".repeat(240) }]
        : []),
      {
        type: "paragraph",
        text:
          (revalidated
            ? "Section 4.2 confirms a 12 month term."
            : "The contract term is 12 months.") +
          (batched ? " Delivery activities.".repeat(200) : ""),
      },
    ],
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  if (task === "plan_commercial")
    candidate = {
      lines: [],
      questions: [],
      tasks: [
        ...(batched
          ? [
              "Preparation activities. ".repeat(120),
              "Preparation activities. ".repeat(120),
            ]
          : []),
        (revalidated
          ? "Section 4.2 confirms a 12 month term."
          : "The contract term is 12 months.") +
          (batched ? " Delivery activities.".repeat(120) : ""),
      ].map((basis, i) => ({
        key: `task-${i}`,
        title: "Delivery",
        predecessors: [],
        role: "Consultant",
        effort_days: null,
        allocation: null,
        duration_days: null,
        basis,
      })),
    };
  const evidence = [
    {
      id: "notice",
      text: revalidated
        ? "Section 4.2 confirms a 12 month term."
        : "The contract term is months.",
      kind: "notice" as const,
      verified: false,
    },
  ];
  const prefix = `step:${job.id}`;
  const inputHash = await sha256(
    JSON.stringify({
      version: 1,
      task,
      context: {},
      evidence,
      requiredIds: [],
      manifest: [],
      language: "en",
    }),
  );
  const threadId = await sha256(`${job.id}:${prefix}:${inputHash}`);
  const environments = modelEnvironments((name) =>
    name === "APP_MODEL_OPENAI_KEY" ? "synthetic-key" : undefined,
  );
  const backend = {
    internal: rpc,
    resolveModelEnvironment: (config: any) => ({
      ...environments.openai,
      model: config.model,
      projectRef: config.project_ref,
    }),
  } as unknown as Backend;
  let store = new ModelGraphStore(backend, job, threadId);
  await store.action("init", {
    input_hash: inputHash,
    task,
    graph_version: 1,
  });
  const saved = await store.action("result_put", {
    key: "candidate-0",
    value: { result: candidate, producer: null },
  });
  // JSONB gives persisted objects their canonical property order. Production
  // hashes this saved candidate; fixtures must preserve that exact identity.
  candidate = saved.value.result;
  const hash = await sha256(JSON.stringify(candidate));
  const phase = batched
    ? `verification-repair-v3-${hash}-content-1`
    : `verification-repair-${hash}`;
  const unit = batched ? `v3-${hash}-content-1` : `verifier-${hash}`;
  const repairUnit = batched ? `${unit}-repair` : `verifier-repair-${hash}`;
  const units = batched
    ? verificationBatches(candidate)[1]
    : candidateContent(candidate);
  const report = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((u) => u.id),
    claims: [
      {
        id: "claim",
        claim: revalidated
          ? evidence[0].text
          : "The contract term is 12 months.",
        candidate_quote: revalidated
          ? evidence[0].text
          : "The contract term is 12 months.",
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "notice", quote: evidence[0].text }],
        finding: "Reported support.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: revalidated
      ? []
      : [
          {
            severity: "blocking",
            code: "MODALITY",
            detail: "Latest untrusted semantic finding.",
            claim_ids: ["claim"],
            requirement_ids: [],
          },
        ],
  };
  const older = await store.action("result_put", {
    key: `invalid-${phase}`,
    value: {
      result: { ...report, findings: [] },
      code: "EVIDENCE_REFERENCE_INVALID",
      producer: null,
    },
  });
  await f.db.query(
    "update app_private.model_graph_results set created_at=now()-interval '1 minute' where id=$1",
    [older.id],
  );
  const retained = await store.action("result_put", {
    key: "invalid-report-" + "a".repeat(64),
    value: {
      verification_key: phase,
      result: report,
      code: "EVIDENCE_REFERENCE_INVALID",
      producer: null,
    },
  });
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',1),($1,$2,3),($1,$3,1)",
    [threadId, unit, repairUnit],
  );
  await f.db.query(
    "update app_private.model_graph_threads set candidate_count=1 where id=$1",
    [threadId],
  );
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error("Recovery must not call a provider");
  });
  const runtimeOptions = {
    backend,
    job,
    prefix,
    task,
    context: {},
    evidence,
    requiredIds: [] as string[],
    manifest: [],
    environments,
    language: "en" as const,
    repair: true,
    fetcher,
  };
  if (graph) {
    // Run the actual graph's cached producer to persist its real verify
    // frontier, then release/reclaim through canonical queue RPCs.
    await expect(executeGuardedModel(runtimeOptions)).rejects.toBeInstanceOf(
      ModelDeferred,
    );
    expect(fetcher).not.toHaveBeenCalled();
    job = await rpc("claim_backend_job_v2");
    runtimeOptions.job = job;
    store = new ModelGraphStore(backend, job, threadId);
  }
  await store.action("needs_review");
  const usage = (
    await f.db.query<any>(
      "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by,state) values($1,$2,$3,'historical-paid','openai','fixture-model',$4,current_date,1,1,1,$5,'settled') returning *",
      [f.w, job.id, job.lease_token, hash, f.owner],
    )
  ).rows[0];
  const payload = {
    candidate_id: saved.id,
    candidate_hash: hash,
    repair_count: 0,
    manifest: [],
  };
  const update = vi.fn(async (_values: { reportRef: string }) => {});
  const options = {
    task,
    backend,
    store,
    job,
    evidence,
    requiredIds: [],
    manifest: [],
    state: {
      next: ["verify"],
      values: { candidateRef: saved.id, repairCount: 0 },
    },
    update,
  };
  return {
    job,
    store,
    threadId,
    candidate,
    hash,
    report,
    retained,
    older,
    phase,
    unit,
    repairUnit,
    usage,
    payload,
    options,
    update,
    runtimeOptions,
    fetcher,
    saved,
    inputHash,
  };
}

it.each([false, true])(
  "reopens only bounded repair with latest immutable findings and unchanged usage/budgets, batched=%s",
  async (batched) => {
    const s = await setup(batched);
    const before = (
      await f.db.query(
        "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
        [s.threadId],
      )
    ).rows;
    expect(await recoverInvalidVerification(s.options)).toBe(true);
    const artifact = (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where id=$1",
        [s.update.mock.calls[0][0].reportRef],
      )
    ).rows[0].value;
    expect(artifact.untrusted_report).toEqual(s.report);
    expect(artifact.recovery_provenance.report_ref).toBe(s.retained.id);
    expect(artifact.result.reviewed_all_content).toBe(false);
    expect(artifact.coverage).toBe("repair_only");
    expect(
      (
        await f.db.query<any>(
          "select status,candidate_count,result_id from app_private.model_graph_threads where id=$1",
          [s.threadId],
        )
      ).rows[0],
    ).toEqual({ status: "running", candidate_count: 1, result_id: null });
    expect(
      (
        await f.db.query(
          "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 order by unit",
          [s.threadId],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await f.db.query<any>(
          "select * from public.provider_usage where id=$1",
          [s.usage.id],
        )
      ).rows[0],
    ).toEqual(s.usage);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from app_private.model_graph_results where thread_id=$1 and result_key='accepted'",
          [s.threadId],
        )
      ).rows[0].n,
    ).toBe(0);
  },
);

it.each([
  { batched: false, task: "draft_section" as const },
  { batched: true, task: "draft_section" as const },
  { batched: false, task: "plan_commercial" as const },
  { batched: true, task: "plan_commercial" as const },
])(
  "revalidates the exact historical decimal-label report with zero provider calls, task=$task batched=$batched",
  async ({ batched, task }) => {
    const s = await setup(batched, true, true, task);
    const budgetsBefore = (
      await f.db.query(
        "select * from app_private.model_graph_budgets where thread_id=$1 order by unit",
        [s.threadId],
      )
    ).rows;
    if (batched) {
      // Every other scope was already paid for and validated. Only content-1
      // is reopened; it cannot stand in for complete candidate verification.
      const batches = verificationBatches(s.candidate);
      for (const [index, units] of batches.entries()) {
        if (index === 1) continue;
        await s.store.action("result_put", {
          key: `verification-v3-${s.hash}-content-${index}`,
          value: {
            result: {
              ...s.report,
              processed_content_ids: units.map((unit) => unit.id),
              claims: [
                {
                  id: `claim-${index}`,
                  claim: "Preparation activities.",
                  candidate_quote: "Preparation activities.",
                  kind: "assumption",
                  status: "supported",
                  source_refs: [],
                  finding: "Proposed preparation.",
                },
              ],
            },
            producer: null,
          },
        });
      }
      await s.store.action("result_put", {
        key: `verification-v3-${s.hash}-requirements`,
        value: {
          result: {
            ...s.report,
            processed_content_ids: candidateContent(s.candidate).map(
              (unit) => unit.id,
            ),
            claims: [],
          },
          producer: null,
        },
      });
    }
    const originalsBefore = (
      await f.db.query(
        "select * from app_private.model_graph_results where id=any($1::uuid[]) order by id",
        [[s.saved.id, s.older.id, s.retained.id]],
      )
    ).rows;
    const accepted = await executeGuardedModel(s.runtimeOptions);
    expect(accepted.result).toEqual(s.candidate);
    expect(s.fetcher).not.toHaveBeenCalled();
    const replay = await s.store.action("result_get", {
      key: `invalid-verification-revalidated-${s.saved.id}-${s.retained.id}`,
    });
    expect(replay.value.coverage).toBe("revalidated_scope");
    expect(replay.value.result).toEqual(s.report);
    expect(replay.value.recovery_provenance).toMatchObject({
      input_hash: s.inputHash,
      verification_key: s.phase,
      report_ref: s.retained.id,
      new_provider_requests: 0,
    });
    expect(
      (
        await s.store.action("result_get", {
          key: s.phase.replace("verification-repair-", "verification-"),
        })
      ).value.result,
    ).toEqual(s.report);
    const complete = await s.store.action("result_get", {
      key: `verification-${s.hash}`,
    });
    expect(complete.value.result.processed_content_ids).toHaveLength(
      candidateContent(s.candidate).length,
    );
    if (batched)
      expect(
        complete.value.result.processed_content_ids.length,
      ).toBeGreaterThan(s.report.processed_content_ids.length);
    expect(
      (
        await f.db.query(
          "select * from app_private.model_graph_budgets where thread_id=$1 order by unit",
          [s.threadId],
        )
      ).rows,
    ).toEqual(budgetsBefore);
    expect(
      (
        await f.db.query("select * from public.provider_usage where id=$1", [
          s.usage.id,
        ])
      ).rows[0],
    ).toEqual(s.usage);
    expect(
      (
        await f.db.query(
          "select * from app_private.model_graph_results where id=any($1::uuid[]) order by id",
          [[s.saved.id, s.older.id, s.retained.id]],
        )
      ).rows,
    ).toEqual(originalsBefore);
    expect((await executeGuardedModel(s.runtimeOptions)).result).toEqual(
      s.candidate,
    );
    expect(s.fetcher).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "replays immutable recovery after a checkpoint crash without resetting counters, valid=%s",
  async (revalidated) => {
    const s = await setup(true, revalidated);
    s.update.mockRejectedValueOnce(Error("checkpoint crash"));
    await expect(recoverInvalidVerification(s.options)).rejects.toThrow(
      "checkpoint crash",
    );
    expect(
      (
        await f.db.query<any>(
          "select status from app_private.model_graph_threads where id=$1",
          [s.threadId],
        )
      ).rows[0].status,
    ).toBe("needs_review");
    expect(await recoverInvalidVerification(s.options)).toBe(true);
    const rows = (
      await f.db.query<any>(
        "select * from app_private.model_graph_results where thread_id=$1 and value ? 'recovery_provenance'",
        [s.threadId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].value.recovery_provenance.report_ref).toBe(s.retained.id);
    expect(
      (
        await f.db.query<any>(
          "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
          [s.threadId],
        )
      ).rows[0].candidates,
    ).toBe(1);
  },
);

it("routes the latest invalid scoped report through one bounded writer repair and independent verification in real LangGraph", async () => {
  const s = await setup(true, false, true);
  const repaired = {
    ...s.candidate,
    content_blocks: [
      {
        type: "paragraph",
        text: "The contract term requires buyer confirmation.",
      },
    ],
  };
  const requests: string[] = [];
  s.fetcher.mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const prompt = JSON.parse(
      JSON.parse(String(init?.body)).input.split("\nJSON schema: ")[0],
    );
    requests.push(prompt.task);
    const context = prompt.untrusted_data;
    let result;
    if (prompt.task === "repair_result") {
      expect(context.untrusted_verification_report).toEqual(s.report);
      expect(context.validation_diagnostics[0].reason).toBe(
        "numeric_evidence_mismatch",
      );
      expect(context.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "UNRESOLVED_VALIDATION" }),
        ]),
      );
      result = {
        target_task: "draft_section",
        result: repaired,
        changes: [
          "Explicitly request confirmation of the unsupported contract term.",
        ],
      };
    } else {
      expect(prompt.task).toBe("verify_grounding");
      expect(context.candidate_hash).not.toBe(s.hash);
      result = {
        checked_candidate_hash: context.candidate_hash,
        reviewed_all_content: true,
        processed_content_ids: context.content_units.map(
          (unit: any) => unit.id,
        ),
        claims: [
          {
            id: "claim",
            claim: repaired.content_blocks[0].text,
            candidate_quote: repaired.content_blocks[0].text,
            kind: "assumption",
            status: "insufficient",
            source_refs: [],
            finding: "Buyer confirmation is explicitly requested.",
          },
        ],
        processed_requirement_ids: [],
        requirement_checks: [],
        findings: [],
      };
    }
    return Response.json({
      id: `resp_fixture_${requests.length}`,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(result) }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  });
  await expect(executeGuardedModel(s.runtimeOptions)).rejects.toBeInstanceOf(
    ModelDeferred,
  );
  expect(requests).toEqual(["repair_result"]);
  expect(
    (
      await f.db.query<any>(
        "select candidates from app_private.model_graph_budgets where thread_id=$1 and unit='writer'",
        [s.threadId],
      )
    ).rows[0].candidates,
  ).toBe(2);
  expect(
    (
      await f.db.query<any>(
        "select result_key from app_private.model_graph_results where thread_id=$1 and result_key in ($2,$3,'accepted')",
        [
          s.threadId,
          `verification-${s.hash}`,
          s.phase.replace("verification-repair-", "verification-"),
        ],
      )
    ).rows,
  ).toEqual([]);
  s.runtimeOptions.job = await rpc("claim_backend_job_v2");
  expect((await executeGuardedModel(s.runtimeOptions)).result).toEqual(
    repaired,
  );
  expect(requests).toEqual(["repair_result", "verify_grounding"]);
  expect(
    (
      await f.db.query<any>(
        "select unit,candidates from app_private.model_graph_budgets where thread_id=$1 and unit=any($2::text[]) order by unit",
        [s.threadId, [s.unit, s.repairUnit]],
      )
    ).rows,
  ).toEqual([
    { unit: s.unit, candidates: 3 },
    { unit: s.repairUnit, candidates: 1 },
  ]);
  expect(
    (
      await f.db.query("select * from public.provider_usage where id=$1", [
        s.usage.id,
      ])
    ).rows[0],
  ).toEqual(s.usage);
  expect(
    (
      await f.db.query<any>(
        "select value from app_private.model_graph_results where id=$1",
        [s.retained.id],
      )
    ).rows[0].value.result,
  ).toEqual(s.report);
});

it.each([
  "writer-exhausted",
  "original-not-exhausted",
  "corrective-not-exhausted",
  "reserved",
  "unknown",
  "saved-round",
  "accepted",
  "different-candidate",
  "wrong-hash",
  "candidate-successor",
  "current-report-cached",
  "ambiguous-latest",
])(
  "keeps %s in needs_review without changing any allowance",
  async (reason) => {
    const s = await setup();
    if (reason === "writer-exhausted") {
      await f.db.query(
        "update app_private.model_graph_budgets set candidates=3 where thread_id=$1 and unit='writer'",
        [s.threadId],
      );
      await f.db.query(
        "update app_private.model_graph_threads set candidate_count=3 where id=$1",
        [s.threadId],
      );
    }
    if (reason === "original-not-exhausted")
      await f.db.query(
        "update app_private.model_graph_budgets set candidates=2 where thread_id=$1 and unit=$2",
        [s.threadId, s.unit],
      );
    if (reason === "corrective-not-exhausted")
      await f.db.query(
        "delete from app_private.model_graph_budgets where thread_id=$1 and unit=$2",
        [s.threadId, s.repairUnit],
      );
    if (reason === "reserved" || reason === "unknown")
      await f.db.query(
        "update public.provider_usage set state=$2 where id=$1",
        [s.usage.id, reason],
      );
    if (reason === "saved-round")
      await f.db.query(
        "update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_round}','{}') where id=$1",
        [s.job.id],
      );
    if (reason === "accepted")
      await s.store.action("result_put", {
        key: "accepted",
        value: s.candidate,
      });
    if (reason === "different-candidate")
      s.payload.candidate_id = crypto.randomUUID();
    if (reason === "wrong-hash") s.payload.candidate_hash = "f".repeat(64);
    if (reason === "candidate-successor")
      await s.store.action("result_put", {
        key: "candidate-1",
        value: { result: s.candidate },
      });
    if (reason === "current-report-cached")
      await s.store.action("result_put", {
        key: s.phase.replace("verification-repair-", "verification-"),
        value: { result: s.report },
      });
    if (reason === "ambiguous-latest")
      await s.store.action("result_put", {
        key: "invalid-report-" + "b".repeat(64),
        value: {
          verification_key: s.phase,
          result: { ...s.report, findings: [] },
          code: "EVIDENCE_REFERENCE_INVALID",
          producer: null,
        },
      });
    expect(
      await s.store.action("invalid_verification_repair_candidate", s.payload),
    ).toBeNull();
    expect(
      (
        await f.db.query<any>(
          "select status from app_private.model_graph_threads where id=$1",
          [s.threadId],
        )
      ).rows[0].status,
    ).toBe("needs_review");
  },
);

it("fails closed on a newer invalid report instead of reusing the older favorable report", async () => {
  const s = await setup();
  const newer = await s.store.action("result_put", {
    key: "invalid-report-" + "c".repeat(64),
    value: {
      verification_key: s.phase,
      result: { ...s.report, checked_candidate_hash: "f".repeat(64) },
      code: "EVIDENCE_REFERENCE_INVALID",
      producer: null,
    },
  });
  await f.db.query(
    "update app_private.model_graph_results set created_at=now()+interval '1 second' where id=$1",
    [newer.id],
  );
  expect(await recoverInvalidVerification(s.options)).toBe(false);
  expect(s.update).not.toHaveBeenCalled();
});

it("does not grant authenticated or service clients direct private-helper execution", async () => {
  expect(
    (
      await f.db.query<any>(
        "select has_function_privilege('authenticated','app_private.invalid_verification_repair(uuid,uuid,text,text,jsonb)','execute') as auth,has_function_privilege('service_role','app_private.invalid_verification_repair(uuid,uuid,text,text,jsonb)','execute') as service",
      )
    ).rows[0],
  ).toEqual({ auth: false, service: false });
});

it.each(["cancel", "stale-lease", "missing-evidence"])(
  "rejects %s through current server guards",
  async (reason) => {
    const s = await setup();
    if (reason === "cancel")
      await f.db.query(
        "update public.jobs set cancel_requested=true where id=$1",
        [s.job.id],
      );
    if (reason === "stale-lease") s.job.lease_token = crypto.randomUUID();
    if (reason === "missing-evidence")
      (s.payload.manifest as any[]).push({
        entity_kind: "document",
        entity_id: crypto.randomUUID(),
        content_hash: "a".repeat(64),
      });
    await expect(
      s.store.action("invalid_verification_repair_candidate", s.payload),
    ).rejects.toThrow();
  },
);

it("does not grant a commercial writer repair when the retained report is still invalid", async () => {
  const s = await setup(false, false, false, "plan_commercial");
  expect(await recoverInvalidVerification(s.options)).toBe(false);
  expect(s.update).not.toHaveBeenCalled();
  expect(s.fetcher).not.toHaveBeenCalled();
  const state = await f.db.query<any>(
    "select status,candidate_count from app_private.model_graph_threads where id=$1",
    [s.threadId],
  );
  expect(state.rows[0]).toEqual({ status: "needs_review", candidate_count: 1 });
});

it("rejects repair-only artifacts for non-draft tasks at the SQL resume boundary", async () => {
  const s = await setup();
  expect(await recoverInvalidVerification(s.options)).toBe(true);
  const artifactId = s.update.mock.calls[0][0].reportRef;
  await f.db.query(
    "update app_private.model_graph_threads set status='needs_review',task='plan_commercial' where id=$1",
    [s.threadId],
  );
  expect(
    await s.store.action("invalid_verification_repair_resume", {
      ...s.payload,
      report_id: s.retained.id,
      artifact_id: artifactId,
    }),
  ).toBe(false);
  expect(
    (
      await f.db.query<any>(
        "select status,candidate_count from app_private.model_graph_threads where id=$1",
        [s.threadId],
      )
    ).rows[0],
  ).toEqual({ status: "needs_review", candidate_count: 1 });
});
