/** Authored offline prerequisites for actual workflow request construction.
 * Completed in-memory stage records are test inputs, never provider outcomes,
 * machine assurance, authenticated acceptance or evidence of live execution. */
import { readFile } from "node:fs/promises";
import { CORPUS_SHA256, sha256, type ReserveCase } from "./reserve.mjs";
import {
  taskInput,
  nextStage,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import {
  materializeSourceCandidate,
  canonicalSourceSpanId,
  resolveSourceSpan,
  sourceEvidenceContractSchema,
  assertSourceBlockHash,
} from "../../supabase/functions/_shared/sourceEvidence.ts";
import { requirementAliases } from "../../supabase/functions/_shared/proposalBlueprint.ts";
import { primaryModelSchemas } from "../../supabase/functions/_shared/modelSchemas.ts";

export const WORKFLOW_PREREQUISITES_SHA256 =
  "d93440770497a1491793f2065fe822900a3a2a9fce3e3885443bfcf59cb2b322";
const fixtureUrl = new URL(
  "../../tests/backend/fixtures/qualification-reserve/workflow-prerequisites-v1.json",
  import.meta.url,
);
const tasks = new Set([
  "plan_structure",
  "plan_blueprint",
  "plan_proposal",
  "draft_section",
  "plan_commercial",
  "review_proposal",
]);
export const workflowConstructible = (row: ReserveCase) =>
  tasks.has(row.task) && row.scenario !== "proposed_method";
const uuid = (name: string) => {
  const h = sha256(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}

export async function loadWorkflowPrerequisites() {
  const bytes = await readFile(fixtureUrl);
  check(
    sha256(bytes) === WORKFLOW_PREREQUISITES_SHA256,
    "RESERVE_PREREQUISITES_CHANGED",
  );
  const value = JSON.parse(bytes.toString());
  check(
    value.version === 1 &&
      value.corpus_sha256 === CORPUS_SHA256 &&
      value.cases.length === 22,
    "RESERVE_PREREQUISITE_CENSUS",
  );
  return value;
}

export async function buildWorkflowInput(
  caseId: string,
  material: ReturnType<typeof import("./reserve.mjs").publicCase>,
) {
  const fixture = (await loadWorkflowPrerequisites()).cases.find(
    (r: any) => r.case_id === caseId,
  );
  return buildAuthoredWorkflowInput(
    caseId,
    material,
    fixture,
    WORKFLOW_PREREQUISITES_SHA256,
  );
}
/** Shared constructor; qualified entrypoints must load a separately hashed fixture. */
export async function buildAuthoredWorkflowInput(
  caseId: string,
  material: ReturnType<typeof import("./reserve.mjs").publicCase>,
  fixture: any,
  prerequisiteSha: string,
) {
  check(fixture, "RESERVE_WORKFLOW_PREREQUISITES_MISSING");
  check(
    fixture.approved_na_decisions.length === 0 &&
      Object.values(fixture.commercial_draft).every(
        (v: any) => Array.isArray(v) && v.length === 0,
      ),
    "RESERVE_UNAUTHORED_APPROVAL_OR_COMMERCIAL",
  );
  const documents = new Map<string, any>(
    material.documents.map((d: any) => [d.id, d]),
  );
  const sourceProjection: any[] = [];
  const blocks: any[] = [];
  const spans: any[] = [];
  const knowledge: any[] = [];
  const reviews: any[] = [];
  const draftDocuments: any[] = [];
  const selectedDocs = new Set<string>(
    fixture.requirements.map((r: any) => r.document_id),
  );
  const uses = new Map<string, string>(
    fixture.additional_source_uses.map((r: any) => [r.document_id, r.channel]),
  );
  check(
    selectedDocs.size + uses.size === documents.size,
    "RESERVE_SOURCE_NOT_MAPPED",
  );
  for (const doc of material.documents) {
    const base = {
      id: doc.entity_id,
      text: doc.text,
      verified: false,
      reference: {
        entity_kind: "document",
        entity_id: doc.entity_id,
        content_hash: doc.sha256,
      },
      block_hash: doc.sha256,
      extraction_version: "reserve-workflow-v1",
      locator: { kind: "extracted_character_range" },
    };
    check(sha256(doc.text) === doc.sha256, "RESERVE_SOURCE_CHANGED");
    if (selectedDocs.has(doc.id)) {
      check(
        doc.authority_role === "buyer_rfp" &&
          doc.authority_status === "confirmed",
        "RESERVE_REQUIREMENT_AUTHORITY",
      );
      const source: any = { ...base, kind: "rfp" };
      await assertSourceBlockHash(source);
      blocks.push(source);
      const canonical = doc.spans.map((span: any) => {
        const value: any = {
          version: 1,
          id: "pending",
          entity_kind: "document",
          entity_id: doc.entity_id,
          content_hash: doc.sha256,
          extraction_version: base.extraction_version,
          block_id: source.id,
          block_hash: doc.sha256,
          coordinate: "unicode_code_point",
          start: span.start,
          end: span.end,
          quote: span.quote,
          locator: source.locator,
          authority: {
            version: 1,
            decision_id: uuid(doc.id + ":authority"),
            revision: 1,
            role: doc.authority_role,
            status: doc.authority_status,
            supersedes: null,
            precedence: 0,
          },
        };
        value.id = canonicalSourceSpanId(value);
        resolveSourceSpan(value, source);
        return value;
      });
      spans.push(...canonical);
      sourceProjection.push({
        corpus_document_id: doc.id,
        canonical_id: source.id,
        source_sha256: doc.sha256,
        original_authority: doc.authority_role,
        channel: "buyer_requirement_source",
        spans: doc.spans.map((s: any, i: number) => ({
          corpus_span_id: s.id,
          canonical_span_id: canonical[i].id,
          start: s.start,
          end: s.end,
          quote_sha256: sha256(s.quote),
        })),
      });
    } else {
      const channel = uses.get(doc.id);
      if (channel === "verified_company_knowledge") {
        check(
          doc.authority_role === "company_evidence" &&
            doc.authority_status === "confirmed" &&
            doc.verified === true,
          "RESERVE_COMPANY_AUTHORITY",
        );
        knowledge.push({
          ...base,
          kind: "company",
          verified: true,
          reference: { ...base.reference, entity_kind: "knowledge" },
        });
      } else if (channel === "unverified_style_knowledge") {
        check(doc.authority_role === "reference", "RESERVE_STYLE_AUTHORITY");
        knowledge.push({
          ...base,
          kind: "style",
          verified: false,
          reference: { ...base.reference, entity_kind: "knowledge" },
        });
      } else if (channel === "untrusted_review_note") {
        check(doc.authority_role === "reference", "RESERVE_REVIEW_AUTHORITY");
        reviews.push({
          ...base,
          kind: "review",
          target_kind: "general",
          target_id: "general",
          reference: { ...base.reference, entity_kind: "review" },
        });
      } else if (channel === "authored_draft_under_review") {
        check(
          doc.authority_role === "supplier_proposal",
          "RESERVE_DRAFT_AUTHORITY",
        );
        draftDocuments.push(doc);
      } else throw Error("RESERVE_SOURCE_CHANNEL_UNKNOWN");
      sourceProjection.push({
        corpus_document_id: doc.id,
        canonical_id: doc.entity_id,
        source_sha256: doc.sha256,
        original_authority: doc.authority_role,
        channel,
      });
    }
  }
  const contract = sourceEvidenceContractSchema.parse({
    version: 1,
    spans,
    reviews: [],
  });
  const frozen = {
    notice: {
      id: uuid(caseId + ":notice"),
      text: "",
      kind: "notice",
      verified: false,
    },
    blocks,
    knowledge,
    reviews,
    rates: [],
    template: { id: uuid(caseId + ":template"), required_sections: [] },
    source_contract_version: 1,
    repair_contract_version: 1,
    source_evidence: contract,
    draft_input_version: 1,
    company_retrieval_version: 1,
    company_followup_version: 1,
    input_materials: {
      documents: blocks.map((b) => ({
        document_id: b.id,
        used_for_draft: true,
      })),
    },
  };
  const plan: any = {
    id: uuid(caseId + ":plan"),
    kind: "proposal",
    workflow_version: material.task === "plan_proposal" ? 1 : 3,
    stage: "analysis",
    frozen_context: frozen,
  };
  const ctx: any = { plan, step: null, steps: [], requirements: [] };
  const checks: any[] = [];
  for (const block of blocks) {
    const original = material.documents.find((d) => d.entity_id === block.id)!;
    const records = fixture.requirements
      .filter((r: any) => r.document_id === original.id)
      .map((r: any) => {
        check(
          r.semantic_review_status === "pending" &&
            original.text.includes(r.interpretation),
          "RESERVE_REQUIREMENT_INTERPRETATION",
        );
        const selected = r.source_span_ids.map((id: string) => {
          const i = original.spans.findIndex((s: any) => s.id === id);
          check(i >= 0, "RESERVE_REQUIREMENT_SPAN");
          return contract.spans.find(
            (s) =>
              s.block_id === block.id &&
              s.start === original.spans[i].start &&
              s.end === original.spans[i].end,
          )!;
        });
        return {
          text: original.text,
          category: r.category,
          mandatory: r.mandatory,
          interpretation: r.interpretation,
          acceptance_evidence: "",
          owner_question: null,
          source_refs: selected.map((s: any) => ({ id: s.id, quote: s.quote })),
          source_semantics: {
            version: 1,
            source_span_ids: selected.map((s: any) => s.id),
            authority_role: original.authority_role,
            authority_status: original.authority_status,
            modality: r.mandatory ? "required" : "permitted",
            actor: null,
            negated: null,
            conditions: [],
            exceptions: [],
            consequences: [],
            quantities: [],
            dates: [],
            review_status: "pending",
            review_id: null,
          },
        };
      });
    ctx.step = {
      id: uuid(caseId + ":analysis:" + block.id),
      task: "analyze_chunk",
      input: {
        block_id: block.id,
        start: 0,
        end: Array.from(block.text).length,
      },
    };
    const input = taskInput(ctx);
    const output = materializeSourceCandidate(
      "analyze_chunk",
      {
        processed_block_ids: [block.id],
        requirements: records,
        questions: [],
        separate_volumes: material.workflow_facts.separate_volumes === true,
        summary: "",
      },
      input.context,
      input.evidence,
    );
    validateGenerationResult(ctx, input, output);
    ctx.steps.push({
      ...ctx.step,
      status: "completed",
      ordinal: ctx.steps.length,
      output,
    });
    checks.push({
      task: "analyze_chunk",
      kind: "authored_prerequisite",
      schema_and_domain: "passed",
      semantic_model_review: "not_performed",
    });
  }
  const inventory = await nextStage(ctx);
  ctx.requirements = inventory.requirements;
  const keys = new Map<string, string>();
  for (const row of fixture.requirements) {
    const doc = documents.get(row.document_id);
    const matches = ctx.requirements.filter(
      (r: any) =>
        r.interpretation === row.interpretation &&
        r.source_refs.some((ref: any) =>
          contract.spans.some(
            (s) => s.id === ref.id && s.entity_id === doc.entity_id,
          ),
        ),
    );
    check(matches.length === 1, "RESERVE_REQUIREMENT_IDENTITY_AMBIGUOUS");
    keys.set(row.key, matches[0].id);
  }
  const aliases = requirementAliases(ctx.requirements);
  const alias = (key: string) => {
    const id = keys.get(key);
    check(id, "RESERVE_REQUIREMENT_KEY_UNKNOWN");
    return aliases.get(id)!;
  };
  const sections = fixture.organizational_sections.map((s: any) => ({
    key: s.key,
    title: s.title,
    purpose: s.purpose,
    volume: s.volume,
    mode: "narrative",
    requirement_ids: s.requirement_keys.map(alias),
  }));
  if (material.task === "plan_proposal") {
    ctx.plan.stage = "planning";
    ctx.step = { id: uuid(caseId + ":target"), ...inventory.steps[0] };
  } else if (material.task === "plan_structure") {
    ctx.plan.stage = "planning";
    ctx.step = { id: uuid(caseId + ":target"), ...inventory.steps[0] };
  } else {
    ctx.plan.stage = "planning";
    ctx.step = { id: uuid(caseId + ":structure"), ...inventory.steps[0] };
    const output = primaryModelSchemas.plan_structure.parse({
      version: 3,
      sections,
      decisions: [],
      questions: [],
    });
    validateGenerationResult(ctx, taskInput(ctx), output);
    ctx.steps.push({
      ...ctx.step,
      status: "completed",
      ordinal: ctx.steps.length,
      output,
    });
    checks.push({
      task: "plan_structure",
      kind: "authored_prerequisite",
      schema_and_domain: "passed",
      semantic_model_review: "not_performed",
    });
    const detail = await nextStage(ctx);
    check(detail.steps.length === 1, "RESERVE_DETAIL_REQUEST_COUNT_CHANGED");
    ctx.plan.stage = "detailing";
    ctx.step = { id: uuid(caseId + ":target"), ...detail.steps[0] };
    if (material.task !== "plan_blueprint") {
      const output = primaryModelSchemas.plan_blueprint.parse({
        version: 2,
        processed_requirement_ids: [...aliases.values()],
        sections: sections.map((s: any) => ({
          key: s.key,
          title: s.title,
          purpose: s.purpose,
          volume: s.volume,
          mode: s.mode,
          units: [
            {
              key: "main",
              title: s.title,
              purpose: s.purpose,
              requirement_ids: s.requirement_ids,
              secondary_links: [],
              target_words: fixture.authoring_unit_target_words,
              decision_ids: [],
            },
          ],
        })),
        decisions: [],
        questions: [],
      });
      validateGenerationResult(ctx, taskInput(ctx), output);
      ctx.steps.push({
        ...ctx.step,
        status: "completed",
        ordinal: ctx.steps.length,
        output,
      });
      checks.push({
        task: "plan_blueprint",
        kind: "authored_prerequisite",
        schema_and_domain: "passed",
        semantic_model_review: "not_performed",
      });
      const drafting = await nextStage(ctx);
      check(drafting.steps.length === 1, "RESERVE_DRAFT_REQUEST_COUNT_CHANGED");
      ctx.plan.stage = "drafting";
      ctx.step = { id: uuid(caseId + ":target"), ...drafting.steps[0] };
      if (material.task !== "draft_section") {
        const text = draftDocuments.length
          ? draftDocuments.map((d) => d.text).join("\n\n")
          : blocks.map((b) => b.text).join("\n\n");
        const section = ctx.step.input.section;
        const output = primaryModelSchemas.draft_section.parse({
          key: section.key,
          title: section.title,
          content_blocks: [{ type: "paragraph", text }],
          requirement_ids: ctx.step.input.requirement_ids,
          evidence_refs: [],
          company_claims: [],
          assumptions: [],
          questions: [],
        });
        // Drafts are authored inputs under examination. Passing deterministic
        // shape/source checks does not assert fulfillment or prior verifier success.
        validateGenerationResult(ctx, taskInput(ctx), output);
        ctx.steps.push({
          ...ctx.step,
          status: "completed",
          ordinal: ctx.steps.length,
          output,
        });
        checks.push({
          task: "draft_section",
          kind: draftDocuments.length
            ? "authored_draft_under_review"
            : "authored_source_restatement",
          schema_and_domain: "passed",
          semantic_model_review: "not_performed",
        });
        if (material.task === "plan_commercial") {
          const commercial = await nextStage(ctx);
          check(
            commercial.steps.length === 1,
            "RESERVE_COMMERCIAL_REQUEST_COUNT_CHANGED",
          );
          ctx.plan.stage = "commercial";
          ctx.step = { id: uuid(caseId + ":target"), ...commercial.steps[0] };
        } else {
          // Derive the real scoped review request; no implicit extra call or
          // invented commercial result/approval is hidden in this adapter.
          ctx.plan.stage = "synthesis";
          const review = await nextStage(ctx);
          check(
            review.steps.length === 1,
            "RESERVE_REVIEW_REQUEST_COUNT_CHANGED",
          );
          ctx.plan.stage = "review";
          ctx.step = { id: uuid(caseId + ":target"), ...review.steps[0] };
        }
      }
    }
  }
  const actual = taskInput(ctx);
  check(actual.task === material.task, "RESERVE_TASK_PROJECTION_CHANGED");
  return {
    ...actual,
    domainValidate: (result: unknown) =>
      validateGenerationResult(ctx, actual, result),
    trace: {
      context_constructor:
        "generation.taskInput + nextStage + validateGenerationResult; explicitly authored in-memory prerequisites",
      workflow_prerequisites_sha256: prerequisiteSha,
      workflow_version: ctx.plan.workflow_version,
      legacy_registered_task: material.task === "plan_proposal",
      source_projection: sourceProjection,
      requirement_projection: [...keys].map(([key, id]) => ({
        corpus_requirement_key: key,
        canonical_id: id,
        planning_alias: aliases.get(id),
      })),
      prerequisite_checks: checks,
      prerequisite_model_calls: 0,
      prerequisite_database_admission: false,
      prerequisite_semantic_approval: false,
    },
  };
}
