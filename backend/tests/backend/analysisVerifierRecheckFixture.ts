import {
  workflowFixture,
  claimModelWorker5,
  historicalGenerationCommand,
} from "./workflowFixture";
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import { ModelGraphStore } from "../../supabase/functions/_shared/modelGraphStore";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { taskInput } from "../../supabase/functions/_shared/generation";
import { VERIFICATION_INSTRUCTIONS_V2 } from "../../supabase/functions/_shared/modelVerificationInstructions";
import { semanticPolicyText } from "../../supabase/functions/_shared/modelSemanticInstructions";

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
export function recheckHelpers(f: Fixture) {
  async function attempt<T>(run: () => Promise<T>): Promise<T> {
    await f.db.exec("savepoint recheck_expected_attempt");
    try {
      return await run();
    } catch (error) {
      await f.db.exec("rollback to savepoint recheck_expected_attempt");
      throw error;
    } finally {
      await f.db.exec("release savepoint recheck_expected_attempt");
    }
  }
  async function rpc(name: string, args: Record<string, any> = {}) {
    return attempt(async () => {
      await f.db.exec("set local role service_role");
      try {
        const entries = Object.entries(args);
        return (
          await f.db.query<any>(
            `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) value`,
            entries.map(([, value]) =>
              value && typeof value === "object"
                ? JSON.stringify(value)
                : value,
            ),
          )
        ).rows[0]?.value;
      } finally {
        await f.db.exec("reset role").catch(() => {});
      }
    });
  }
  async function recheck(
    payload: Record<string, any>,
    key = crypto.randomUUID(),
  ) {
    return attempt(
      async () =>
        (
          await f.db.query<any>(
            "select app_private.recheck_analysis_verifier($1::jsonb,$2) value",
            [JSON.stringify(payload), key],
          )
        ).rows[0].value,
    );
  }
  async function row(table: string, id: string) {
    return (await f.db.query<any>(`select * from ${table} where id=$1`, [id]))
      .rows[0];
  }
  async function snapshot() {
    const tables = [
      "public.generation_plans",
      "public.generation_steps",
      "public.jobs",
      "public.proposals",
      "public.proposal_versions",
      "public.provider_usage",
      "public.model_attempts",
      "public.audit_events",
      "public.documents",
      "public.document_blocks",
      "public.document_packages",
      "public.opportunities",
      "public.content_authorizations",
      "app_private.model_graph_threads",
      "app_private.model_graph_results",
      "app_private.model_graph_budgets",
      "app_private.model_graph_checkpoints",
      "app_private.model_graph_writes",
      "app_private.generation_processing_requests",
      "app_private.analysis_verifier_rechecks",
      "app_private.idempotency_records",
    ];
    const result: Record<string, string[]> = {};
    for (const table of tables)
      result[table] = (
        await f.db.query<{ value: string }>(
          `select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`,
        )
      ).rows.map((r) => r.value);
    return result;
  }
  return { attempt, rpc, recheck, row, snapshot };
}

/** All state is synthetic and local to the fully migrated PGlite database. */
export async function createRecheckFixture(
  f: Fixture,
  options: { historicalDeliveryContract?: boolean } = {},
) {
  const h = recheckHelpers(f);
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await f.command("model.connection.save", {
    provider: "qwencloud",
    label: "Synthetic verifier account",
    credential_alias: "APP_MODEL_QWEN_KEY",
    project_ref: "ap-southeast-1",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic verifier",
    model: "fixture-model",
    enabled: true,
    capabilities: defaultCapabilities("qwencloud"),
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
  const source = await f.command("source.create", {
    name: "Synthetic recheck source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic reference-backed draft",
    decision: "shortlisted",
    language: "en",
    description:
      "Prepare a draft approach using the available reference material.",
  });
  const sourceText =
    "This historical case study describes work for another buyer. It is reference material, not a procurement request from the current buyer.";
  const upload = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic-reference.txt",
    mime_type: "text/plain",
    size: sourceText.length,
    hash: "a".repeat(64),
  });
  const document = await f.rpc("accept_uploaded_document", [
    upload.id,
    f.owner,
    "a".repeat(64),
    sourceText.length,
    sourceText,
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: document.id,
    expected_revision: document.revision,
  });
  const originalPlan = await historicalGenerationCommand(
    f,
    "proposal.generate",
    {
      id: opportunity.id,
      expected_revision: opportunity.revision,
    },
  );
  if (options.historicalDeliveryContract) {
    // Synthetic historical setup happens BEFORE any model receipt, graph result,
    // or accepted sibling. It represents the source-aware contract before the
    // consistency/generated-delivery additions, never a rewrite of paid history.
    await f.db.query(
      `update public.generation_plans set frozen_context=frozen_context-array['generated_delivery_version','proposal_consistency_version'] where id=$1`,
      [originalPlan.id],
    );
    await f.db.query(
      `update public.generation_plans set input_hash=encode(sha256(convert_to(frozen_context::text,'UTF8')),'hex') where id=$1`,
      [originalPlan.id],
    );
    await f.db.query(
      `update public.jobs j set input_hash=p.input_hash from public.generation_plans p where p.id=$1 and j.entity_id=p.id`,
      [originalPlan.id],
    );
  }
  await f.db.query(
    "select app_private.enqueue_generation(p,s.task,s.input) from public.generation_plans p join public.generation_steps s on s.plan_id=p.id where p.id=$1 order by s.ordinal limit 1",
    [originalPlan.id],
  );
  const sibling = await claimModelWorker5(f, h.rpc);
  const siblingContext = await h.rpc("generation_context", {
    job_id: sibling.id,
    lease: sibling.lease_token,
  });
  const siblingInput = taskInput(siblingContext);
  const candidate = {
    processed_block_ids: siblingInput.requiredIds,
    requirements: [],
    questions: [],
    separate_volumes: false,
    summary:
      "The supplied segment is a historical reference and contains no current buyer requirements.",
  };
  await h.rpc("complete_generation_step", {
    job_id: sibling.id,
    lease: sibling.lease_token,
    result: candidate,
  });
  const parent = await claimModelWorker5(f, h.rpc);
  const context = await h.rpc("generation_context", {
    job_id: parent.id,
    lease: parent.lease_token,
  });
  const input = taskInput(context);
  await h.rpc("prepare_task_model_route", {
    job_id: parent.id,
    lease: parent.lease_token,
    task_name: "analyze_chunk",
    default_profile: taskRegistry.analyze_chunk.profile,
  });
  const prefix = `step:${context.step.id}`;
  const inputHash = await sha256(
    JSON.stringify({
      version: 1,
      task: input.task,
      context: input.context,
      evidence: input.evidence,
      requiredIds: input.requiredIds,
      manifest: input.manifest,
      language: "en",
    }),
  );
  const threadId = await sha256(`${parent.id}:${prefix}:${inputHash}`);
  const store = new ModelGraphStore({ internal: h.rpc }, parent, threadId);
  await store.action("init", {
    input_hash: inputHash,
    task: "analyze_chunk",
    graph_version: 1,
    budget_version: 2,
  });
  const producer = {
    provider: "qwencloud",
    model: model.model,
    project: connection.project_ref,
    connectionId: connection.id,
    modelId: model.id,
  };
  const saved = await store.action("result_put", {
    key: "candidate-0",
    value: { result: candidate, producer },
  });
  const candidateHash = await sha256(JSON.stringify(saved.value.result));
  const writerPrompt = modelPrompt(
    "analyze_chunk",
    input.context,
    input.evidence,
    input.requiredIds,
    "en",
    false,
    1,
    4,
  );
  const writerHash = await sha256(writerPrompt);
  const writerPromptVersion = JSON.parse(writerPrompt).prompt_version;
  const usage = (
    await f.db.query<any>(
      `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
      application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,
      state,graph_candidate_recorded,connection_id,model_config_id,execution_metadata,created_by,remote_project_ref)
      values($1,$2,$3,$4,'qwencloud',$5,$6,current_date,1,100,50,80,40,0,'settled',true,$7,$8,$9,$10,'ap-southeast-1') returning *`,
      [
        f.w,
        parent.id,
        parent.lease_token,
        `${prefix}:candidate-0:${writerHash.slice(0, 16)}:1:${model.id}`,
        model.model,
        writerHash,
        connection.id,
        model.id,
        {
          input_hash: writerHash,
          graph_thread: threadId,
          prompt_version: writerPromptVersion,
        },
        f.owner,
      ],
    )
  ).rows[0];
  await f.db.query(
    `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,
      round_number,worker_attempt,status,result_code,usage_id,sent,execution_metadata,connection_id,model_config_id,
      finished_at,http_status,request_phase) values($1,$2,$3,'qwencloud',$4,$5,'analyze_chunk',1,1,'succeeded','SUCCEEDED',$6,true,$7,$8,$9,now(),200,'generation')`,
    [
      f.w,
      parent.id,
      parent.lease_token,
      model.model,
      connection.project_ref,
      usage.id,
      {
        input_hash: writerHash,
        graph_thread: threadId,
        prompt_version: writerPromptVersion,
      },
      connection.id,
      model.id,
    ],
  );
  const report = {
    checked_candidate_hash: candidateHash,
    reviewed_all_content: true,
    processed_content_ids: candidateContent(saved.value.result).map(
      (unit) => unit.id,
    ),
    claims: [
      {
        id: "reference-summary",
        claim: candidate.summary,
        candidate_quote: candidate.summary,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: input.requiredIds[0], quote: sourceText }],
        finding: "Historical attribution is supported.",
      },
    ],
    processed_requirement_ids: input.requiredIds,
    requirement_checks: input.requiredIds.map((id) => ({
      requirement_id: id,
      status: "insufficient",
      candidate_quote: candidate.summary,
      source_refs: [{ id, quote: sourceText }],
      finding: "There are no buyer requirements to satisfy.",
    })),
    findings: [],
  };
  const retained = await store.action("result_put", {
    key: `invalid-verification-repair-${candidateHash}`,
    value: { result: report, producer },
  });
  const verificationPins = [];
  for (const phase of ["verification", "verification-repair"])
    verificationPins.push(
      await store.action("result_put", {
        key:
          "verification-instructions-" +
          (await sha256(`${prefix}:${phase}-${candidateHash}`)),
        value: {
          version: 2,
          legacy_input_hash: await sha256(
            modelPrompt(
              "verify_grounding",
              {
                original_task: "analyze_chunk",
                original_context: input.context,
                candidate_hash: candidateHash,
                content_units: candidateContent(saved.value.result),
                response_style: "compact-verification-v2",
              },
              input.evidence,
              input.requiredIds,
              "en",
              true,
            ),
          ),
          instructions: VERIFICATION_INSTRUCTIONS_V2,
        },
      }),
    );
  const historicalVerificationUsage = [];
  for (const [phase, count] of [
    ["verification", 3],
    ["verification-repair", 1],
  ] as const) {
    const hash = await sha256(`synthetic historical ${phase} ${candidateHash}`);
    for (let index = 0; index < count; index++) {
      const historicalLease = crypto.randomUUID();
      const receipt = (
        await f.db.query<any>(
          `insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
         application_day,settings_revision,reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,
         state,graph_candidate_recorded,connection_id,model_config_id,execution_metadata,created_by,remote_project_ref)
         values($1,$2,$3,$4,'qwencloud',$5,$6,current_date,1,100,50,80,40,0,'settled',true,$7,$8,$9,$10,'ap-southeast-1') returning *`,
          [
            f.w,
            parent.id,
            historicalLease,
            `${prefix}:${phase}-${candidateHash}:${hash.slice(0, 16)}:${index + 1}:${model.id}`,
            model.model,
            hash,
            connection.id,
            model.id,
            {
              input_hash: hash,
              graph_thread: threadId,
              prompt_version: "tenderdesk-grounding-v2-contiguous-quotes",
            },
            f.owner,
          ],
        )
      ).rows[0];
      historicalVerificationUsage.push(receipt);
      await f.db.query(
        `insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,
         round_number,worker_attempt,status,result_code,usage_id,sent,execution_metadata,connection_id,model_config_id,
         finished_at,http_status,request_phase) values($1,$2,$3,'qwencloud',$4,$5,'verify_grounding',$6,1,'succeeded','SUCCEEDED',$7,true,$8,$9,$10,now(),200,'generation')`,
        [
          f.w,
          parent.id,
          historicalLease,
          model.model,
          connection.project_ref,
          index + 1,
          receipt.id,
          receipt.execution_metadata,
          connection.id,
          model.id,
        ],
      );
    }
  }
  const writerPin = await store.action("result_put", {
    key: "semantic-instructions-" + (await sha256(`${prefix}:candidate-0`)),
    value: {
      version: 4,
      legacy_input_hash: await sha256(
        modelPrompt(
          "analyze_chunk",
          input.context,
          input.evidence,
          input.requiredIds,
          "en",
          false,
          1,
          0,
        ),
      ),
      instructions: semanticPolicyText(4),
    },
  });
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',1),($1,$2,3),($1,$3,1)",
    [threadId, `verifier-${candidateHash}`, `verifier-repair-${candidateHash}`],
  );
  await f.db.query(
    "update app_private.model_graph_threads set candidate_count=1 where id=$1",
    [threadId],
  );
  await store.action("put", {
    namespace: "",
    checkpoint_id: "retained-checkpoint",
    checkpoint: { type: "json", data: "e30=" },
    metadata: { type: "json", data: "e30=" },
  });
  await store.action("writes", {
    namespace: "",
    checkpoint_id: "retained-checkpoint",
    task_id: "retained-task",
    writes: [
      {
        idx: 0,
        channel: "candidateRef",
        value: { type: "json", data: "e30=" },
      },
    ],
  });
  await store.action("needs_review");
  await h.rpc("fail_generation", {
    job_id: parent.id,
    lease: parent.lease_token,
    error_code: "MODEL_CORRECTION_EXHAUSTED",
    retry_after: null,
    split_inputs: null,
  });
  const plan = await h.row("public.generation_plans", originalPlan.id);
  const parentJob = await h.row("public.jobs", parent.id);
  const step = await h.row("public.generation_steps", context.step.id);
  const payload = {
    id: parent.id,
    expected_revision: parentJob.revision,
    expected_plan_revision: plan.revision,
    expected_step_revision: step.revision,
    parent_thread_id: threadId,
    candidate_id: saved.id,
    candidate_content_hash: saved.content_hash,
    candidate_hash: candidateHash,
    writer_usage_id: usage.id,
    expected_input_hash: plan.input_hash,
    expected_graph_input_hash: inputHash,
    reason:
      "Recheck source-block semantics using the current pinned verifier policy.",
  };
  async function createChild(key = crypto.randomUUID()) {
    return h.recheck(payload, key);
  }
  async function claimChild(child: any) {
    const job = await claimModelWorker5(f, h.rpc);
    if (job.id !== child.id) throw new Error("Unexpected claimed job");
    await h.rpc("prepare_task_model_route", {
      job_id: job.id,
      lease: job.lease_token,
      task_name: "verify_grounding",
      default_profile: taskRegistry.verify_grounding.profile,
    });
    const childThread = await sha256(
      `${job.id}:step:${child.step_id}:${inputHash}`,
    );
    const childStore = new ModelGraphStore(
      { internal: h.rpc },
      job,
      childThread,
    );
    await childStore.action("init", {
      input_hash: inputHash,
      task: "analyze_chunk",
      graph_version: 1,
      budget_version: 2,
    });
    return {
      job,
      threadId: childThread,
      store: childStore,
      prefix: `step:${child.step_id}`,
    };
  }
  return {
    ...h,
    plan,
    parent: parentJob,
    step,
    sibling,
    opportunity,
    document,
    source,
    model,
    connection,
    input,
    prefix,
    inputHash,
    threadId,
    store,
    candidate: saved,
    candidateHash,
    writerHash,
    writerPromptVersion,
    writerPin,
    usage,
    retained,
    verificationPins,
    historicalVerificationUsage,
    payload,
    createChild,
    claimChild,
  };
}
