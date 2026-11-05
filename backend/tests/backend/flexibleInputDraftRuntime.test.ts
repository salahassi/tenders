import { sourceContractFixture } from "./sourceContractFixture";
// @vitest-environment node
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { workflowFixture, claimModelWorker5 } from "./workflowFixture";
import {
  taskInput,
  processGeneration,
} from "../../supabase/functions/_shared/generation";
import {
  draftInputPolicyVersion,
  validateModelResult,
} from "../../supabase/functions/_shared/model";
import { databaseError } from "../../supabase/functions/_shared/http";
import { defaultCapabilities } from "../../supabase/functions/_shared/modelContract";
import {
  modelEnvironments,
  type Backend,
  type BackendEnvironment,
} from "../../supabase/functions/_shared/backend";
import { buildExportModel } from "../../supabase/functions/_shared/export";

const notice = {
  id: "notice-source",
  kind: "notice",
  text: "Implement an approval workflow.",
  verified: false,
  reference: {
    entity_kind: "notice",
    entity_id: "notice-source",
    content_hash: "a".repeat(64),
  },
};
const reference = {
  id: "reference-block",
  kind: "rfp",
  text: "Historical example for a different buyer. This is reference material, not a request for proposal.",
  verified: false,
  reference: {
    entity_kind: "document",
    entity_id: "reference-document",
    content_hash: "b".repeat(64),
  },
};
function context(task: string, marker = true): any {
  return {
    plan: {
      kind: "proposal",
      workflow_version: 1,
      frozen_context: {
        ...(marker ? { draft_input_version: 1 } : {}),
        title: "Workflow draft",
        language: "en",
        notice,
        blocks: [reference],
        knowledge: [],
        reviews: [],
        rates: [],
        template: { id: "neutral", required_sections: [], fixed_blocks: [] },
        input_materials: {
          version: 1,
          documents: [],
          uses_notice_fallback: false,
        },
      },
    },
    step: {
      id: "step",
      task,
      input:
        task === "analyze_chunk"
          ? { block_id: reference.id, start: 0, end: reference.text.length }
          : {
              requirement_ids: [],
              section: {
                key: "approach",
                title: "Proposed approach",
                volume: "technical",
              },
            },
    },
    requirements: [],
    steps: [],
  };
}

it.each([
  "plan_proposal",
  "plan_commercial",
  "review_proposal",
  "draft_section",
])(
  "keeps actual authorized evidence for zero-inventory %s without company data",
  (task) => {
    const input = taskInput(context(task));
    expect(input.manifest.length).toBeGreaterThan(0);
    expect(input.manifest).toContainEqual(notice.reference);
    expect(input.requiredIds).toEqual([]);
    expect(input.context.draft_input_version).toBe(1);
    expect(input.context.instruction).toContain(
      "not required to be a formal RFP",
    );
    expect(input.context.instruction).toContain("Do not invent requirements");
    expect(
      input.evidence.every((source) =>
        [notice.id, reference.id].includes(source.id),
      ),
    ).toBe(true);
    expect(input.evidence.every((source) => source.kind !== "company")).toBe(
      true,
    );
  },
);
it("preserves historical task contexts and restricts notice analysis to the versioned draft policy", () => {
  const legacy = taskInput(context("plan_proposal", false));
  expect(legacy.context).not.toHaveProperty("draft_input_version");
  expect(legacy.context.instruction).not.toContain(
    "not required to be a formal RFP",
  );
  const requirement = {
    text: notice.text,
    category: "functional",
    mandatory: false,
    source_refs: [{ id: notice.id, quote: notice.text }],
    interpretation: "Requested workflow.",
    acceptance_evidence: "Demonstrate the proposed workflow.",
    owner_question: null,
  };
  const result = {
    processed_block_ids: [notice.id],
    requirements: [requirement],
    questions: [],
    separate_volumes: false,
    summary: "Supplied notice.",
  };
  expect(() =>
    validateModelResult("analyze_chunk", result, [notice] as any, [notice.id]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(() =>
    validateModelResult("analyze_chunk", result, [notice] as any, [notice.id], {
      draftInputVersion: 1,
    }),
  ).not.toThrow();
  expect(() =>
    validateModelResult(
      "analyze_chunk",
      result,
      [{ ...notice, kind: "company", verified: true }] as any,
      [notice.id],
      { draftInputVersion: 1 },
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
  expect(
    draftInputPolicyVersion("repair_result", {
      original_context: { draft_input_version: 1 },
    }),
  ).toBe(1);
  expect(
    draftInputPolicyVersion("analyze_chunk", { draft_input_version: 2 }),
  ).toBeUndefined();
});

it("keeps notice fallback analysis within its selected segment", () => {
  const selected = context("analyze_chunk");
  selected.plan.frozen_context.blocks = [notice];
  selected.step.input = { block_id: notice.id, start: 0, end: 12 };
  const input = taskInput(selected);
  expect(input.evidence).toHaveLength(1);
  expect(input.evidence[0].text).toBe(notice.text.slice(0, 12));
  expect(input.manifest).toEqual([notice.reference]);
});

let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => f?.db.close());
beforeEach(async () => f.db.exec("begin"));
afterEach(async () => f.db.exec("rollback"));

async function setup(
  readable: boolean,
  extractInventory = false,
  mixed = false,
  workflow = 3,
) {
  await f.command("model.routing", { enabled: true, expected_revision: 0 });
  const connection = await f.command("model.connection.save", {
    provider: "groq_free",
    label: "Synthetic flexible draft",
    credential_alias: "APP_MODEL_GROQ_KEY",
    project_ref: "fixture",
    enabled: true,
    expected_revision: 0,
  });
  const model = await f.command("model.configuration.save", {
    connection_id: connection.id,
    label: "Synthetic flexible model",
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
  await f.db.query(
    "update app_private.proposal_workflow_admission set enabled=$1,trial_opportunity_id=null",
    [workflow === 3],
  );
  const source = await f.command("source.create", {
    name: "Synthetic source",
    kind: "manual",
  });
  const opportunity = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic workflow draft",
    reference: "SYNTHETIC",
    decision: "shortlisted",
    description: notice.text,
    language: "en",
  });
  const prepared = await f.command("document.prepare", {
    eligibility_attested: true,
    kind: "rfp",
    opportunity_id: opportunity.id,
    original_name: "synthetic-reference.txt",
    mime_type: "text/plain",
    size: 150,
    hash: "c".repeat(64),
  });
  const document = await f.rpc("accept_uploaded_document", [
    prepared.id,
    f.owner,
    "c".repeat(64),
    150,
    readable ? (extractInventory ? notice.text : reference.text) : "",
    readable ? "ready" : "needs_processing",
    crypto.randomUUID(),
  ]);
  let skipped: any = null;
  if (mixed) {
    const pending = await f.command("document.prepare", {
      eligibility_attested: true,
      kind: "rfp",
      opportunity_id: opportunity.id,
      original_name: "synthetic-unread-addendum.txt",
      mime_type: "text/plain",
      size: 100,
      hash: "e".repeat(64),
    });
    skipped = await f.rpc("accept_uploaded_document", [
      pending.id,
      f.owner,
      "e".repeat(64),
      100,
      "",
      "needs_processing",
      crypto.randomUUID(),
    ]);
  }
  const plan = await f.command("proposal.generate", {
    id: opportunity.id,
    expected_revision: opportunity.revision,
  });
  return { plan, document, skipped };
}
function proposedResult(ctx: any, extractInventory: boolean): any {
  const input = taskInput(ctx);
  if (input.task === "analyze_chunk") {
    const source = input.evidence.find((item) =>
      input.requiredIds.includes(item.id),
    )!;
    return sourceContractFixture(input, {
      processed_block_ids: input.requiredIds,
      requirements: extractInventory
        ? [
            {
              text: notice.text,
              category: "functional",
              mandatory: false,
              source_refs: [{ id: source.id, quote: notice.text }],
              interpretation: "Requested workflow scope.",
              acceptance_evidence: "Demonstrate the workflow.",
              owner_question: null,
            },
          ]
        : [],
      questions: [
        {
          question:
            "Confirm the target scope; the uploaded material is only reference input.",
          blocking_level: "advisory",
          requirement_ids: [],
        },
      ],
      separate_volumes: false,
      summary: extractInventory
        ? "Draft scope from the supplied evidence."
        : "Reference-only draft input; no formal requirement inventory is asserted.",
    });
  }
  if (input.task === "plan_proposal") {
    const required = input.context.template.required_sections.filter(
      (section: any) => section.applicable,
    );
    const sections = required.length
      ? required
      : [
          {
            key: "approach",
            title: "Proposed approach",
            purpose: "Describe proposed work",
            volume: "technical",
          },
        ];
    return {
      processed_requirement_ids: input.requiredIds,
      sections: sections.map((section: any, index: number) => ({
        key: section.key,
        title: section.title,
        purpose: section.purpose,
        volume: section.volume,
        requirement_ids: index === 0 ? input.requiredIds : [],
      })),
      questions: [],
    };
  }
  if (input.task === "plan_structure") {
    const template = input.context.template.required_sections.filter(
      (section: any) => section.applicable,
    );
    const sections = (
      template.length
        ? template
        : [
            {
              key: "approach",
              title: "Proposed approach",
              purpose: "Describe proposed work",
              volume: "technical",
            },
          ]
    ).map((section: any, index: number) => ({
      key: section.key,
      title: section.title,
      purpose: section.purpose.slice(0, 600),
      volume: section.volume,
      mode: "narrative",
      requirement_ids:
        index === 0 ? input.context.blueprint_requirement_ids : [],
    }));
    return { version: 3, sections, decisions: [], questions: [] };
  }
  if (input.task === "plan_blueprint")
    return {
      version: 2,
      processed_requirement_ids: input.context.blueprint_requirement_ids,
      sections: input.context.assigned_sections.map((section: any) => ({
        key: section.key,
        title: section.title,
        purpose: section.purpose,
        volume: section.volume,
        mode: section.mode,
        units: [
          {
            key: section.key + "-unit",
            title: section.title,
            purpose: section.purpose,
            requirement_ids: section.requirement_ids,
            secondary_links: [],
            target_words: 100,
            decision_ids: [],
          },
        ],
      })),
      decisions: [],
      questions: [],
    };
  if (input.task === "draft_section")
    return {
      key: ctx.step.input.section.key,
      title: ctx.step.input.section.title,
      content_blocks: [
        {
          type: "paragraph",
          text: "We propose a staged discovery, delivery and handover approach for an approval workflow, subject to confirming the target scope.",
        },
      ],
      requirement_ids: input.requiredIds,
      evidence_refs: [],
      company_claims: [],
      assumptions: [
        "The target scope requires confirmation before a binding offer.",
      ],
      questions: [],
    };
  if (input.task === "plan_commercial")
    return {
      lines: [],
      tasks: [],
      questions: [
        {
          question: "Confirm quantities and approved rates before final use.",
          blocking_level: "finalization",
          requirement_ids: [],
        },
      ],
    };
  if (input.task === "review_proposal")
    return {
      processed_requirement_ids: input.requiredIds,
      responses: input.requiredIds.map((id) => ({
        requirement_id: id,
        status: "answered",
        section_ids: input.context.sections.map((section: any) => section.key),
        evidence_refs: [],
        rationale:
          "The saved conditional approach addresses the approval workflow scope.",
      })),
      findings: [
        {
          severity: "advisory",
          category: "input_coverage",
          detail:
            "This is a proposed draft with incomplete source requirements; it is not a final compliance assertion.",
          section_ids: [],
          requirement_ids: [],
        },
      ],
    };
  throw Error("Unexpected bounded draft task: " + input.task);
}

it.each([
  {
    label: "non-RFP reference and zero requirements",
    readable: true,
    extractInventory: false,
    mixed: false,
    workflow: 3,
  },
  {
    label: "unread attachment and zero requirements",
    readable: false,
    extractInventory: false,
    mixed: false,
    workflow: 3,
  },
  {
    label: "a valid scope plus an unread addendum",
    readable: true,
    extractInventory: true,
    mixed: true,
    workflow: 3,
  },
  {
    label: "real notice requirements when the attachment is unread",
    readable: false,
    extractInventory: true,
    mixed: false,
    workflow: 3,
  },
  {
    label: "legacy workflow with non-RFP reference and zero requirements",
    readable: true,
    extractInventory: false,
    mixed: false,
    workflow: 1,
  },
  {
    label: "legacy workflow with unread attachment and zero requirements",
    readable: false,
    extractInventory: false,
    mixed: false,
    workflow: 1,
  },
])(
  "produces a usable verified draft with $label",
  async ({ readable, extractInventory, mixed, workflow }) => {
    const { plan, document, skipped } = await setup(
      readable,
      extractInventory,
      mixed,
      workflow,
    );
    expect(plan.frozen_context.draft_input_version).toBe(1);
    expect(plan.workflow_version).toBe(workflow);
    const env = {
      models: modelEnvironments((key) =>
        key === "APP_MODEL_GROQ_KEY"
          ? "fixture-key"
          : key.endsWith("_PROJECT")
            ? "fixture"
            : undefined,
      ),
    } as BackendEnvironment;
    const internal = async (
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const entries = Object.entries(args);
      await f.db.exec(
        "savepoint flexible_pipeline_rpc;set local role service_role",
      );
      try {
        return (
          await f.db.query<any>(
            `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) value`,
            entries.map(([, value]) =>
              value && typeof value === "object"
                ? JSON.stringify(value)
                : value,
            ),
          )
        ).rows[0].value;
      } catch (error) {
        await f.db.exec("rollback to savepoint flexible_pipeline_rpc");
        throw databaseError(error as Error);
      } finally {
        await f.db.exec("reset role;release savepoint flexible_pipeline_rpc");
      }
    };
    const manifests: any[] = [];
    let creations = 0,
      verifications = 0;
    for (let index = 0; index < 120; index++) {
      // This fixture proves model drafting and its legacy export projection.
      // The completed plan now queues a distinct local v3 delivery projection;
      // its actual execution/issuance is covered by generatedDeliveryPipeline.
      if ((await f.db.query<{ status: string }>(
        "select status from public.generation_plans where id=$1", [plan.id],
      )).rows[0].status === "completed") break;
      const job = await claimModelWorker5(f, internal);
      if (!job) break;
      const ctx = await internal("generation_context", {
        job_id: job.id,
        lease: job.lease_token,
      });
      if (ctx.step.task !== "advance_plan") {
        const input = taskInput(ctx);
        expect(input.manifest.length).toBeGreaterThan(0);
        manifests.push(...input.manifest);
      }
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
          let result: any;
          if (prompt.task === "verify_grounding") {
            verifications++;
            const candidate = prompt.untrusted_data;
            result = {
              checked_candidate_hash: candidate.candidate_hash,
              reviewed_all_content: true,
              processed_content_ids: candidate.content_units.map(
                (unit: any) => unit.id,
              ),
              claims:
                candidate.verification_scope === "requirements_only"
                  ? []
                  : candidate.content_units.map((unit: any, index: number) => ({
                      id: "proposed-" + index,
                      claim:
                        "Proposed draft structure or explicit input limitation.",
                      candidate_quote: unit.text,
                      kind:
                        extractInventory && unit.text === notice.text
                          ? "tender_fact"
                          : "assumption",
                      status: "supported",
                      source_refs:
                        extractInventory && unit.text === notice.text
                          ? [
                              {
                                id: prompt.evidence.find((source: any) =>
                                  source.text.includes(notice.text),
                                ).id,
                                quote: notice.text,
                              },
                            ]
                          : [],
                      finding:
                        "Synthetic conditional draft content does not assert company credentials, completed delivery or buyer compliance.",
                    })),
              processed_requirement_ids: prompt.required_ids,
              requirement_checks: prompt.required_ids.map((id: string) => ({
                requirement_id: id,
                status: "supported",
                candidate_quote:
                  candidate.content_units.find((unit: any) =>
                    unit.text.includes("approval workflow"),
                  )?.text || candidate.content_units[0].text,
                source_refs: [],
                finding:
                  "The bounded proposed draft preserves the processed input identity.",
              })),
              findings: [],
            };
          } else {
            creations++;
            result = proposedResult(ctx, extractInventory);
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
    const saved = (
      await f.db.query<any>(
        "select status,error_code from public.generation_plans where id=$1",
        [plan.id],
      )
    ).rows[0];
    expect(saved).toEqual({ status: "completed", error_code: null });
    expect(creations).toBeGreaterThan(5);
    expect(verifications).toBeGreaterThanOrEqual(creations);
    expect(
      (
        await f.db.query<any>(
          "select count(*)::int n from public.requirements where plan_id=$1",
          [plan.id],
        )
      ).rows[0].n,
    ).toBe(extractInventory ? 1 : 0);
    const version = (
      await f.db.query<any>(
        "select * from public.proposal_versions where plan_id=$1",
        [plan.id],
      )
    ).rows[0];
    const prepared = await f.command("export.prepare", {
      proposal_version_id: version.id,
      expected_revision: version.revision,
      mode: "draft",
      volume: "combined",
    });
    const exported = buildExportModel(prepared);
    expect(
      exported.blocks.some((block: any) =>
        JSON.stringify(block).includes("staged discovery"),
      ),
    ).toBe(true);
    const questions = (
      await f.db.query<any>(
        "select question,blocking_level from public.questions where proposal_version_id=$1",
        [version.id],
      )
    ).rows;
    expect(
      questions.some(
        (question: any) => question.blocking_level === "finalization",
      ),
    ).toBe(true);
    if (!readable) {
      expect(
        manifests.every(
          (ref: any) =>
            ref.entity_kind !== "document" || ref.entity_id !== document.id,
        ),
      ).toBe(true);
      expect(
        questions.some((question: any) =>
          question.question.includes("synthetic-reference.txt"),
        ),
      ).toBe(true);
    }
    if (mixed) {
      expect(skipped).toBeTruthy();
      expect(
        manifests.every(
          (ref: any) =>
            ref.entity_kind !== "document" || ref.entity_id !== skipped.id,
        ),
      ).toBe(true);
      expect(
        questions.some(
          (question: any) =>
            question.blocking_level === "finalization" &&
            question.question.includes("synthetic-unread-addendum.txt"),
        ),
      ).toBe(true);
      expect(
        questions.some((question: any) =>
          question.question.includes("none could be extracted"),
        ),
      ).toBe(false);
    }
    expect(
      (
        await f.db.query<any>(
          "select extraction_confirmed_at from public.documents where id=$1",
          [document.id],
        )
      ).rows[0].extraction_confirmed_at,
    ).toBeNull();
    await expect(
      f.command("export.prepare", {
        proposal_version_id: version.id,
        expected_revision: version.revision,
        mode: "final",
        volume: "combined",
      }),
    ).rejects.toThrow("APPROVAL_REQUIRED");
  },
  60000,
);
