import { expect } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  nextStage,
  taskInput,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import {
  candidateContent,
  validateGroundingReport,
  groundingOptions,
} from "../../supabase/functions/_shared/modelGrounding.ts";
import { qualifierHash } from "../../supabase/functions/_shared/proposalConsistency.ts";
export async function assembledResolutionFixture(
  frozen: any,
  rs: any[],
  body: string,
) {
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
          "/tmp/source-resolution-fixture-error.json",
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
      processed_content_ids: units.map((u) => u.id),
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
      requirement_checks: scope.requiredIds.map((id) => ({
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
