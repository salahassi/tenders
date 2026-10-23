// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import {
  taskInput,
  nextStage,
} from "../../supabase/functions/_shared/generation";
import {
  modelPrompt,
  taskSystemInstructions,
  validateModelResult,
  validateScopeDecision,
  type ModelTask,
} from "../../supabase/functions/_shared/model";
import {
  SCOPE_COMPARISON_INSTRUCTIONS_V1,
  SCOPE_COMPARISON_PROMPT_V1,
  scopeComparisonApplies,
} from "../../supabase/functions/_shared/modelScopeInstructions";

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function note(content: string, verified = true, category = "company") {
  const saved = await f.command("knowledge.save", {
    title: "Synthetic specialization",
    category,
    content,
    enabled: true,
  });
  return verified
    ? f.command("knowledge.verify", {
        id: saved.id,
        expected_revision: saved.revision,
      })
    : saved;
}

async function snapshot(opportunityId: string) {
  const frozen = (
    await f.db.query<any>(
      "select app_private.generation_snapshot($1,$2,null,null) value",
      [f.w, opportunityId],
    )
  ).rows[0].value;
  return {
    plan: { stage: "assessment", frozen_context: frozen },
    step: { task: "classify_opportunity", input: {} },
    steps: [] as any[],
    requirements: [],
  };
}

async function setup(description: string, specialization?: string) {
  const revision = (
    await f.db.query<any>(
      "select revision from public.workspaces where id=$1",
      [f.w],
    )
  ).rows[0].revision;
  await f.command("discovery.configure", {
    expected_revision: revision,
    scope: "company_knowledge",
    include_keywords: [],
    exclude_keywords: [],
    auto_public_notices: false,
    auto_company_knowledge: false,
    providers: [],
  });
  const company = specialization ? await note(specialization) : null;
  const source = await f.command("source.create", {
    name: "Synthetic contextual scope source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic procurement",
    description,
    language: "en",
  });
  return {
    company,
    opportunity,
    ctx: await snapshot(opportunity.id),
  };
}

function response(
  ctx: Awaited<ReturnType<typeof snapshot>>,
  status: "in_scope" | "out_of_scope" | "uncertain",
  reason: string,
) {
  const input = taskInput(ctx);
  const company = input.evidence.find((e) => e.kind === "company");
  const unknown = {
    rating: null,
    reason:
      "Project-specific capacity and qualification evidence is unavailable.",
    notice_evidence: [],
    company_evidence: [],
  };
  return {
    factors: {
      capability: unknown,
      scope: unknown,
      sector: unknown,
      prerequisite: unknown,
    },
    scope_decision: {
      status,
      reason,
      notice_evidence: [
        { id: input.evidence[0].id, quote: input.evidence[0].text },
      ],
      company_evidence: company
        ? [{ id: company.id, quote: company.text }]
        : [],
      keyword_evidence: [],
    },
    critical_unknown: true,
    reason_summary: reason,
    missing_information: [
      "Confirm project-specific capacity and qualifications.",
    ],
    risk_flags: [],
    suggested_tags: [],
  };
}

async function accept(
  ctx: Awaited<ReturnType<typeof snapshot>>,
  result: ReturnType<typeof response>,
) {
  const input = taskInput(ctx);
  validateModelResult("classify_opportunity", result, input.evidence);
  validateScopeDecision(result, ctx.plan.frozen_context.discovery_scope_policy);
  ctx.steps = [
    {
      stage: "assessment",
      task: "classify_opportunity",
      status: "completed",
      output: result,
    },
  ];
  return (await nextStage(ctx)).final_result!;
}

// These tests check supplied database evidence and model-output handling. The
// explicit model responses are fixtures, not measured semantic-model accuracy.
it("retains an indirect model scope match without keyword overlap or proof of project capacity", async () => {
  const description =
    "Redesign the outdoor courtyards using planting layouts and paths.";
  const specialization =
    "Synthetic studio specializes in landscape architecture.";
  const { ctx } = await setup(description, specialization);
  const input = taskInput(ctx);
  expect(input.context.scope_policy).toEqual({
    scope: "company_knowledge",
    include_keywords: [],
    exclude_keywords: [],
  });
  expect(input.evidence.map((e) => e.kind)).toEqual(["notice", "company"]);
  expect(input.evidence[0].text).toContain(description);
  expect(input.evidence[0].text).not.toMatch(/landscape|architecture/i);
  expect(input.evidence[1].text).toContain(specialization);
  const result = response(
    ctx,
    "in_scope",
    "The requested courtyard planning is within the documented specialization.",
  );
  const saved = await accept(ctx, result);
  expect(saved.result.scope_decision.status).toBe("in_scope");
  expect(saved.result.factors.capability.rating).toBeNull();
  expect(saved.result.factors.prerequisite.rating).toBeNull();
  expect(saved.routing).not.toBe("excluded");
});

it("accepts a cited model mismatch with no explicit exclusion or company incapability claim", async () => {
  const { ctx } = await setup(
    "Supply protective welding gloves in the specified sizes.",
    "Synthetic company prepares and delivers catered meals.",
  );
  const result = response(
    ctx,
    "out_of_scope",
    "The purchased protective clothing is unrelated to the documented catering specialization.",
  );
  const saved = await accept(ctx, result);
  expect(saved.routing).toBe("excluded");
  expect(saved.result.scope_decision.keyword_evidence).toEqual([]);
  expect(saved.result.metadata.scope_policy.exclude_keywords).toEqual([]);
  expect(saved.result.factors.capability.rating).toBeNull();
  expect(saved.result.factors.prerequisite.rating).toBeNull();
  result.scope_decision.company_evidence[0].quote = "Invented specialization";
  expect(() =>
    validateModelResult(
      "classify_opportunity",
      result,
      taskInput(ctx).evidence,
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("keeps scope uncertain when Company Knowledge cannot establish specialization", async () => {
  const { ctx, opportunity } = await setup(
    "Provide transport planning services.",
  );
  await note("Synthetic company provides transport planning.", false);
  await note(
    "Synthetic historical proposal for transport planning.",
    false,
    "previous_proposal",
  );
  const refreshed = await snapshot(opportunity.id);
  expect(taskInput(refreshed).evidence.map((e) => e.kind)).toEqual(["notice"]);
  const result = response(
    ctx,
    "uncertain",
    "No verified company specialization was supplied for comparison.",
  );
  expect((await accept(refreshed, result)).routing).toBe("needs_review");
  result.scope_decision.status = "out_of_scope";
  expect(() =>
    validateScopeDecision(
      result,
      refreshed.plan.frozen_context.discovery_scope_policy,
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});

it("uses edited verified database knowledge for later snapshots while retaining prior evidence", async () => {
  const original = "Synthetic company specializes in catering.";
  const replacement = "Synthetic company supplies protective workwear.";
  const { ctx, company, opportunity } = await setup(
    "Supply protective welding gloves.",
    original,
  );
  const first = taskInput(ctx);
  const edited = await f.command("knowledge.save", {
    id: company.id,
    expected_revision: company.revision,
    title: "Synthetic specialization",
    category: "company",
    content: replacement,
    enabled: true,
  });
  expect(taskInput(await snapshot(opportunity.id)).evidence).toHaveLength(1);
  await f.command("knowledge.verify", {
    id: edited.id,
    expected_revision: edited.revision,
  });
  const next = taskInput(await snapshot(opportunity.id));
  expect(next.evidence[1].text).toContain(replacement);
  expect(next.evidence[1].text).not.toContain(original);
  expect(
    next.manifest.find((ref) => ref.entity_id === company.id)?.content_hash,
  ).not.toBe(
    first.manifest.find((ref) => ref.entity_id === company.id)?.content_hash,
  );
  expect(taskInput(ctx)).toEqual(first);
  expect(first.evidence[1].text).toContain(original);
});

it.each([
  ["classify_opportunity", {}],
  ["verify_grounding", { original_task: "classify_opportunity" }],
  ["repair_result", { target_task: "classify_opportunity" }],
] as [ModelTask, Record<string, string>][])(
  "gives %s the same trusted comparison policy without changing database evidence",
  async (task, taskContext) => {
    const { ctx } = await setup(
      "Prepare planting layouts for a public courtyard.",
      "Synthetic studio specializes in landscape architecture.",
    );
    const input = taskInput(ctx);
    const context =
      task === "classify_opportunity"
        ? input.context
        : { ...taskContext, original_context: input.context };
    expect(scopeComparisonApplies(task, context)).toBe(true);
    const envelope = JSON.parse(
      modelPrompt(task, context, input.evidence, [], "en", false, 2, 3),
    );
    expect(envelope.scope_comparison_policy).toBe(
      SCOPE_COMPARISON_INSTRUCTIONS_V1,
    );
    expect(envelope.untrusted_data).toEqual(context);
    expect(envelope.evidence).toEqual(input.evidence);
    expect(envelope.prompt_version).toContain(
      `.${SCOPE_COMPARISON_PROMPT_V1}.`,
    );
    expect(envelope.prompt_version).toMatch(
      /\.tenderdesk-semantic-fidelity-v1\.economy-v1$/,
    );
    expect(envelope.prompt_version.length).toBeLessThanOrEqual(100);
    expect(taskSystemInstructions(task, 2, 3)).toContain(
      SCOPE_COMPARISON_INSTRUCTIONS_V1,
    );
    for (const revision of [0, 1, 2] as const) {
      const legacy = JSON.parse(
        modelPrompt(
          task,
          context,
          input.evidence,
          [],
          "en",
          false,
          2,
          revision,
        ),
      );
      expect(legacy).not.toHaveProperty("scope_comparison_policy");
      expect(taskSystemInstructions(task, 2, revision)).not.toContain(
        SCOPE_COMPARISON_INSTRUCTIONS_V1,
      );
    }
  },
);

it("limits scope policy to classification rather than unrelated drafting or verification", () => {
  expect(scopeComparisonApplies("draft_section", {})).toBe(false);
  expect(scopeComparisonApplies("connection_probe", {})).toBe(false);
  expect(
    scopeComparisonApplies("verify_grounding", {
      original_task: "review_proposal",
    }),
  ).toBe(false);
  expect(
    scopeComparisonApplies("repair_result", { target_task: "draft_section" }),
  ).toBe(false);
});
