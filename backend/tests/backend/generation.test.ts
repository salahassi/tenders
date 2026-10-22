import { databaseError } from "../../supabase/functions/_shared/http";
import type {
  Backend,
  BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { buildExportModel } from "../../supabase/functions/_shared/export";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  processGeneration,
  nextStage,
  plannedSections,
  taskInput,
  splitStep,
} from "../../supabase/functions/_shared/generation";
import { validateBlueprint } from "../../supabase/functions/_shared/proposalBlueprint";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup(confirm = true, text = "Implement approval workflow.") {
  await f.db.query(
    "insert into public.templates(workspace_id,title,language,volume_mode,required_sections,fixed_blocks,content_hash,approved,approved_by,approved_at,created_by) values($1,'Synthetic short template','en','combined',$2::jsonb,'[]',repeat('a',64),true,$3,now(),$3)",
    [
      f.w,
      JSON.stringify([
        {
          key: "approach",
          title: "Proposed approach",
          purpose: "Explain implementation",
          volume: "technical",
          applicable: true,
          rationale: "",
        },
      ]),
      f.owner,
    ],
  );
  const source = await f.command("source.create", {
    name: "Synthetic manual",
    kind: "manual",
  });
  const opp = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic workflow",
    reference: "S1",
    decision: "shortlisted",
    description: "Implement approval workflow.",
    language: "en",
  });
  const document = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opp.id,
    original_name: "synthetic.txt",
    mime_type: "text/plain",
    size: Math.max(50, new TextEncoder().encode(text).length),
    hash: "a".repeat(64),
  });
  const d = await f.rpc("accept_uploaded_document", [
    document.id,
    f.owner,
    "a".repeat(64),
    Math.max(50, new TextEncoder().encode(text).length),
    text,
    "ready",
    crypto.randomUUID(),
  ]);
  if (confirm)
    await f.command("document.confirm", {
      id: d.id,
      expected_revision: d.revision,
    });
  return { opp, document: d };
}
async function start() {
  const s = await setup();
  return {
    ...s,
    plan: await f.command("proposal.generate", {
      id: s.opp.id,
      expected_revision: s.opp.revision,
    }),
  };
}

it("upgrades only blocked planning, preserving completed analysis and paid receipts with explicit owner, revision and service-role checks", async () => {
  const { plan } = await start();
  await f.db.query(
    "update public.generation_plans set workflow_version=2 where id=$1",
    [plan.id],
  );
  let planning: any;
  for (let i = 0; i < 10; i++) {
    const job = await f.rpc("claim_backend_job");
    const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
    if (ctx.step.task === "plan_proposal") {
      planning = job;
      break;
    }
    if (ctx.step.task === "advance_plan") {
      const next = await nextStage(ctx);
      await f.rpc("advance_generation", [
        job.id,
        job.lease_token,
        next.next_stage,
        JSON.stringify(next.requirements),
        JSON.stringify(next.steps),
        null,
      ]);
    } else
      await f.rpc("complete_generation_step", [
        job.id,
        job.lease_token,
        JSON.stringify(resultFor(ctx)),
      ]);
  }
  expect(planning).toBeTruthy();
  await f.rpc("fail_generation", [
    planning.id,
    planning.lease_token,
    "MODEL_CORRECTION_EXHAUSTED",
    null,
    null,
  ]);
  const prior = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      plan.id,
    ])
  ).rows[0];
  const analysis = async () =>
    (
      await f.db.query(
        "select id,input,output,status from public.generation_steps where plan_id=$1 and stage='analysis' order by ordinal",
        [plan.id],
      )
    ).rows;
  const before = await analysis();
  expect(before.some((s: any) => s.status === "completed")).toBe(true);
  const usage = crypto.randomUUID();
  await f.db.query(
    `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
    values($1::uuid,$2,$3,$4,$1::text,'openai','synthetic-model',repeat('d',64),current_date,1,100,16384,'reserved',$5)`,
    [usage, f.w, planning.id, planning.lease_token, f.owner],
  );
  const attempt = async (actor: string, revision: number) => {
    await f.db.exec("savepoint upgrade_attempt");
    try {
      return await f.rpc("upgrade_blocked_proposal_planning", [
        plan.id,
        actor,
        revision,
      ]);
    } catch (error) {
      await f.db.exec("rollback to savepoint upgrade_attempt");
      throw error;
    } finally {
      await f.db.exec("release savepoint upgrade_attempt");
    }
  };
  await expect(attempt(crypto.randomUUID(), prior.revision)).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(attempt(f.owner, prior.revision - 1)).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  await expect(attempt(f.owner, prior.revision)).rejects.toThrow(
    "PLANNING_UPGRADE_NOT_SAFE",
  );
  await f.db.query(
    "update public.provider_usage set state='settled' where id=$1",
    [usage],
  );
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  await f.db.exec("savepoint changed_evidence");
  await f.db.query(
    "update public.generation_plans set frozen_context=jsonb_set(frozen_context,'{language}','\"ar\"') where id=$1",
    [plan.id],
  );
  await expect(attempt(f.owner, prior.revision)).rejects.toThrow("STALE_INPUT");
  await f.db.exec(
    "rollback to savepoint changed_evidence; release savepoint changed_evidence",
  );
  const queued = await attempt(f.owner, prior.revision);
  expect(await analysis()).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select workflow_version,execution_policy,status from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0],
  ).toMatchObject({
    workflow_version: 3,
    status: "running",
    execution_policy: { verification_output_tokens: 40000 },
  });
  expect(
    (
      await f.db.query<any>(
        "select input from public.generation_steps where job_id=$1",
        [queued],
      )
    ).rows[0].input.planning_phase,
  ).toBe("structure");
  expect(
    (
      await f.db.query<any>(
        "select status,error_code from public.jobs where id=$1",
        [planning.id],
      )
    ).rows[0],
  ).toEqual({ status: "canceled", error_code: "PLANNING_SUPERSEDED" });
  expect(
    (
      await f.db.query<any>(
        "select state,reserved_output from public.provider_usage where id=$1",
        [usage],
      )
    ).rows[0],
  ).toEqual({ state: "settled", reserved_output: 16384 });
  const privilege = (
    await f.db.query<any>(
      "select has_function_privilege('authenticated','public.upgrade_blocked_proposal_planning(uuid,uuid,integer)','execute') as client, has_function_privilege('service_role','public.upgrade_blocked_proposal_planning(uuid,uuid,integer)','execute') as service",
    )
  ).rows[0];
  expect(privilege).toEqual({ client: false, service: true });
  await expect(attempt(f.owner, prior.revision)).rejects.toThrow(
    "REVISION_CONFLICT",
  );
});
it("retains frozen proposal knowledge when unrelated verified notes are added", async () => {
  const { plan } = await start();
  const before = (
    await f.db.query<any>(
      "select frozen_context from public.generation_plans where id=$1",
      [plan.id],
    )
  ).rows[0].frozen_context;
  const added = await f.command("knowledge.save", {
    category: "company",
    title: "Synthetic additional reference",
    content: "Separate verified company description.",
    evidence: "Synthetic public reference",
    enabled: true,
  });
  await f.command("knowledge.verify", {
    id: added.id,
    expected_revision: added.revision,
  });
  await f.db.query("select app_private.refresh_proposal_evidence($1::uuid)", [
    plan.id,
  ]);
  expect(
    (
      await f.db.query<any>(
        "select frozen_context from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0].frozen_context,
  ).toEqual(before);
});

it.each([1, 2, 3])(
  "reprepares exhausted workflow-%i reviews with citable context and preserves paid history",
  async (workflowVersion) => {
    const { plan } = await start();
    let review: any;
    for (let i = 0; i < 30; i++) {
      const job = await f.rpc("claim_backend_job");
      const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
      if (ctx.step.task === "review_proposal") {
        review = job;
        break;
      }
      if (ctx.step.task === "advance_plan") {
        const next = await nextStage(ctx);
        await f.rpc("advance_generation", [
          job.id,
          job.lease_token,
          next.next_stage,
          JSON.stringify(next.requirements),
          JSON.stringify(next.steps),
          null,
        ]);
      } else
        await f.rpc("complete_generation_step", [
          job.id,
          job.lease_token,
          JSON.stringify(resultFor(ctx)),
        ]);
    }
    expect(review).toBeTruthy();
    await f.rpc("fail_generation", [
      review.id,
      review.lease_token,
      "MODEL_CORRECTION_EXHAUSTED",
      null,
      null,
    ]);
    await f.db.query(
      "update public.generation_plans set workflow_version=$2 where id=$1",
      [plan.id, workflowVersion],
    );
    const revision = (
      await f.db.query<any>("select revision from public.jobs where id=$1", [
        review.id,
      ])
    ).rows[0].revision;
    const completed = async () =>
      (
        await f.db.query(
          "select id,input,output from public.generation_steps where plan_id=$1 and status='completed' order by ordinal",
          [plan.id],
        )
      ).rows;
    const retained = await completed();
    const usage = crypto.randomUUID();
    await f.db.query(
      `insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
    values($1::uuid,$2,$3,$4,$1::text,'openai','synthetic-model',repeat('d',64),current_date,1,100,40000,'unknown',$5)`,
      [usage, f.w, review.id, review.lease_token, f.owner],
    );
    await f.db.query(
      "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values(repeat('e',64),$1,$2,repeat('f',64),'review_proposal','needs_review')",
      [f.w, review.id],
    );
    await f.db.exec(
      "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values(repeat('e',64),'writer',3)",
    );
    const attempt = async (
      actor = f.owner,
      rev = revision,
      target = review.id,
    ) => {
      await f.db.exec("savepoint review_reprepare");
      try {
        return await f.rpc("reprepare_blocked_proposal_review", [
          target,
          actor,
          rev,
        ]);
      } catch (e) {
        await f.db.exec("rollback to savepoint review_reprepare");
        throw e;
      } finally {
        await f.db.exec("release savepoint review_reprepare");
      }
    };
    await expect(attempt(crypto.randomUUID())).rejects.toThrow("FORBIDDEN");
    await expect(attempt(f.owner, revision - 1)).rejects.toThrow(
      "REVISION_CONFLICT",
    );
    await expect(attempt()).rejects.toThrow("REVIEW_REPREPARE_NOT_SAFE");
    await f.db.query(
      "update public.provider_usage set state='settled' where id=$1",
      [usage],
    );
    await f.db.exec("savepoint stale_review_evidence");
    await f.db.query(
      "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
      [f.w],
    );
    await expect(attempt()).rejects.toThrow("STALE_INPUT");
    await f.db.exec(
      "rollback to savepoint stale_review_evidence; release savepoint stale_review_evidence",
    );
    let queued: string;
    if (workflowVersion === 1) {
      const current = (
        await f.db.query<any>(
          "select revision from public.generation_plans where id=$1",
          [plan.id],
        )
      ).rows[0];
      const payload = {
        id: plan.id,
        expected_revision: current.revision,
        reason: "Resume obsolete saved review",
      };
      const key = crypto.randomUUID();
      const resumed = await f.command("generation.retry", payload, key);
      expect(await f.command("generation.retry", payload, key)).toEqual(
        resumed,
      );
      queued = (
        await f.db.query<any>(
          "select job_id from public.generation_steps where plan_id=$1 and input->>'review_source_version'='1'",
          [plan.id],
        )
      ).rows[0].job_id;
    } else queued = await attempt();
    expect(await completed()).toEqual(retained);
    expect(
      (
        await f.db.query<any>(
          "select input from public.generation_steps where job_id=$1",
          [queued],
        )
      ).rows[0].input,
    ).toMatchObject({ review_scope_version: 1, review_source_version: 1 });
    expect(
      (
        await f.db.query<any>(
          "select status,error_code from public.jobs where id=$1",
          [review.id],
        )
      ).rows[0],
    ).toEqual({ status: "canceled", error_code: "REVIEW_CONTEXT_SUPERSEDED" });
    expect(
      (
        await f.db.query<any>(
          "select state,reserved_output from public.provider_usage where id=$1",
          [usage],
        )
      ).rows[0],
    ).toEqual({ state: "settled", reserved_output: 40000 });
    expect(
      (
        await f.db.query<any>(
          "select candidates from app_private.model_graph_budgets where thread_id=repeat('e',64)",
        )
      ).rows[0].candidates,
    ).toBe(3);
    await expect(attempt()).rejects.toThrow("REVISION_CONFLICT");
    await f.db.query(
      "update public.jobs set status='blocked',error_code='MODEL_CORRECTION_EXHAUSTED' where id=$1",
      [queued],
    );
    const newRevision = (
      await f.db.query<any>("select revision from public.jobs where id=$1", [
        queued,
      ])
    ).rows[0].revision;
    await expect(attempt(f.owner, newRevision, queued)).rejects.toThrow(
      "REVIEW_REPREPARE_NOT_SAFE",
    );
    expect(
      (
        await f.db.query<any>(
          "select has_function_privilege('authenticated','public.reprepare_blocked_proposal_review(uuid,uuid,integer)','execute') as client,has_function_privilege('service_role','public.reprepare_blocked_proposal_review(uuid,uuid,integer)','execute') as service",
        )
      ).rows[0],
    ).toEqual({ client: false, service: true });
  },
);

function resultFor(ctx: any) {
  const input = taskInput(ctx),
    ids = input.requiredIds,
    refs = input.evidence
      .filter((x) => x.kind === "rfp")
      .map((x) => ({ id: x.id, quote: "approval workflow" }));
  if (ctx.step.task === "analyze_chunk")
    return {
      processed_block_ids: ids,
      requirements: [
        {
          text: "Implement approval workflow.",
          category: "functional",
          mandatory: true,
          source_refs: refs,
          interpretation: "An approval workflow",
          acceptance_evidence: "Demonstrate the workflow.",
          owner_question: null,
        },
      ],
      questions: [],
      separate_volumes: false,
      summary: "Synthetic scope",
    };
  if (ctx.step.task === "plan_proposal")
    return {
      processed_requirement_ids: ids,
      sections: [
        {
          key: "approach",
          title: "Proposed approach",
          purpose: "Explain implementation",
          volume: "technical",
          requirement_ids: ids,
        },
      ],
      questions: [],
    };
  if (ctx.step.task === "draft_section")
    return {
      key: ctx.step.input.section.key,
      title: "Proposed approach",
      content_blocks: [
        { type: "paragraph", text: "Implement approval workflow." },
      ],
      requirement_ids: ids,
      evidence_refs: refs,
      company_claims: [],
      assumptions: [],
      questions: [],
    };
  if (ctx.step.task === "plan_commercial")
    return {
      lines: [],
      tasks: [],
      questions: [
        {
          question: "[INPUT REQUIRED: Confirm approved commercial rates.]",
          blocking_level: "finalization",
          requirement_ids: ids,
        },
      ],
    };
  if (ctx.step.task === "review_proposal")
    return {
      processed_requirement_ids: ids,
      responses: ids.map((id) => ({
        requirement_id: id,
        status: "answered",
        section_ids: input.context.sections.map((s: { key: string }) => s.key),
        evidence_refs: refs,
        rationale: "The response describes approval workflow.",
      })),
      findings: [],
    };
  throw Error("Unexpected task");
}
async function runPlan(result: (ctx: any) => any = resultFor) {
  let count = 0;
  for (;;) {
    const job = await f.rpc("claim_backend_job");
    if (!job) break;
    if (++count > 45) throw Error("Unbounded fixture");
    const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
    if (ctx.step.task === "advance_plan") {
      const next = await nextStage(ctx);
      await f.rpc("advance_generation", [
        job.id,
        job.lease_token,
        next.next_stage,
        JSON.stringify(next.requirements),
        JSON.stringify(next.steps),
        next.final_result ? JSON.stringify(next.final_result) : null,
      ]);
    } else
      await f.rpc("complete_generation_step", [
        job.id,
        job.lease_token,
        JSON.stringify(result(ctx)),
      ]);
  }
  return count;
}
it("admits the semantic workflow without company files or a custom template and exports its reviewed matrix", async () => {
  const s = await setup();
  await f.db.exec(
    "delete from public.templates;update app_private.proposal_workflow_admission set enabled=true",
  );
  await f.db.query(
    "update app_private.proposal_workflow_admission set trial_opportunity_id=$1",
    [s.opp.id],
  );
  await f.db.query(
    "insert into public.model_execution_settings(workspace_id,enabled,created_by) values($1,true,$2)",
    [f.w, f.owner],
  );
  const plan = await f.command("proposal.generate", {
    id: s.opp.id,
    expected_revision: s.opp.revision,
  });
  expect(plan.workflow_version).toBe(3);
  expect(plan.frozen_context.knowledge).toEqual([]);
  const order: string[] = [];
  await runPlan((ctx) => {
    const input = taskInput(ctx);
    order.push(ctx.plan.stage);
    if (input.task === "plan_structure") {
      const required =
        ctx.plan.frozen_context.template.required_sections.filter(
          (s: any) => s.applicable,
        );
      const narrative = required.find(
        (s: any) => !s.key.includes("summary") && !s.key.includes("compliance"),
      );
      return {
        version: 3,
        decisions: [],
        questions: [],
        sections: required.map((section: any) => ({
          key: section.key,
          title: section.title,
          purpose: section.purpose,
          volume: section.volume,
          mode: section.key.includes("summary")
            ? "executive_summary"
            : section.key.includes("compliance")
              ? "compliance_matrix"
              : "narrative",
          requirement_ids:
            section.key === narrative.key
              ? input.context.blueprint_requirement_ids
              : [],
        })),
      };
    }
    if (input.task !== "plan_blueprint") return resultFor(ctx);
    const required =
      input.context.assigned_sections ??
      ctx.plan.frozen_context.template.required_sections.filter(
        (s: any) => s.applicable,
      );
    const narrative = required.find(
      (s: any) => !s.key.includes("summary") && !s.key.includes("compliance"),
    );
    const ids = input.context.blueprint_requirement_ids;
    const result = {
      version: 2,
      processed_requirement_ids: ids,
      decisions: [],
      questions: [],
      sections: required.map((section: any) => {
        const mode = section.key.includes("summary")
          ? "executive_summary"
          : section.key.includes("compliance")
            ? "compliance_matrix"
            : "narrative";
        return {
          key: section.key,
          title: section.title,
          purpose: section.purpose,
          volume: section.volume,
          mode,
          units:
            mode === "compliance_matrix"
              ? []
              : [
                  {
                    key: section.key + "-unit",
                    title: section.title,
                    purpose: section.purpose,
                    requirement_ids:
                      section.requirement_ids ??
                      (section.key === narrative.key ? ids : []),
                    secondary_links: [],
                    decision_ids: [],
                    target_words: 300,
                  },
                ],
        };
      }),
    };
    validateBlueprint(
      result as any,
      ids,
      required.filter((s: any) => s.applicable),
    );
    return result;
  });
  const finished = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      plan.id,
    ])
  ).rows[0];
  expect(finished).toMatchObject({
    status: "completed",
    stage: "completed",
    workflow_version: 3,
  });
  expect(order.indexOf("synthesis")).toBeGreaterThan(
    order.lastIndexOf("commercial"),
  );
  expect(order.at(-1)).toBe("reconciliation");
  const version = (
    await f.db.query<any>(
      "select * from public.proposal_versions where plan_id=$1",
      [plan.id],
    )
  ).rows[0];
  expect(version.section_outline?.groups.length).toBeGreaterThan(0);
  const matrix = (
    await f.db.query<any>(
      "select * from public.proposal_sections where proposal_version_id=$1 and section_key like '%compliance%'",
      [version.id],
    )
  ).rows[0];
  expect(matrix.content_blocks[0].headers).toContain("Coverage");
  expect(matrix.body).toContain("Answered");
  const request = await f.command("export.prepare", {
    proposal_version_id: version.id,
    expected_revision: version.revision,
    mode: "draft",
    volume: "combined",
  });
  const exportedMatrices = buildExportModel(request).blocks.filter(
    (b: any) => b.type === "table" && b.headers[0] === "Requirement",
  );
  expect(exportedMatrices).toHaveLength(1);
  expect((exportedMatrices[0] as any).rows).toHaveLength(
    request.snapshot.requirements.length,
  );
  expect(JSON.stringify(exportedMatrices)).toContain(
    "Model review (not confirmed)",
  );
  await expect(
    f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "final",
      volume: "combined",
    }),
  ).rejects.toThrow("APPROVAL_REQUIRED");
});
it("requires extraction review before recording generation", async () => {
  const s = await setup(false);
  await expect(
    f.command("proposal.generate", {
      id: s.opp.id,
      expected_revision: s.opp.revision,
    }),
  ).rejects.toThrow("EXTRACTION_REVIEW_REQUIRED");
  expect(
    (await f.db.query("select * from public.generation_plans")).rows,
  ).toHaveLength(0);
});
it("completes and exports a full RFP draft without templates, company knowledge or rates", async () => {
  const s = await setup();
  await f.db.exec("delete from public.templates");
  expect(
    (await f.db.query("select id from public.knowledge_items")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("select id from public.rate_catalog")).rows,
  ).toHaveLength(0);
  const plan = await f.command("proposal.generate", {
    id: s.opp.id,
    expected_revision: s.opp.revision,
  });
  expect(plan.frozen_context.template.id).toBe("professional-v1");
  expect(plan.frozen_context.knowledge).toEqual([]);
  await runPlan();
  const version = (
    await f.db.query<any>("select * from public.proposal_versions")
  ).rows[0];
  const sections = (
    await f.db.query<any>(
      "select * from public.proposal_sections order by ordinal",
    )
  ).rows;
  expect(sections.length).toBeGreaterThanOrEqual(17);
  expect(sections.every((s: any) => s.body.trim().length > 0)).toBe(true);
  const questions = (await f.db.query<any>("select * from public.questions"))
    .rows;
  expect(
    questions.find((q: any) =>
      q.question.includes("without verified company evidence"),
    )?.blocking_level,
  ).toBe("advisory");
  expect(
    questions.some(
      (q: any) =>
        q.blocking_level === "finalization" && q.question.includes("rates"),
    ),
  ).toBe(true);
  const request = await f.command("export.prepare", {
    proposal_version_id: version.id,
    expected_revision: version.revision,
    mode: "draft",
    volume: "combined",
  });
  const model = buildExportModel(request);
  expect(version.section_outline?.version).toBe(1);
  expect(request.snapshot.section_outline).toEqual(version.section_outline);
  for (const section of sections)
    expect(
      model.blocks.some(
        (b: any) =>
          ["heading", "paragraph"].includes(b.type) && b.text === section.title,
      ),
    ).toBe(true);
  const matrixTables = model.blocks.filter(
    (b: any) => b.type === "table" && b.headers[0] === "Requirement",
  );
  expect(matrixTables).toHaveLength(1);
  expect((matrixTables[0] as any).rows).toHaveLength(
    request.snapshot.requirements.length,
  );
  expect(model.blocks.some((b: any) => b.text?.includes("DRAFT"))).toBe(true);
  expect(JSON.stringify(model)).not.toContain("Invented certification");
  if (process.env.TENDERDESK_EXPORT_QA_DIR) {
    await mkdir(process.env.TENDERDESK_EXPORT_QA_DIR, { recursive: true });
    await writeFile(
      `${process.env.TENDERDESK_EXPORT_QA_DIR}/rfp-only-model.json`,
      JSON.stringify(model),
    );
  }
  await expect(
    f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "final",
      volume: "combined",
    }),
  ).rejects.toThrow("APPROVAL_REQUIRED");
});

it("persists application-derived part lineage through canonical generation and the authorized export snapshot without merging content rows", async () => {
  const { plan } = await start();
  await runPlan((ctx) => {
    const result = resultFor(ctx);
    if (ctx.step.task === "analyze_chunk")
      return {
        ...result,
        requirements: Array.from({ length: 9 }, (_, i) => ({
          ...result.requirements![0],
          text: `Synthetic workflow acceptance requirement ${i + 1}.`,
        })),
      };
    return result;
  });
  const version = (
    await f.db.query<any>(
      "select * from public.proposal_versions where plan_id=$1",
      [plan.id],
    )
  ).rows[0];
  const sections = (
    await f.db.query<any>(
      "select * from public.proposal_sections where proposal_version_id=$1 order by ordinal",
      [version.id],
    )
  ).rows;
  expect(sections.map((s) => s.section_key)).toEqual([
    "approach-part1",
    "approach-part2",
  ]);
  expect(sections.map((s) => s.requirement_ids.length)).toEqual([8, 1]);
  expect(sections.every((s) => s.evidence_refs.length > 0)).toBe(true);
  expect(version.section_outline).toEqual({
    version: 1,
    groups: [
      {
        parent_section_key: "approach",
        title: "Proposed approach",
        volume: "technical",
        parts: [
          { section_key: "approach-part1", part_index: 1, part_count: 2 },
          { section_key: "approach-part2", part_index: 2, part_count: 2 },
        ],
      },
    ],
  });
  const request = await f.command("export.prepare", {
    proposal_version_id: version.id,
    expected_revision: version.revision,
    mode: "draft",
    volume: "combined",
  });
  expect(request.snapshot.section_outline).toEqual(version.section_outline);
  const content = (s: any) => ({
    id: s.id,
    section_key: s.section_key,
    body: s.body,
    content_blocks: s.content_blocks,
    evidence_refs: s.evidence_refs,
    requirement_ids: s.requirement_ids,
  });
  expect(request.snapshot.sections.map(content)).toEqual(sections.map(content));
  const model = buildExportModel(request);
  expect(
    model.blocks.filter(
      (b: any) => b.type === "heading" && b.text === "Proposed approach",
    ),
  ).toHaveLength(1);
  expect(
    model.blocks.filter(
      (b: any) =>
        b.type === "paragraph" && b.text === "Implement approval workflow.",
    ),
  ).toHaveLength(2);
  const privileges = (
    await f.db.query<any>(
      "select has_column_privilege('authenticated','public.proposal_versions','section_outline','select') member_read,has_column_privilege('authenticated','public.proposal_versions','section_outline','update') member_write,has_column_privilege('anon','public.proposal_versions','section_outline','select') anonymous_read",
    )
  ).rows[0];
  expect(privileges).toEqual({
    member_read: true,
    member_write: false,
    anonymous_read: false,
  });
  await f.db.query(
    "update public.proposal_versions set section_outline=null where id=$1",
    [version.id],
  );
  const saved = (
    await f.db.query<any>(
      "select snapshot from public.export_requests where id=$1",
      [request.id],
    )
  ).rows[0].snapshot;
  expect(saved.section_outline).toEqual(version.section_outline);
});
it("allows initial quota failover but pins a proposal after measured model usage", async () => {
  await start();
  const job = await f.rpc("claim_backend_job");
  const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
  const manifest = taskInput(ctx).manifest;
  for (const [provider, rank] of [
    ["gemini_free", 1],
    ["qwen_free", 2],
  ] as const) {
    await f.command("model.configure", {
      expected_revision: 0,
      enabled: true,
      provider,
      model: "synthetic-model",
      project_ref: "synthetic-project",
      free_only: true,
      billing_verified: true,
      free_quota_only: true,
      quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
      quota_remaining_tokens: 100000,
      calls_per_day: 50,
      input_per_day: 250000,
      output_per_day: 50000,
      failover_rank: rank,
    });
    for (const ref of manifest)
      await f.command("content.authorize", {
        ...ref,
        provider,
        attestation: "nonconfidential_nonpersonal",
      });
  }
  const reserve = (provider: string, key: string) =>
    f.rpc("reserve_model_call", [
      job.id,
      job.lease_token,
      key,
      "a".repeat(64),
      1000,
      2048,
      JSON.stringify(manifest),
      provider,
    ]);
  const rejected = await reserve("gemini_free", "initial");
  await f.rpc("settle_model_call", [
    rejected.id,
    null,
    null,
    null,
    "PROVIDER_QUOTA_WAIT",
  ]);
  const fallback = await reserve("qwen_free", "fallback");
  await f.rpc("settle_model_call", [fallback.id, 100, 100, 0, null]);
  const pool = await f.rpc("model_preflight", [
    job.id,
    job.lease_token,
    JSON.stringify(manifest),
  ]);
  expect(pool.providers.map((p: any) => p.provider)).toEqual(["qwen_free"]);
  await expect(reserve("gemini_free", "changed-identity")).rejects.toThrow(
    "MODEL_IDENTITY_CHANGED",
  );
});
it("persists all automatic stages and switches versions only after completion", async () => {
  const s = await start();
  expect(
    (await f.db.query<any>("select active_version_id from public.proposals"))
      .rows[0].active_version_id,
  ).toBeNull();
  expect(await runPlan()).toBe(10);
  const p = (await f.db.query<any>("select * from public.proposals")).rows[0],
    v = (await f.db.query<any>("select * from public.proposal_versions"))
      .rows[0];
  expect(p.active_version_id).toBe(v.id);
  expect(v.status).toBe("draft");
  expect(
    (await f.db.query<any>("select status from public.generation_plans"))
      .rows[0].status,
  ).toBe("completed");
  expect(
    (await f.db.query("select * from public.requirements")).rows,
  ).toHaveLength(1);
  expect(
    (await f.db.query("select * from public.questions")).rows.length,
  ).toBeGreaterThan(0);
  await f.command("proposal.regenerate", {
    id: p.id,
    expected_revision: p.revision,
    base_version_id: v.id,
    input_hash: "b".repeat(64),
  });
  expect(
    (await f.db.query<any>("select active_version_id from public.proposals"))
      .rows[0].active_version_id,
  ).toBe(v.id);
  await runPlan();
  const versions = (
    await f.db.query<any>(
      "select * from public.proposal_versions order by ordinal",
    )
  ).rows;
  expect(versions).toHaveLength(2);
  expect(versions[0].content_hash).toBe(v.content_hash);
  expect(
    (await f.db.query<any>("select active_version_id from public.proposals"))
      .rows[0].active_version_id,
  ).toBe(versions[1].id);
});
it("rejects completion after cancellation without publishing a partial version", async () => {
  const s = await start(),
    job = await f.rpc("claim_backend_job");
  await f.command("generation.cancel", {
    id: s.plan.id,
    expected_revision: s.plan.revision,
    reason: "Synthetic cancellation",
  });
  expect(
    (await f.db.query("select * from public.proposal_versions")).rows,
  ).toHaveLength(0);
  await expect(
    f.rpc("complete_generation_step", [job.id, job.lease_token, "{}"]),
  ).rejects.toThrow("STALE_LEASE");
});
it("rejects changed supporting evidence even if a worker still holds its lease", async () => {
  const knowledge = await f.command("knowledge.save", {
    category: "company",
    title: "Changed company facts",
    content: "Synthetic evidence change",
    enabled: true,
    evidence: "",
  });
  await f.db.query(
    "update public.knowledge_items set verified=true,verified_at=now(),verified_by=$1 where id=$2",
    [f.owner, knowledge.id],
  );
  await start();
  const job = await f.rpc("claim_backend_job");
  await f.db.query(
    "update public.knowledge_items set content='Changed existing source after the plan was frozen' where id=$1",
    [knowledge.id],
  );
  await expect(
    f.rpc("generation_context", [job.id, job.lease_token]),
  ).rejects.toThrow("STALE_INPUT");
});

it("retains saved proposal work after unrelated evidence and collection metadata changes", async () => {
  const s = await start();
  let job = await f.rpc("claim_backend_job");
  const before = await f.rpc("generation_context", [job.id, job.lease_token]);
  await f.db.query(
    "update public.opportunities set notice_evidence=$2::jsonb where id=$1",
    [
      s.opp.id,
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        detail_sha256: "b".repeat(64),
      }),
    ],
  );
  const unrelated = await f.command("opportunity.create", {
    source_id: s.opp.source_id,
    title: "Unrelated synthetic notice",
    reference: "S2",
    description: "Different procurement",
    language: "en",
  });
  await f.db.query(
    "update public.opportunities set description='Updated unrelated procurement' where id=$1",
    [unrelated.id],
  );
  const after = await f.rpc("generation_context", [job.id, job.lease_token]);
  expect(after.plan.input_hash).toBe(before.plan.input_hash);
  expect(after.plan.frozen_context).toEqual(before.plan.frozen_context);
  expect(after.plan.evidence_revision).toBeGreaterThan(
    before.plan.evidence_revision,
  );
  await f.rpc("fail_generation", [
    job.id,
    job.lease_token,
    "MODEL_NOT_CONFIGURED",
    null,
    null,
  ]);
  await f.db.query(
    "update public.opportunities set notice_evidence=$2::jsonb where id=$1",
    [
      s.opp.id,
      JSON.stringify({
        fetched_at: "2026-10-20T00:00:00Z",
        detail_sha256: "c".repeat(64),
      }),
    ],
  );
  const current = (
    await f.db.query<any>("select * from public.generation_plans where id=$1", [
      s.plan.id,
    ])
  ).rows[0];
  await f.db.query(
    "update public.opportunities set description='Another unrelated update' where id=$1",
    [unrelated.id],
  );
  await f.command("generation.retry", {
    id: current.id,
    expected_revision: current.revision,
    reason: "Synthetic same-input retry",
  });
  await runPlan();
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [s.plan.id],
      )
    ).rows[0].status,
  ).toBe("completed");
}, 15000);

it("migration recovery queues only stale proposals whose actual inputs are unchanged", async () => {
  const s = await start();
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20261020070522_scoped_proposal_evidence_refresh.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const recovery = migration.match(
    /do \$recovery\$[\s\S]*?end \$recovery\$;/,
  )![0];
  const block = async () => {
    await f.db.query(
      "update public.generation_plans set status='blocked',error_code='STALE_INPUT' where id=$1",
      [s.plan.id],
    );
    await f.db.query(
      "update public.jobs set status='blocked',error_code='STALE_INPUT' where entity_id=$1",
      [s.plan.id],
    );
  };
  await f.db.query(
    "update public.workspaces set evidence_revision=evidence_revision+1 where id=$1",
    [f.w],
  );
  await block();
  await f.db.exec(recovery);
  expect(
    (
      await f.db.query<any>(
        "select status,input_hash,frozen_context from public.generation_plans where id=$1",
        [s.plan.id],
      )
    ).rows[0],
  ).toEqual({
    status: "queued",
    input_hash: s.plan.input_hash,
    frozen_context: s.plan.frozen_context,
  });
  await f.db.query(
    "update public.opportunities set description='Changed required work' where id=$1",
    [s.opp.id],
  );
  await block();
  await f.db.exec(recovery);
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [s.plan.id],
      )
    ).rows[0].status,
  ).toBe("blocked");
});

it.each(["rfp", "notice", "template"])(
  "still rejects a changed proposal input: %s",
  async (kind) => {
    const s = await start();
    const job = await f.rpc("claim_backend_job");
    if (kind === "rfp")
      await f.db.query(
        "update public.documents set archived=true where id=$1",
        [s.document.id],
      );
    if (kind === "notice")
      await f.db.query(
        "update public.opportunities set description='Changed buyer requirements' where id=$1",
        [s.opp.id],
      );
    if (kind === "template")
      await f.db.query(
        'update public.templates set content_hash=repeat(\'b\',64),fixed_blocks=\'[{"key":"changed","title":"Changed","body":"New requirement","volume":"technical"}]\'::jsonb where workspace_id=$1',
        [f.w],
      );
    await expect(
      f.rpc("generation_context", [job.id, job.lease_token]),
    ).rejects.toThrow("STALE_INPUT");
  },
);
it.each([
  ["DATABASE_TEMPORARY_FAILURE", "retry_wait"],
  ["DATABASE_COMMAND_FAILED", "blocked"],
])("handles %s without discarding durable model work", async (code, status) => {
  const { plan } = await start();
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const job = await f.rpc("claim_backend_job");
  const thread = "d".repeat(64);
  await f.db.query(
    "insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,candidate_count) values($1,$2,$3,repeat('a',64),'analyze_chunk',1)",
    [thread, f.w, job.id],
  );
  await f.db.query(
    "insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values($1,'writer-result','{\"retained\":true}',repeat('b',64))",
    [thread],
  );
  await f.db.query(
    "insert into app_private.model_graph_budgets(thread_id,unit,candidates) values($1,'writer',1)",
    [thread],
  );
  await f.db.query(
    "update public.jobs set checkpoint=jsonb_build_object('graph_thread',$2::text,'model_executor',2) where id=$1",
    [job.id, thread],
  );
  const snapshot = async () =>
    (
      await f.db.query(
        "select (select jsonb_agg(to_jsonb(r)) from app_private.model_graph_results r) results,(select jsonb_agg(to_jsonb(b)) from app_private.model_graph_budgets b) budgets,(select jsonb_agg(to_jsonb(s)) from public.generation_steps s) steps",
      )
    ).rows;
  const before = await snapshot();
  await f.rpc("fail_generation", [job.id, job.lease_token, code, null, null]);
  const saved = (
    await f.db.query<any>(
      "select *,next_attempt_at>=now()+interval '1 minute' backoff from public.jobs where id=$1",
      [job.id],
    )
  ).rows[0];
  expect(saved).toMatchObject({
    status,
    failure_count: 1,
    lease_token: null,
    checkpoint: { graph_thread: thread, model_executor: 2 },
  });
  expect(await snapshot()).toEqual(before);
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0].status,
  ).toBe(status === "retry_wait" ? "running" : "blocked");
  if (status === "retry_wait") {
    expect(saved.backoff).toBe(true);
    await f.db.query(
      "update public.jobs set next_attempt_at=now() where id=$1",
      [job.id],
    );
    const resumed = await f.rpc("claim_backend_job_v2");
    expect(resumed.id).toBe(job.id);
    expect(resumed.checkpoint).toEqual(saved.checkpoint);
    await expect(
      f.rpc("fail_generation", [job.id, job.lease_token, code, null, null]),
    ).rejects.toThrow("STALE_LEASE");
  }
});

it.each(["MODEL_OUTPUT_INVALID", "MODEL_OUTPUT_TRUNCATED"])(
  "persists one repair for %s and then blocks; retry preserves previous steps",
  async (outputError) => {
    const s = await start();
    let job = await f.rpc("claim_backend_job");
    await f.rpc("fail_generation", [
      job.id,
      job.lease_token,
      outputError,
      null,
      null,
    ]);
    expect(
      (
        await f.db.query<any>(
          "select repair_count from public.generation_steps",
        )
      ).rows[0].repair_count,
    ).toBe(1);
    await f.db.query(
      "update public.jobs set next_attempt_at=now() where id=$1",
      [job.id],
    );
    job = await f.rpc("claim_backend_job");
    await f.rpc("fail_generation", [
      job.id,
      job.lease_token,
      outputError,
      null,
      null,
    ]);
    expect(
      (await f.db.query<any>("select status from public.jobs")).rows[0].status,
    ).toBe("blocked");
    const plan = (
      await f.db.query<any>("select * from public.generation_plans")
    ).rows[0];
    await f.command("generation.retry", {
      id: plan.id,
      expected_revision: plan.revision,
      reason: "Owner reviewed the blocker",
    });
    expect(
      (
        await f.db.query<any>(
          "select repair_count from public.generation_steps",
        )
      ).rows[0].repair_count,
    ).toBe(1);
    expect(
      (await f.db.query<any>("select status from public.jobs")).rows[0].status,
    ).toBe("queued");
  },
);
it.each([
  { automatic: true, state: "unknown", resumes: true },
  { automatic: false, state: "unknown", resumes: false },
  { automatic: true, state: "reserved", resumes: false },
  { automatic: false, state: "reserved", resumes: false },
])(
  "resuming a proposal with $state usage and automatic=$automatic preserves the reservation policy",
  async ({ automatic, state, resumes }) => {
    await start();
    if (automatic)
      await f.command("model.routing", {
        enabled: true,
        expected_revision: 0,
        strategy: "round_robin",
      });
    const job = await f.rpc("claim_backend_job");
    await f.rpc("fail_generation", [
      job.id,
      job.lease_token,
      "DATA_AUTHORIZATION_REQUIRED",
      null,
      null,
    ]);
    const plan = (
      await f.db.query<any>("select * from public.generation_plans")
    ).rows[0];
    // An unrelated historical call, with unknown actual usage kept intact.
    const usage = (
      await f.db.query<any>(
        "insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) values($1,null,gen_random_uuid(),'unrelated-call','zai_free','synthetic-model',repeat('b',64),current_date,1,100,100,$2,$3) returning *",
        [f.w, state, f.owner],
      )
    ).rows[0];
    const retry = f.command("generation.retry", {
      id: plan.id,
      expected_revision: plan.revision,
      reason: "Resume after granting the missing file permission",
    });
    if (resumes) {
      await expect(retry).resolves.toMatchObject({
        id: plan.id,
        status: "queued",
      });
      const resumed = await f.rpc("claim_backend_job");
      expect(resumed.id).toBe(job.id);
      expect(resumed.attempts).toBe(2);
    } else {
      await expect(retry).rejects.toThrow("USAGE_REVIEW_REQUIRED");
    }
    expect(
      (
        await f.db.query<any>(
          "select * from public.provider_usage where id=$1",
          [usage.id],
        )
      ).rows[0],
    ).toEqual(usage);
  },
);
it("splits oversized work without dropping the original text boundaries", () => {
  const ctx: any = {
    step: {
      task: "analyze_chunk",
      depth: 0,
      input: { block_id: "b", start: 0, end: 12000 },
    },
  };
  const parts = splitStep(ctx)!;
  expect(parts).toHaveLength(2);
  expect(parts[0].start).toBe(0);
  expect(parts[1].end).toBe(12000);
  expect(parts[0].end).toBeGreaterThan(parts[1].start);
  expect(splitStep({ ...ctx, step: { ...ctx.step, depth: 8 } })).toBeNull();
});

it("keeps all standard sections and rejects an inapplicable section assignment", async () => {
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    f.owner,
  ]);
  const template = await f.rpc("template_defaults", ["ar"]);
  expect(template.required_sections).toHaveLength(17);
  expect(template.volume_mode).toBe("combined");
  const ctx: any = { plan: { frozen_context: { template } }, steps: [] };
  const sections = plannedSections(ctx);
  expect(sections).toHaveLength(17);
  expect(sections.find((s) => s.key === "financial")?.title).toBe(
    "العرض المالي",
  );
  template.required_sections[0].applicable = false;
  template.required_sections[0].rationale =
    "Owner-approved omission for this fixture";
  expect(plannedSections(ctx)).toHaveLength(16);
  ctx.steps = [
    {
      task: "plan_proposal",
      status: "completed",
      output: { sections: [{ key: "executive_summary", requirement_ids: [] }] },
    },
  ];
  expect(() => plannedSections(ctx)).toThrow("TEMPLATE_APPLICABILITY_CONFLICT");
});

it("queues material/profile reassessment only when enabled and preserves a deferred decision", async () => {
  const s = await setup();
  await f.command("opportunity.decision", {
    id: s.opp.id,
    expected_revision: s.opp.revision,
    target_state: "deferred",
    reason: "Synthetic decision preserved",
  });
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(0);
  await f.command("model.configure", {
    expected_revision: 0,
    enabled: true,
    provider: "qwen_free",
    model: "synthetic-model",
    project_ref: "synthetic",
    free_only: true,
    billing_verified: true,
    free_quota_only: true,
    quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
    quota_remaining_tokens: 100000,
    calls_per_day: 50,
    input_per_day: 250000,
    output_per_day: 50000,
  });
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(1);
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(0);
  const first = (
    await f.db.query<any>(
      "select * from public.generation_plans where kind='assessment'",
    )
  ).rows[0];
  await f.db.query(
    "update public.opportunities set description='Updated synthetic scope with more detail' where id=$1",
    [s.opp.id],
  );
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [first.id],
      )
    ).rows[0].status,
  ).toBe("canceled");
  const changedProfile = await f.command("knowledge.save", {
    category: "company",
    title: "Updated synthetic company profile",
    content: "Synthetic software capability",
    enabled: true,
  });
  await f.command("knowledge.verify", {
    id: changedProfile.id,
    expected_revision: changedProfile.revision,
  });
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select decision from public.opportunities where id=$1",
        [s.opp.id],
      )
    ).rows[0].decision,
  ).toBe("deferred");
  expect(
    (await f.db.query("select * from public.provider_usage")).rows,
  ).toHaveLength(0);
});
it("checkpoints every long review segment and gives later tasks grounded directives instead of unbounded raw comments", async () => {
  const s = await start();
  await runPlan();
  const proposal = (await f.db.query<any>("select * from public.proposals"))
    .rows[0];
  const review = await f.command("review.save", {
    id: proposal.id,
    expected_revision: proposal.revision,
    base_version_id: proposal.active_version_id,
    source_signature: "synthetic",
    inputs: [
      {
        client_id: crypto.randomUUID(),
        target_kind: "general",
        target_id: "general",
        body: "Explain acceptance testing. ".repeat(500),
      },
    ],
  });
  const current = (await f.db.query<any>("select * from public.proposals"))
    .rows[0];
  await f.command("proposal.regenerate", {
    id: current.id,
    expected_revision: current.revision,
    base_version_id: current.active_version_id,
    input_hash: "b".repeat(64),
  });
  const plan = (
    await f.db.query<any>(
      "select * from public.generation_plans where status='queued' order by created_at desc",
    )
  ).rows[0];
  const steps = (
    await f.db.query<any>(
      "select * from public.generation_steps where plan_id=$1 and task='summarize_review' order by ordinal",
      [plan.id],
    )
  ).rows;
  expect(steps.length).toBeGreaterThan(1);
  const text = plan.frozen_context.reviews[0].text;
  expect(steps[0].input.start).toBe(0);
  expect(steps.at(-1).input.end).toBe(Array.from(text).length);
  for (let i = 1; i < steps.length; i++)
    expect(steps[i].input.start).toBeLessThan(steps[i - 1].input.end);
  const ctx: any = { plan, step: steps[0], steps, requirements: [] };
  const input = taskInput(ctx);
  expect(input.task).toBe("summarize_review");
  expect(Array.from(input.evidence[0].text).length).toBe(6000);
  expect(splitStep(ctx)![0].start).toBe(0);
  const completed = steps.map((step) => ({
    ...step,
    status: "completed",
    output: {
      processed_review_ids: [step.input.review_id],
      directives: [
        {
          instruction: "Explain acceptance tests",
          source_refs: [
            { id: step.input.review_id, quote: "Explain acceptance testing." },
          ],
        },
      ],
      questions: [],
    },
  }));
  const planned = taskInput({
    ...ctx,
    steps: completed,
    step: { task: "plan_proposal", input: { requirement_ids: [] } },
  });
  expect(planned.context.review_directives.length).toBe(steps.length);
  expect(
    planned.evidence.filter((e) => e.kind === "review")[0].text.length,
  ).toBeLessThan(text.length);
});

it("splits a truncated automatic proposal response and completes without dropping RFP boundaries", async () => {
  const source = await setup(true, "Implement approval workflow. ".repeat(100));
  const plan = await f.command("proposal.generate", {
    id: source.opp.id,
    expected_revision: source.opp.revision,
  });
  await f.command("model.routing", {
    enabled: true,
    expected_revision: 0,
    strategy: "round_robin",
  });
  const job = await f.rpc("claim_backend_job");
  const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
  for (const ref of taskInput(ctx).manifest)
    await f.command("content.authorize", {
      ...ref,
      provider: "zai_free",
      attestation: "nonconfidential_nonpersonal",
    });
  const backend = {
    internal: async (name: string, args: Record<string, unknown>) => {
      const entries = Object.entries(args);
      await f.db.exec("savepoint split_rpc");
      try {
        return (
          await f.db.query<any>(
            `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) data`,
            entries.map(([, v]) =>
              v && typeof v === "object" ? JSON.stringify(v) : v,
            ),
          )
        ).rows[0]?.data;
      } catch (error) {
        await f.db.exec("rollback to savepoint split_rpc");
        throw databaseError(error as Error);
      } finally {
        await f.db.exec("release savepoint split_rpc");
      }
    },
  } as unknown as Backend;
  await processGeneration(
    backend,
    {
      models: {
        zai_free: {
          provider: "zai_free",
          model: "synthetic-model",
          projectRef: "synthetic",
          key: "synthetic-key",
        },
      },
    } as BackendEnvironment,
    job,
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: '{"requirements":[' },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 4096 },
      }),
  );
  const steps = (
    await f.db.query<any>(
      "select status,depth,input from public.generation_steps where plan_id=$1 order by depth,input->>'start'",
      [plan.id],
    )
  ).rows;
  expect(steps.filter((s) => s.status === "split")).toHaveLength(1);
  const children = steps
    .filter((s) => s.depth === 1)
    .sort((a, b) => a.input.start - b.input.start);
  expect(children).toHaveLength(2);
  expect(children[0].input.start).toBe(ctx.step.input.start);
  expect(children[1].input.end).toBe(ctx.step.input.end);
  expect(children[0].input.end).toBeGreaterThan(children[1].input.start);
  expect(
    (
      await f.db.query<any>(
        "select state,actual_input,actual_output from public.provider_usage",
      )
    ).rows,
  ).toEqual([{ state: "settled", actual_input: 1000, actual_output: 4096 }]);
  await runPlan();
  expect(
    (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0].status,
  ).toBe("completed");
}, 15000);

it.each([false, true])(
  "completes the proposal pipeline with background retrieval and round-robin=%s",
  async (automatic) => {
    const started = await start();
    await f.command("model.configure", {
      expected_revision: 0,
      enabled: true,
      provider: "gemini_free",
      model: "gemini-3.8-flash",
      project_ref: "synthetic-project",
      free_only: true,
      billing_verified: true,
      free_quota_only: false,
      quota_mode: "provider_managed",
      quota_ends_at: null,
      quota_remaining_tokens: null,
      calls_per_day: 50,
      input_per_day: 250000,
      output_per_day: 50000,
    });
    if (automatic)
      await f.command("model.routing", {
        enabled: true,
        expected_revision: 0,
        strategy: "round_robin",
      });
    const env = {
      models: {
        gemini_free: {
          provider: "gemini_free",
          model: "gemini-3.8-flash",
          projectRef: "synthetic-project",
          key: "synthetic-key",
        },
      },
    } as BackendEnvironment;
    if (automatic)
      for (const provider of [
        "qwen_free",
        "mistral_free",
        "groq_free",
      ] as const)
        env.models[provider] = {
          provider,
          model: provider === "qwen_free" ? "qwen3.5-plus" : "synthetic-model",
          projectRef:
            provider === "qwen_free" ? "synthetic" : "synthetic-project",
          key: "synthetic-key",
        };
    const backend = {
      internal: async (name: string, args: Record<string, unknown>) => {
        const entries = Object.entries(args);
        await f.db.exec("savepoint background_rpc");
        try {
          return (
            await f.db.query<any>(
              `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) data`,
              entries.map(([, v]) =>
                v && typeof v === "object" ? JSON.stringify(v) : v,
              ),
            )
          ).rows[0]?.data;
        } catch (e) {
          await f.db.exec("rollback to savepoint background_rpc");
          throw databaseError(e as Error);
        } finally {
          await f.db.exec("release savepoint background_rpc");
        }
      },
    } as unknown as Backend;
    let creates = 0,
      gets = 0,
      deletes = 0;
    let alternateCalls = 0,
      rejected = 0;
    const responses = new Map<string, unknown>();
    for (let i = 0; i < 60; i++) {
      await f.db.exec(
        "update public.jobs set next_attempt_at=now()-interval '1 second' where status in ('retry_wait','quota_wait');update public.provider_usage set created_at=now()-interval '2 minutes'",
      );
      const job = await f.rpc("claim_backend_job");
      if (!job) break;
      const ctx = await f.rpc("generation_context", [job.id, job.lease_token]);
      if (ctx.step.task !== "advance_plan")
        for (const ref of taskInput(ctx).manifest)
          for (const provider of automatic
            ? ["gemini_free", "qwen_free", "mistral_free", "groq_free"]
            : ["gemini_free"])
            await f.command("content.authorize", {
              ...ref,
              provider,
              attestation: "nonconfidential_nonpersonal",
            });
      await processGeneration(backend, env, job, async (url, init) => {
        if (init?.method === "DELETE") {
          expect(
            (
              await f.db.query<any>(
                "select status from public.jobs where id=$1",
                [job.id],
              )
            ).rows[0].status,
          ).toBe("succeeded");
          deletes++;
          return new Response(null, { status: 204 });
        }
        if (String(url).endsWith(":countTokens"))
          return Response.json({ totalTokens: 100 });
        if (!String(url).includes("googleapis")) {
          alternateCalls++;
          return Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(resultFor(ctx)) },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          });
        }
        if (automatic && !rejected && init?.method === "POST") {
          rejected++;
          return new Response(null, { status: 400 });
        }
        if (init?.method === "POST") {
          const id = `synthetic-pipeline-${++creates}`;
          responses.set(id, resultFor(ctx));
          return Response.json({ id, status: "in_progress" });
        }
        gets++;
        const id = String(url).split("/").at(-1)!;
        return Response.json({
          id,
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [
                { type: "text", text: JSON.stringify(responses.get(id)) },
              ],
            },
          ],
          usage: {
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_thought_tokens: 0,
          },
        });
      });
    }
    const plan = (
      await f.db.query<any>(
        "select status from public.generation_plans where id=$1",
        [started.plan.id],
      )
    ).rows[0];
    expect(plan.status).toBe("completed");
    expect(creates + alternateCalls).toBeGreaterThan(4);
    if (automatic) {
      expect(alternateCalls).toBeGreaterThan(0);
      expect(rejected).toBe(1);
    }
    expect(gets).toBe(creates);
    expect(deletes).toBe(creates);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.provider_usage where state='settled'",
        )
      ).rows[0].n,
    ).toBe(creates + alternateCalls + rejected);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.provider_usage where state<>'settled'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await f.db.query<any>("select count(*)::int n from public.requirements"))
        .rows[0].n,
    ).toBeGreaterThan(0);
  },
);

it("runs every proposal stage through durable verification without a company library or custom template, and produces a draft export", async () => {
  const { defaultCapabilities } =
    await import("../../supabase/functions/_shared/modelContract");
  const { modelEnvironments } =
    await import("../../supabase/functions/_shared/backend");
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await f.command("model.connection.save", {
    provider: "groq_free",
    label: "Pipeline fixture",
    credential_alias: "APP_MODEL_GROQ_KEY",
    project_ref: "fixture",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Pipeline model",
    model: "fixture-model",
    enabled: true,
    capabilities: defaultCapabilities("groq_free"),
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
  const source = await setup();
  await f.db.exec("delete from public.templates");
  const plan = await f.command("proposal.generate", {
    id: source.opp.id,
    expected_revision: source.opp.revision,
  });
  const env = {
    models: modelEnvironments((key) =>
      key === "APP_MODEL_GROQ_KEY"
        ? "fixture-key"
        : key.endsWith("_PROJECT")
          ? "fixture"
          : undefined,
    ),
  } as BackendEnvironment;
  const internal = async (name: string, args: Record<string, unknown> = {}) => {
    const entries = Object.entries(args);
    await f.db.exec("savepoint graph_pipeline_rpc;set local role service_role");
    try {
      return (
        await f.db.query<any>(
          `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) value`,
          entries.map(([, v]) =>
            v && typeof v === "object" ? JSON.stringify(v) : v,
          ),
        )
      ).rows[0].value;
    } catch (e) {
      await f.db.exec("rollback to savepoint graph_pipeline_rpc");
      throw databaseError(e as Error);
    } finally {
      await f.db.exec("reset role;release savepoint graph_pipeline_rpc");
    }
  };
  let verifications = 0,
    creations = 0;
  for (let i = 0; i < 120; i++) {
    const job = await internal("claim_backend_job_v2");
    if (!job) break;
    const ctx = await internal("generation_context", {
      job_id: job.id,
      lease: job.lease_token,
    });
    if (ctx.step.task !== "advance_plan")
      for (const ref of taskInput(ctx).manifest)
        await f.command("content.authorize", {
          ...ref,
          provider: "groq_free",
          attestation: "nonconfidential_nonpersonal",
        });
    await processGeneration(
      { internal } as unknown as Backend,
      env,
      job,
      async (_url, init) => {
        const prompt = JSON.parse(
          JSON.parse(String(init?.body)).messages[1].content.split(
            "\nJSON schema: ",
          )[0],
        );
        let result;
        if (prompt.task === "verify_grounding") {
          verifications++;
          const c = prompt.untrusted_data;
          result = {
            checked_candidate_hash: c.candidate_hash,
            reviewed_all_content: true,
            processed_content_ids: c.content_units.map((u: any) => u.id),
            claims: [
              {
                id: "fixture-claim",
                claim: c.content_units[0].text,
                candidate_quote: c.content_units[0].text,
                kind: "proposed_solution",
                status: "supported",
                source_refs: [],
                finding:
                  "Synthetic proposed response, not a claim of experience.",
              },
            ],
            processed_requirement_ids: prompt.required_ids,
            requirement_checks: prompt.required_ids.map((id: string) => ({
              requirement_id: id,
              status: "supported",
              candidate_quote: c.content_units[0].text,
              source_refs: [],
              finding: "Fixture coverage.",
            })),
            findings: [],
          };
        } else {
          creations++;
          result = resultFor(ctx);
        }
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(result) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
      },
    );
  }
  const savedPlan = (
    await f.db.query<any>(
      "select status,error_code from public.generation_plans where id=$1",
      [plan.id],
    )
  ).rows[0];
  expect(savedPlan).toEqual({ status: "completed", error_code: null });
  expect(verifications).toBe(creations);
  expect(creations).toBeGreaterThanOrEqual(20);
  const version = (
    await f.db.query<any>("select * from public.proposal_versions")
  ).rows[0];
  const exportRequest = await f.command("export.prepare", {
    proposal_version_id: version.id,
    expected_revision: version.revision,
    mode: "draft",
    volume: "combined",
  });
  const exported = buildExportModel(exportRequest);
  expect(exported.blocks.length).toBeGreaterThan(17);
  expect(
    (
      await f.db.query<any>(
        "select status,count(*)::int n from app_private.model_graph_threads group by status",
      )
    ).rows,
  ).toEqual([{ status: "committed", n: creations }]);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.knowledge_items",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.db.query<any>(
        "select count(*)::int n from public.model_attempts where operation='verify_grounding' and execution_metadata->>'same_model_verification'='true'",
      )
    ).rows[0].n,
  ).toBe(verifications);
  await expect(
    f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "final",
      volume: "combined",
    }),
  ).rejects.toThrow("APPROVAL_REQUIRED");
}, 60000);
