import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { workflowFixture } from "./workflowFixture.ts";
import { modelGraphCheckpointFixture } from "./modelGraphCheckpointFixture.ts";
import {
  taskInput,
  nextStage,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import { materializeSourceCandidate } from "../../supabase/functions/_shared/sourceEvidence.ts";
import {
  candidateContent,
  validateGroundingReport,
  groundingOptions,
} from "../../supabase/functions/_shared/modelGrounding.ts";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency.ts";
import { assessGeneratedDelivery } from "../../supabase/functions/_shared/generatedProposalConsistency.ts";
import { buildGeneratedPayload } from "../../supabase/functions/_shared/generatedDeliveryWorker.ts";
import { processDeliveryExport } from "../../supabase/functions/_shared/deliveryWorker.ts";
import { buildDeliveryExport } from "../../supabase/functions/_shared/deliveryExport.ts";
import { verifyExportDocx } from "../../supabase/functions/_shared/export.ts";
import { renderDocx } from "../../../frontend/src/lib/renderDocx.ts";
import { unzipSync, strFromU8 } from "fflate";

let f: Awaited<ReturnType<typeof workflowFixture>>;
let analysisContext: any,
  analysisOutput: any,
  frozen: any,
  requirements: any[],
  superseded: any,
  current: any,
  opportunity: any,
  proposal: any;
const observations: Record<string, any> = {
  scope:
    "Offline synthetic fault injection. No provider inference, semantic pass, production admission or final approval claim.",
};
const initialText =
  "Supplier shall deliver 9 observation terminals. Supplier shall deliver 3 relay cabinets.";
const replacementText =
  "Addendum C: Supplier shall deliver 14 observation terminals. The requirement for 3 relay cabinets remains unchanged.";
const tuple = (value: string, unit: string) => ({
  modality: "required",
  actor: "supplier",
  negated: false,
  conditions: [],
  exceptions: [],
  consequences: [],
  quantities: [{ value, unit, currency: null }],
  dates: [],
});
const row = async (sql: string, args: any[] = []) =>
  (await f.db.query<any>(sql, args)).rows[0];
async function attempt(fn: () => Promise<any>) {
  await f.db.exec("savepoint expected");
  try {
    return await fn();
  } catch (e) {
    await f.db.exec("rollback to savepoint expected");
    throw e;
  } finally {
    await f.db.exec("release savepoint expected");
  }
}
async function upload(text: string, hash: string) {
  const d = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 100,
    hash,
  });
  const accepted = await f.rpc("accept_uploaded_document", [
    d.id,
    f.owner,
    hash,
    100,
    text,
    "ready",
    crypto.randomUUID(),
  ]);
  await f.command("document.confirm", {
    id: accepted.id,
    expected_revision: accepted.revision,
  });
  return d;
}
async function authority(source: any, more = {}) {
  return f.command("source.authority.review", {
    opportunity_id: opportunity.id,
    entity_kind: source.reference.entity_kind,
    entity_id: source.reference.entity_id,
    content_hash: source.reference.content_hash,
    expected_revision: source.authority.revision,
    role: "buyer_rfp",
    status: "confirmed",
    supersedes: null,
    precedence: 0,
    reason: "Offline typed authority regression",
    ...more,
  });
}
async function exactSpan(source: any, quote: string) {
  const start = source.text.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  return (
    await row(
      "select app_private.source_span_from_block($1::jsonb,$2,$3) value",
      [JSON.stringify(source), start, start + quote.length],
    )
  ).value;
}
async function review(span: any, semantics: any, more = {}) {
  return f.command("source.obligation.review", {
    opportunity_id: opportunity.id,
    review_id: null,
    expected_revision: 0,
    spans: [span],
    semantics,
    status: "confirmed",
    reason: "Offline exact clause interpretation",
    ...more,
  });
}
async function inventory(ids: string[]) {
  return (
    await row(
      "select app_private.source_obligation_inventory($1,$2,$3::uuid[]) value",
      [f.w, opportunity.id, ids],
    )
  ).value;
}
function candidate(span: any, semantics: any) {
  return {
    text: span.quote,
    category: "functional",
    mandatory: true,
    source_refs: [{ id: span.id, quote: span.quote }],
    interpretation: `Supplier will deliver ${semantics.quantities[0].value} ${semantics.quantities[0].unit}.`,
    acceptance_evidence:
      "Buyer witnesses item count and operational acceptance.",
    owner_question: null,
    source_semantics: {
      ...semantics,
      version: 1,
      source_span_ids: [span.id],
      authority_role: span.authority.role,
      authority_status: span.authority.status,
      review_status: "pending",
      review_id: null,
    },
  };
}
beforeAll(async () => {
  await mkdir("/tmp/source-resolution-integration", { recursive: true });
  f = await workflowFixture();
  await f.db.exec("begin");
  const source = await f.command("source.create", {
    name: "Addendum regression",
    kind: "manual",
  });
  opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Observation terminals and relay cabinets",
    reference: "OFFLINE-ADDENDUM",
    description: "Observation system procurement.",
    language: "en",
    decision: "shortlisted",
  });
  const first = await upload(initialText, "a".repeat(64));
  const second = await upload(replacementText, "b".repeat(64));
  let ctx = await f.rpc("source_review_context", [opportunity.id]);
  await authority(
    ctx.sources.find((s: any) => s.reference.entity_id === first.id),
  );
  ctx = await f.rpc("source_review_context", [opportunity.id]);
  const original = ctx.sources.find(
    (s: any) => s.reference.entity_id === first.id,
  );
  const oldSpan = await exactSpan(
    original,
    "Supplier shall deliver 9 observation terminals.",
  );
  const cabinetSpan = await exactSpan(
    original,
    "Supplier shall deliver 3 relay cabinets.",
  );
  const oldReview = await review(oldSpan, tuple("9", "observation terminals"));
  const cabinetReview = await review(cabinetSpan, tuple("3", "relay cabinets"));
  superseded = (await inventory([oldReview.review_id]))[0];
  await authority(
    ctx.sources.find((s: any) => s.reference.entity_id === second.id),
    {
      role: "buyer_addendum",
      precedence: 1,
      supersedes: {
        entity_id: first.id,
        content_hash: original.reference.content_hash,
      },
    },
  );
  ctx = await f.rpc("source_review_context", [opportunity.id]);
  const replacement = ctx.sources.find(
    (s: any) => s.reference.entity_id === second.id,
  );
  const newSpan = await exactSpan(
    replacement,
    "Supplier shall deliver 14 observation terminals.",
  );
  const newReview = await review(
    newSpan,
    tuple("14", "observation terminals"),
    { supersedes_review_id: oldReview.review_id },
  );
  current = await inventory([cabinetReview.review_id, newReview.review_id]);
  await expect(attempt(() => inventory([oldReview.review_id]))).rejects.toThrow(
    "SOURCE_OBLIGATION_SUPERSEDED",
  );
  ctx = await f.rpc("source_review_context", [opportunity.id]);
  expect(ctx.source_evidence.reviews.map((r: any) => r.id).sort()).toEqual(
    [cabinetReview.review_id, newReview.review_id].sort(),
  );
  expect(ctx.source_evidence.spans.some((s: any) => s.id === oldSpan.id)).toBe(
    false,
  );
  expect(
    ctx.source_evidence.spans.some(
      (s: any) => s.entity_id === first.id && s.quote === initialText,
    ),
  ).toBe(true);
  proposal = await f.command("delivery.snapshot.prepare", {
    opportunity_id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  const packageId = (
    await row("select (app_private.seal_draft_package($1,$2,$3)).id id", [
      f.w,
      opportunity.id,
      f.owner,
    ])
  ).id;
  frozen = (
    await row(
      "select app_private.draft_generation_snapshot($1,$2,$3,$4,null) value",
      [f.w, opportunity.id, proposal.proposal_id, packageId],
    )
  ).value;
  await writeFile(
    "/tmp/source-resolution-integration/source-context.json",
    JSON.stringify(
      { first, second, original, replacement, review_context: ctx, frozen },
      null,
      2,
    ),
  );
  const oldChunk = frozen.source_evidence.spans.find(
    (s: any) => s.entity_id === first.id && s.quote === initialText,
  );
  const sectionsByBlock = [
    {
      block_id: original.id,
      reqs: [
        candidate(oldChunk, tuple("9", "observation terminals")),
        candidate(cabinetSpan, tuple("3", "relay cabinets")),
      ],
    },
    {
      block_id: replacement.id,
      reqs: [candidate(newSpan, tuple("14", "observation terminals"))],
    },
  ];
  const plan = {
    id: crypto.randomUUID(),
    kind: "proposal",
    stage: "analysis",
    workflow_version: 3,
    frozen_context: frozen,
  };
  const steps: any[] = [];
  for (const item of sectionsByBlock) {
    const block = frozen.blocks.find((b: any) => b.id === item.block_id);
    const step: any = {
      id: crypto.randomUUID(),
      task: "analyze_chunk",
      stage: "analysis",
      ordinal: steps.length,
      status: "completed",
      input: {
        block_id: block.id,
        start: 0,
        end: Array.from(block.text).length,
      },
    };
    const context: any = { plan, step, steps, requirements: [] };
    const scope = taskInput(context);
    step.output = materializeSourceCandidate(
      "analyze_chunk",
      {
        processed_block_ids: [block.id],
        requirements: item.reqs,
        questions: [],
        summary: block.text,
        separate_volumes: false,
      },
      scope.context,
      scope.evidence,
    );
    validateGenerationResult(context, scope, step.output);
    steps.push(step);
  }
  analysisContext = { plan, step: steps[0], steps, requirements: [] };
  analysisOutput = await nextStage(analysisContext);
  requirements = analysisOutput.requirements;
  observations.authority_inventory = {
    current_review_ids: ctx.source_evidence.reviews.map((r: any) => r.id),
    superseded_review_id: oldReview.review_id,
    exact_old_span_excluded: true,
    full_old_source_chunk_retained: true,
    model_contract_has_supersedes_review_id: JSON.stringify(
      ctx.source_evidence,
    ).includes("supersedes_review_id"),
    requirements: requirements.map((r) => ({
      id: r.id,
      text: r.text,
      quantities: r.source_semantics.quantities,
      review_status: r.source_semantics.review_status,
      review_id: r.source_semantics.review_id,
    })),
  };
}, 30000);
afterAll(async () => {
  await writeFile(
    "/tmp/source-resolution-integration/observations.json",
    JSON.stringify(observations, null, 2),
  );
  await f?.db.exec("rollback");
  await f?.db.close();
});

beforeEach(async () => f.db.exec("savepoint regression"));
afterEach(async () =>
  f.db.exec("rollback to savepoint regression;release savepoint regression"),
);
async function rpc(name: string, args: Record<string, any> = {}) {
  return attempt(
    async () =>
      (
        await row(
          `select public.${name}(${Object.keys(args)
            .map((key, i) => `${key}=>$${i + 1}`)
            .join(",")}) data`,
          Object.values(args).map((v) =>
            v && typeof v === "object" ? JSON.stringify(v) : v,
          ),
        )
      ).data,
  );
}
async function storeSyntheticAcceptedGraph(fixture: any) {
  // Exact existing integration-fixture technique: authored accepted records,
  // never an inference/usage receipt or a claim of provider semantic success.
  const p = await row(
    "insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,workflow_version) values($1,$2,$3,$4,'proposal','completed','completed',1,$5,$6::jsonb,$7,3) returning *",
    [
      fixture.plan.id,
      f.w,
      opportunity.id,
      proposal.proposal_id,
      fixture.plan.input_hash,
      JSON.stringify(fixture.plan.frozen_context),
      f.owner,
    ],
  );
  for (const r of fixture.requirements)
    await f.db.query(
      "insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)",
      [
        r.id,
        f.w,
        p.id,
        opportunity.id,
        r.text,
        r.category,
        r.mandatory,
        JSON.stringify(r.source_refs),
        JSON.stringify(r.source_semantics),
        r.interpretation,
        r.acceptance_evidence,
        f.owner,
      ],
    );
  for (const step of fixture.steps) {
    const j = await row(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,$2,$3,$4,'succeeded',$5) returning *",
      [f.w, step.task, p.id, p.input_hash, f.owner],
    );
    const saved = await row(
      "insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'completed',$10) returning *",
      [
        step.id,
        f.w,
        p.id,
        j.id,
        step.task,
        step.stage,
        step.ordinal,
        JSON.stringify(step.input),
        JSON.stringify(step.output),
        f.owner,
      ],
    );
    const receipt = fixture.accepted_receipts.find(
      (x: any) => x.step_id === step.id,
    );
    receipt.candidate = saved.output;
    receipt.candidate_hash = await qualifierHash(JSON.stringify(saved.output));
    receipt.verification.checked_candidate_hash = receipt.candidate_hash;
    const thread = await qualifierHash(j.id);
    await f.db.query(
      "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values($1,$2,$3,$4,$5,'committed')",
      [thread, f.w, j.id, p.input_hash, step.task],
    );
    await f.db.query(
      "insert into app_private.model_graph_results(id,thread_id,result_key,value,content_hash) values($1,$2,'accepted',$3::jsonb,$4),($5,$2,'chosen-verification',$6::jsonb,$7)",
      [
        receipt.receipt_id,
        thread,
        JSON.stringify(saved.output),
        receipt.candidate_hash,
        receipt.verification_receipt_id,
        JSON.stringify({ result: receipt.verification, coverage: "aggregate" }),
        await qualifierHash(JSON.stringify(receipt.verification)),
      ],
    );
    await f.db.query(
      "update app_private.model_graph_threads set result_id=$1 where id=$2",
      [receipt.receipt_id, thread],
    );
    const packed = await modelGraphCheckpointFixture(
      receipt.verification_receipt_id,
    );
    await f.db.query(
      "insert into app_private.model_graph_checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values($1,'0001',$2::jsonb,$3::jsonb)",
      [
        thread,
        JSON.stringify(packed.checkpoint),
        JSON.stringify(packed.metadata),
      ],
    );
    await f.db.query(
      "update public.jobs set checkpoint=jsonb_build_object('graph_thread',$1::text,'model_executor',5) where id=$2",
      [thread, j.id],
    );
  }
  const v = await row(
    "insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by,plan_id,evidence_revision,section_outline,separate_volumes) values($1,$2,1,repeat('c',64),$3,$4,1,$5::jsonb,false) returning *",
    [
      f.w,
      proposal.proposal_id,
      f.owner,
      p.id,
      JSON.stringify(fixture.section_outline),
    ],
  );
  for (const [i, s] of fixture.sections.entries())
    await f.db.query(
      "insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,evidence_refs,created_by,content_blocks,requirement_ids,volume,fixed,company_claims) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb)",
      [
        f.w,
        v.id,
        s.key,
        s.title,
        s.body,
        i,
        JSON.stringify(s.evidence_refs),
        f.owner,
        JSON.stringify(s.content_blocks),
        JSON.stringify(s.requirement_ids),
        s.volume,
        s.fixed === true,
        JSON.stringify(s.company_claims || []),
      ],
    );
  await f.db.query(
    "update public.proposals set active_version_id=$1,state='draft' where id=$2",
    [v.id, proposal.proposal_id],
  );
  const issuance = await row(
    "insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at) select $1,$2,$3,'proposal.generate',$4,accepted_at,accepted_at+interval '600 seconds' from (select clock_timestamp() accepted_at) x returning *",
    [f.w, p.id, f.owner, crypto.randomUUID()],
  );
  await f.db.query(
    "update public.generation_plans set issuance_request_id=$1 where id=$2",
    [issuance.id, p.id],
  );
  const j = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values($1,'prepare_generated_delivery',$2,$3,'queued',$4,$5::jsonb) returning *",
    [
      f.w,
      p.id,
      p.input_hash,
      f.owner,
      JSON.stringify({
        model_executor: 5,
        minimum_worker_executor: 5,
        generated_version_id: v.id,
        generated_version_hash: v.content_hash,
      }),
    ],
  );
  return { p, v, j, issuance };
}

it("actual runtime reconciliation passes independent SQL audit and advance while preserving accepted analysis bytes", async () => {
  const p = await row(
    "insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,workflow_version) values($1,$2,$3,$4,'proposal','analysis','running',(select evidence_revision from public.workspaces where id=$2),repeat('e',64),$5::jsonb,$6,3) returning *",
    [
      analysisContext.plan.id,
      f.w,
      opportunity.id,
      proposal.proposal_id,
      JSON.stringify(frozen),
      f.owner,
    ],
  );
  for (const step of analysisContext.steps) {
    const job = await row(
      "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values($1,'analyze_chunk',$2,$3,'succeeded',$4) returning id",
      [f.w, p.id, p.input_hash, f.owner],
    );
    await f.db.query(
      "insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,output,status,created_by) values($1,$2,$3,$4,'analyze_chunk','analysis',$5,$6::jsonb,$7::jsonb,'completed',$8)",
      [
        step.id,
        f.w,
        p.id,
        job.id,
        step.ordinal,
        JSON.stringify(step.input),
        JSON.stringify(step.output),
        f.owner,
      ],
    );
  }
  const checked = (
    await row(
      "select app_private.validate_source_resolution_inventory(p,$2::jsonb,$3::jsonb) value from public.generation_plans p where id=$1",
      [
        p.id,
        JSON.stringify(analysisOutput.requirements),
        JSON.stringify(
          analysisOutput.final_result.source_resolution_dispositions,
        ),
      ],
    )
  ).value;
  expect(checked).toEqual(
    analysisOutput.final_result.source_resolution_dispositions,
  );
  const lease = crypto.randomUUID();
  const advance = await row(
    "insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,lease_token,lease_until) values($1,'advance_plan',$2,$3,'running',$4,$5,clock_timestamp()+interval '2 minutes') returning id",
    [f.w, p.id, p.input_hash, f.owner, lease],
  );
  const advanceStep = await row(
    "insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,status,created_by) values($1,$2,$3,'advance_plan','analysis',100,'{}','queued',$4) returning id",
    [f.w, p.id, advance.id, f.owner],
  );
  await rpc("advance_generation", {
    job_id: advance.id,
    lease,
    next_stage: analysisOutput.next_stage,
    requirements: analysisOutput.requirements,
    steps: analysisOutput.steps,
    final_result: analysisOutput.final_result,
  });
  expect(
    (
      await row("select output from public.generation_steps where id=$1", [
        advanceStep.id,
      ])
    ).output.source_resolution_dispositions,
  ).toEqual(checked);
  const persisted = (
    await f.db.query<any>(
      "select * from public.requirements where plan_id=$1",
      [p.id],
    )
  ).rows;
  expect(persisted).toHaveLength(2);
  expect(
    persisted.map((r: any) => r.source_semantics.quantities[0].value).sort(),
  ).toEqual(["14", "3"]);
  for (const step of analysisContext.steps)
    expect(
      (
        await row("select output from public.generation_steps where id=$1", [
          step.id,
        ])
      ).output,
    ).toEqual(step.output);
  expect(
    (await row("select count(*)::int n from public.provider_usage")).n,
  ).toBe(0);
});

async function assembled(rs: any[], body: string) {
  // Current v3 structure/detail/draft/review/reconciliation orchestration. The
  // candidates and all-pass verifier reports below are authored fault injection.
  const plan: any = {
    id: crypto.randomUUID(),
    kind: "proposal",
    status: "completed",
    stage: "planning",
    workflow_version: 3,
    input_hash: "e".repeat(64),
    frozen_context: {
      ...frozen,
      template: {
        id: "synthetic-permitted-template",
        required_sections: [],
        fixed_blocks: [],
        volume_mode: "combined",
      },
    },
  };
  const steps: any[] = [];
  let queued: any[] = [
    {
      task: "plan_proposal",
      input: {
        workflow_version: 3,
        planning_phase: "structure",
        id_aliases_version: 1,
        requirement_scope: "all",
        requirement_ids: [],
      },
    },
  ];
  let final: any;
  for (let n = 0; n < 12; n++) {
    for (const pending of queued) {
      const step = {
        ...pending,
        id: crypto.randomUUID(),
        status: "completed",
        stage: plan.stage,
        ordinal: steps.length,
        output: null as any,
      };
      const ctx: any = { plan, step, steps, requirements: rs };
      const scope = taskInput(ctx);
      if (scope.task === "plan_structure")
        step.output = {
          version: 3,
          decisions: [],
          questions: [],
          sections: [
            {
              key: "solution",
              title: "Proposed solution",
              purpose: "Explain installation and acceptance",
              volume: "technical",
              mode: "narrative",
              requirement_ids: scope.context.blueprint_requirement_ids,
            },
          ],
        };
      else if (scope.task === "plan_blueprint")
        step.output = {
          version: 2,
          processed_requirement_ids: scope.context.blueprint_requirement_ids,
          decisions: [],
          questions: [],
          sections: scope.context.assigned_sections
            .map((s: any) => ({
              ...s,
              requirement_ids: undefined,
              units: [
                {
                  key: s.key + "-unit",
                  title: s.title,
                  purpose: s.purpose,
                  target_words: 300,
                  decision_ids: [],
                  secondary_links: [],
                  requirement_ids: s.requirement_ids,
                },
              ],
            }))
            .map(({ requirement_ids, ...s }: any) => s),
        };
      else if (scope.task === "draft_section")
        step.output = {
          key: step.input.section.key,
          title: step.input.section.title,
          content_blocks: [{ type: "paragraph", text: body }],
          requirement_ids: scope.requiredIds,
          evidence_refs: [],
          company_claims: [],
          assumptions: [],
          questions: [],
        };
      else if (scope.task === "plan_commercial")
        step.output = { lines: [], tasks: [], questions: [] };
      else if (scope.task === "review_proposal")
        step.output = {
          processed_requirement_ids: scope.requiredIds,
          responses: scope.requiredIds.map((id: string) => ({
            requirement_id: id,
            status: "answered",
            section_ids: step.input.section_keys,
            evidence_refs: [],
            rationale:
              "Authored fault injection: response has been marked supported.",
          })),
          findings: [],
        };
      else throw new Error("Unexpected task " + scope.task);
      try {
        validateGenerationResult(ctx, scope, step.output);
      } catch (e: any) {
        await writeFile(
          `/tmp/source-resolution-integration/fixture-error.json`,
          JSON.stringify(
            {
              task: scope.task,
              input: step.input,
              output: step.output,
              diagnostics: e.validationDiagnostics,
            },
            null,
            2,
          ),
        );
        throw e;
      }
      steps.push(step);
    }
    const advanced = await nextStage({
      plan,
      step: { task: "advance_plan", input: {} },
      steps,
      requirements: rs,
    } as any);
    if (advanced.final_result) {
      final = advanced.final_result;
      break;
    }
    plan.stage = advanced.next_stage;
    queued = advanced.steps;
  }
  expect(final).toBeTruthy();
  plan.stage = "completed";
  const accepted_receipts: any[] = [];
  for (const step of steps) {
    const scope = taskInput({
      plan: { ...plan, stage: step.stage },
      step,
      steps,
      requirements: rs,
    } as any);
    const hash = await qualifierHash(JSON.stringify(step.output));
    const units = candidateContent(step.output);
    const quote = step.task === "draft_section" ? body : units[0]?.text || "";
    const verification: any = {
      checked_candidate_hash: hash,
      reviewed_all_content: true,
      processed_content_ids: units.map((u: any) => u.id),
      claims: units.length
        ? [
            {
              id: "claim",
              claim: quote,
              candidate_quote: quote,
              kind: "proposed_solution",
              status: "supported",
              source_refs: [],
              finding:
                "Authored all-pass fault injection; not actual inference.",
            },
          ]
        : [],
      processed_requirement_ids: scope.requiredIds,
      requirement_checks: scope.requiredIds.map((id: string) => ({
        requirement_id: id,
        status: "supported",
        candidate_quote: quote,
        source_refs: [],
        finding: "Authored all-pass fault injection; not actual inference.",
      })),
      findings: [],
    };
    validateGroundingReport(
      verification,
      step.output,
      hash,
      scope.evidence,
      scope.requiredIds,
      undefined,
      groundingOptions(scope.context, true),
    );
    accepted_receipts.push({
      step_id: step.id,
      receipt_id: crypto.randomUUID(),
      verification_receipt_id: crypto.randomUUID(),
      candidate_hash: hash,
      candidate: step.output,
      accepted: true,
      verification,
    });
  }
  return {
    plan,
    steps,
    requirements: rs,
    sections: final.sections,
    section_outline: final.section_outline,
    accepted_receipts,
  };
}

it("issues the corrected 14-terminal and unchanged 3-cabinet review draft through SQL and DOCX; revoked source blocks later artifact access", async () => {
  const body =
    "We will supply exactly 14 observation terminals and exactly 3 relay cabinets, install and configure each device, and record the buyer witnessed item count and operational acceptance test.";
  const fixture = await assembled(requirements, body);
  await f.db.query(
    "update public.jobs set status='canceled' where type='render_delivery'",
  );
  const { v, j, issuance } = await storeSyntheticAcceptedGraph(fixture);
  const job = await rpc("claim_backend_local_job_v5");
  expect(job.id).toBe(j.id);
  const ctx = await rpc("generated_delivery_context", {
    job_id: job.id,
    lease: job.lease_token,
  });
  const report = await assessGeneratedDelivery(ctx);
  expect(report.blockers).toEqual([]);
  const payload = await buildGeneratedPayload(ctx, report);
  const published = await rpc("publish_generated_delivery", {
    job_id: job.id,
    lease: job.lease_token,
    expected_context_hash: ctx.context_hash,
    payload,
  });
  const snapshot = await row(
    "select * from public.proposal_delivery_snapshots where id=$1",
    [published.id],
  );
  expect(snapshot.payload).toMatchObject({
    content_state: "generated_review_draft",
    substantive_complete: false,
    approval_state: "draft",
  });
  const renderJob = await rpc("claim_backend_local_job_v5");
  expect(renderJob.type).toBe("render_delivery");
  const objects = new Map<string, Blob>();
  const backend: any = {
    internal: rpc,
    deliveryObject: async (key: string) => objects.get(key) || null,
    storeDeliveryObject: async (key: string, bytes: Uint8Array) => {
      expect(objects.has(key)).toBe(false);
      objects.set(key, new Blob([new Uint8Array(bytes)]));
    },
  };
  const fonts: any = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  );
  const result = await processDeliveryExport(
    backend,
    renderJob,
    async (model: any) =>
      new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer()),
  );
  expect(result.error_code).toBeFalsy();
  const pkg = await rpc("delivery_package", { snapshot_id: published.id });
  expect(pkg.status).toBe("ready");
  const auth = await rpc("delivery_artifact_context", {
    artifact_id: pkg.artifacts[0].id,
    actor_id: f.owner,
  });
  const bytes = new Uint8Array(
    await objects.get(auth.artifact.storage_key)!.arrayBuffer(),
  );
  verifyExportDocx(bytes, buildDeliveryExport(snapshot, "combined"));
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
  expect(xml).not.toContain("exactly 9 observation terminals");
  expect(xml).toContain("exactly 3 relay cabinets");
  expect(xml).toContain("exactly 14 observation terminals");

  const outcome = await row(
    "select outcome from public.proposal_issuance_requests where id=$1",
    [issuance.id],
  );
  expect(outcome.outcome).toBe("issued");
  const gate = (
    await row("select app_private.approval_gate($1,$2) value", [f.w, v.id])
  ).value;
  expect(gate.blockers.length).toBeGreaterThan(0);
  const approvals = (await row("select count(*)::int n from public.approvals"))
    .n;
  expect(approvals).toBe(0);
  const usage = (await row("select count(*)::int n from public.provider_usage"))
    .n;
  expect(usage).toBe(0);
  const active = frozen.source_resolution.active_reviews.find(
    (r: any) => r.semantics.quantities[0]?.value === "14",
  );
  expect(active).toBeTruthy();
  await f.command("source.obligation.review", {
    opportunity_id: opportunity.id,
    review_id: active.id,
    expected_revision: active.revision,
    spans: active.spans,
    semantics: active.semantics,
    status: "revoked",
    reason: "Synthetic revocation after issued draft.",
  });
  await expect(
    rpc("delivery_artifact_context", {
      artifact_id: pkg.artifacts[0].id,
      actor_id: f.owner,
    }),
  ).rejects.toThrow("SOURCE_RESOLUTION_STALE");
  await writeFile(
    "/tmp/source-resolution-integration/corrected-review-draft.docx",
    bytes,
  );
  observations.corrected_sql_and_docx = {
    quantities: ["14", "3"],
    retired_quantity_absent: true,
    package_status: pkg.status,
    issuance_outcome: outcome.outcome,
    final_approval_blocked: gate.blockers.length > 0,
    later_revocation_blocks_artifact: true,
    approvals,
    provider_usage: usage,
  };
}, 30000);
