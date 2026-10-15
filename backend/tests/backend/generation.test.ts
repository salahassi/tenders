// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  nextStage,
  plannedSections,
  taskInput,
  splitStep,
} from "../../supabase/functions/_shared/generation";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));
async function setup(confirm = true) {
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
    size: 50,
    hash: "a".repeat(64),
  });
  const d = await f.rpc("accept_uploaded_document", [
    document.id,
    f.owner,
    "a".repeat(64),
    50,
    "Implement approval workflow.",
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
        section_ids: ["s3-approach"],
        evidence_refs: refs,
        rationale: "The response describes approval workflow.",
      })),
      findings: [],
    };
  throw Error("Unexpected task");
}
async function runPlan() {
  let count = 0;
  for (;;) {
    const job = await f.rpc("claim_backend_job");
    if (!job) break;
    if (++count > 30) throw Error("Unbounded fixture");
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
        JSON.stringify(resultFor(ctx)),
      ]);
  }
  return count;
}
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
  await start();
  const job = await f.rpc("claim_backend_job");
  await f.command("knowledge.save", {
    category: "company",
    title: "Changed company facts",
    content: "Synthetic evidence change",
    enabled: true,
    evidence: "",
  });
  await expect(
    f.rpc("generation_context", [job.id, job.lease_token]),
  ).rejects.toThrow("STALE_INPUT");
});
it("persists one repair and then blocks invalid output; retry preserves previous steps", async () => {
  const s = await start();
  let job = await f.rpc("claim_backend_job");
  await f.rpc("fail_generation", [
    job.id,
    job.lease_token,
    "MODEL_OUTPUT_INVALID",
    null,
    null,
  ]);
  expect(
    (await f.db.query<any>("select repair_count from public.generation_steps"))
      .rows[0].repair_count,
  ).toBe(1);
  await f.db.query("update public.jobs set next_attempt_at=now() where id=$1", [
    job.id,
  ]);
  job = await f.rpc("claim_backend_job");
  await f.rpc("fail_generation", [
    job.id,
    job.lease_token,
    "MODEL_OUTPUT_INVALID",
    null,
    null,
  ]);
  expect(
    (await f.db.query<any>("select status from public.jobs")).rows[0].status,
  ).toBe("blocked");
  const plan = (await f.db.query<any>("select * from public.generation_plans"))
    .rows[0];
  await f.command("generation.retry", {
    id: plan.id,
    expected_revision: plan.revision,
    reason: "Owner reviewed the blocker",
  });
  expect(
    (await f.db.query<any>("select repair_count from public.generation_steps"))
      .rows[0].repair_count,
  ).toBe(1);
  expect(
    (await f.db.query<any>("select status from public.jobs")).rows[0].status,
  ).toBe("queued");
});
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

it("queues material/profile reassessment only when enabled and preserves a declined decision", async () => {
  const s = await setup();
  await f.command("opportunity.decision", {
    id: s.opp.id,
    expected_revision: s.opp.revision,
    target_state: "declined",
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
  await f.command("knowledge.save", {
    category: "company",
    title: "Updated synthetic company profile",
    content: "Synthetic software capability",
    enabled: true,
  });
  expect((await f.rpc("schedule_assessment_refresh")).scheduled).toBe(1);
  expect(
    (
      await f.db.query<any>(
        "select decision from public.opportunities where id=$1",
        [s.opp.id],
      )
    ).rows[0].decision,
  ).toBe("declined");
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
