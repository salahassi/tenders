/** Executable boundary evidence, not a relaxed oracle or semantic pass. */
import { expect, it } from "vitest";
import {
  loadReserve,
  publicCase,
} from "../../scripts/qualification/reserve.mjs";
import {
  taskInput,
  nextStage,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import {
  canonicalSourceSpanId,
  materializeSourceCandidate,
} from "../../supabase/functions/_shared/sourceEvidence.ts";
import { buildSemanticPatchScope } from "../../supabase/functions/_shared/modelSemanticPatch.ts";
import { ModelError } from "../../supabase/functions/_shared/model.ts";

async function context(caseId: string) {
  const { corpus } = await loadReserve();
  const material = publicCase(corpus.cases.find((row) => row.id === caseId)!);
  const blocks = material.documents.map((doc) => ({
    id: doc.entity_id,
    text: doc.text,
    kind: "rfp",
    verified: false,
    reference: {
      entity_kind: "document",
      entity_id: doc.entity_id,
      content_hash: doc.sha256,
    },
    block_hash: doc.sha256,
    extraction_version: "reserve-boundary-v1",
    locator: { kind: "extracted_character_range" },
  }));
  const spans = material.documents.flatMap((doc, index) =>
    doc.spans.map((range: any) => {
      const span: any = {
        version: 1,
        id: "pending",
        entity_kind: "document",
        entity_id: doc.entity_id,
        content_hash: doc.sha256,
        extraction_version: "reserve-boundary-v1",
        block_id: doc.entity_id,
        block_hash: doc.sha256,
        coordinate: "unicode_code_point",
        start: range.start,
        end: range.end,
        quote: range.quote,
        locator: blocks[index].locator,
        authority: {
          version: 1,
          decision_id: doc.entity_id,
          revision: 1,
          role: doc.authority_role,
          status: doc.authority_status,
          precedence: 0,
          supersedes:
            doc.authority_role === "buyer_addendum"
              ? {
                  entity_id: material.documents[0].entity_id,
                  content_hash: material.documents[0].sha256,
                }
              : null,
        },
      };
      span.id = canonicalSourceSpanId(span);
      return span;
    }),
  );
  const frozen = {
    notice: { id: "empty", text: "", kind: "notice", verified: false },
    blocks,
    reviews: [],
    knowledge: [],
    rates: [],
    template: { id: "synthetic", required_sections: [] },
    source_contract_version: 1,
    repair_contract_version: 1,
    source_evidence: { version: 1, spans, reviews: [] },
  };
  return { material, blocks, spans, frozen };
}
function requirement(span: any, interpretation = span.quote) {
  return {
    text: span.quote,
    category: "deliverables",
    mandatory: true,
    source_refs: [{ id: span.id, quote: span.quote }],
    interpretation,
    acceptance_evidence: "",
    owner_question: null,
    source_semantics: {
      version: 1,
      source_span_ids: [span.id],
      authority_role: span.authority.role,
      authority_status: span.authority.status,
      review_status: "pending",
      review_id: null,
      modality: "required",
      actor: null,
      negated: false,
      conditions: [],
      exceptions: [],
      consequences: [],
      quantities: [],
      dates: [],
    },
  };
}
it.each(["en", "ar"])(
  "records%s scoped-addendum aggregation gap without inventing a resolved requirement",
  async (language) => {
    const { material, frozen, spans, blocks } = await context(
      `qr1.analyze_chunk.addendum_precedence.${language}`,
    );
    const steps = blocks.map((block, index) => ({
      id: block.id,
      task: "analyze_chunk",
      status: "completed",
      input: {
        block_id: block.id,
        start: 0,
        end: Array.from(block.text).length,
      },
      output: {
        processed_block_ids: [block.id],
        requirements: [requirement(spans[index])],
        questions: [],
        summary: block.text,
        separate_volumes: false,
      },
    }));
    const ctx: any = {
      plan: {
        id: blocks[0].id,
        kind: "proposal",
        stage: "analysis",
        workflow_version: 2,
        frozen_context: frozen,
      },
      step: steps[0],
      requirements: [],
      steps,
    };
    for (const step of steps)
      validateGenerationResult(
        { ...ctx, step },
        taskInput({ ...ctx, step }),
        step.output,
      );
    const output = await nextStage(ctx);
    expect(output.requirements).toHaveLength(2);
    expect(output.requirements.map((r) => r.text)).toEqual(
      material.documents.map((d) => d.text),
    );
    expect(
      output.requirements.map((r) => r.source_semantics.review_status),
    ).toEqual(["pending", "pending"]);
    // The source authority carries document identity, not the frozen textual
    // replacement scope. Deduplication is not governing-obligation resolution.
    expect(Object.keys(spans[1].authority.supersedes).sort()).toEqual([
      "content_hash",
      "entity_id",
    ]);
    expect(material.workflow_facts.supersedes.scope).toBeTruthy();
  },
);
it.each(["en", "ar"])(
  "records%s proposed-method style exclusion at the actual planning selector",
  async (language) => {
    const { material, frozen, spans } = await context(
      `qr1.plan_structure.proposed_method.${language}`,
    );
    const buyer = { ...requirement(spans[0]), id: "buyer-req" };
    const supplier = material.documents[1];
    const ctx: any = {
      plan: {
        kind: "proposal",
        frozen_context: {
          ...frozen,
          blocks: [frozen.blocks[0]],
          source_evidence: { version: 1, spans: [spans[0]], reviews: [] },
          knowledge: [
            {
              id: supplier.entity_id,
              text: supplier.text,
              kind: "style",
              verified: false,
              reference: {
                entity_kind: "knowledge",
                entity_id: supplier.entity_id,
                content_hash: supplier.sha256,
              },
            },
          ],
        },
      },
      step: {
        task: "plan_proposal",
        input: {
          workflow_version: 2,
          planning_phase: "structure",
          requirement_ids: [buyer.id],
        },
      },
      requirements: [buyer],
      steps: [],
    };
    const input = taskInput(ctx);
    expect(input.task).toBe("plan_structure");
    expect(input.evidence.some((e) => e.id === supplier.entity_id)).toBe(false);
    expect(
      input.evidence.some((e) => e.text.includes(material.documents[0].text)),
    ).toBe(true);
    // This explicit synthetic mapping tests only selector behavior. It does not
    // claim the DB routes a supplied document into the knowledge collection.
  },
);
it.each(["en", "ar"])(
  "records%s citation-only auto-materialization and broader identity repair dependency",
  async (language) => {
    const { frozen, spans, blocks, material } = await context(
      `qr1.repair_result.citation_only_repair.${language}`,
    );
    const candidate = {
      processed_block_ids: [blocks[0].id],
      requirements: [requirement(spans[0]), requirement(spans[0])],
      questions: [],
      summary: blocks[0].text,
      separate_volumes: false,
    };
    candidate.requirements[1].mandatory = false;
    candidate.requirements[1].source_semantics.modality = "permitted";
    const ctx: any = {
      plan: { kind: "proposal", frozen_context: frozen },
      requirements: [],
      steps: [],
      step: {
        task: "analyze_chunk",
        input: {
          block_id: blocks[0].id,
          start: 0,
          end: Array.from(blocks[0].text).length,
        },
      },
    };
    const input = taskInput(ctx);
    const quoteFault = structuredClone(candidate);
    quoteFault.requirements[0].source_refs[0].quote = "incorrect citation text";
    expect(
      materializeSourceCandidate(
        "analyze_chunk",
        quoteFault,
        input.context,
        input.evidence,
      ),
    ).toEqual(candidate);
    const identityFault = structuredClone(candidate);
    identityFault.requirements[0].source_refs[0].id = "unknown-span";
    let failure: ModelError | undefined;
    try {
      validateGenerationResult(ctx, input, identityFault);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      failure = error;
    }
    expect(failure?.validationDiagnostics.length).toBeGreaterThan(0);
    const scope = await buildSemanticPatchScope({
      task: "analyze_chunk",
      candidate: identityFault,
      diagnostics: failure!.validationDiagnostics,
      omittedDiagnosticCount: failure!.omittedValidationDiagnosticCount,
    });
    const parents = material.workflow_facts.allowed_paths;
    expect(
      scope.paths.some(
        (p) =>
          !parents.some(
            (parent: string) =>
              p.path === parent ||
              p.path.startsWith(parent + "[") ||
              p.path.startsWith(parent + "."),
          ),
      ),
    ).toBe(true);
    expect(
      scope.paths.some((p) =>
        p.path.includes("$.requirements[0].interpretation"),
      ),
    ).toBe(true);
    expect(
      scope.paths.every((p) => !p.path.startsWith("$.requirements[1]")),
    ).toBe(true);
  },
);
