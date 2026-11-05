/** Direct verifier-stage inputs; no preceding provider result is asserted. */
import { readFile } from "node:fs/promises";
import { CORPUS_SHA256, sha256, type publicCase } from "./reserve.mjs";
import {
  taskInput,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import {
  canonicalSourceSpanId,
  resolveSourceSpan,
  assertSourceBlockHash,
  sourceEvidenceContractSchema,
  materializeSourceCandidate,
} from "../../supabase/functions/_shared/sourceEvidence.ts";
import {
  candidateContent,
  validateGroundingReport,
  groundingOptions,
} from "../../supabase/functions/_shared/modelGrounding.ts";
import { verificationContext } from "../../supabase/functions/_shared/modelGraph.ts";
import {
  verificationBatches,
  verificationPolicy,
} from "../../supabase/functions/_shared/modelVerification.ts";
import { pinVerificationPrompt } from "../../supabase/functions/_shared/modelVerificationPrompt.ts";
import type { Ledger } from "../../supabase/functions/_shared/model.ts";
export const VERIFIER_PREREQUISITES_SHA256 =
  "c7a5d975a0337c5abd6dc60113bad0bf66c5e61e81711b8a74c2c90b47071e2e";
const url = new URL(
  "../../tests/backend/fixtures/qualification-reserve/verifier-prerequisites-v1.json",
  import.meta.url,
);
const uuid = (name: string) => {
  const h = sha256(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export async function loadVerifierPrerequisites() {
  const bytes = await readFile(url);
  check(
    sha256(bytes) === VERIFIER_PREREQUISITES_SHA256,
    "RESERVE_VERIFIER_PREREQUISITES_CHANGED",
  );
  const value = JSON.parse(bytes.toString());
  check(
    value.version === 1 &&
      value.corpus_sha256 === CORPUS_SHA256 &&
      value.cases.length === 4,
    "RESERVE_VERIFIER_CENSUS",
  );
  return value;
}
export async function buildVerifierInput(
  caseId: string,
  material: ReturnType<typeof publicCase>,
  phase: { store: any; backend: any; job: { id: string; lease_token: string } },
) {
  const fixture = (await loadVerifierPrerequisites()).cases.find(
    (r: any) => r.case_id === caseId,
  );
  check(
    fixture &&
      fixture.original_task === "analyze_chunk" &&
      material.documents.length === 1,
    "RESERVE_VERIFIER_ORIGINAL_TASK",
  );
  const doc = material.documents[0];
  check(
    doc.id === fixture.source_document_id && sha256(doc.text) === doc.sha256,
    "RESERVE_VERIFIER_SOURCE",
  );
  const source: any = {
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
    extraction_version: "reserve-verifier-v1",
    locator: { kind: "extracted_character_range" },
  };
  await assertSourceBlockHash(source);
  const spans = doc.spans.map((span: any) => {
    const value: any = {
      version: 1,
      id: "pending",
      entity_kind: "document",
      entity_id: doc.entity_id,
      content_hash: doc.sha256,
      extraction_version: source.extraction_version,
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
    blocks: [source],
    reviews: [],
    knowledge: [],
    rates: [],
    template: { id: uuid(caseId + ":template"), required_sections: [] },
    source_contract_version: 1,
    repair_contract_version: 1,
    source_evidence: contract,
    draft_input_version: 1,
    input_materials: {
      documents: [{ document_id: doc.entity_id, used_for_draft: true }],
    },
  };
  const originalCtx: any = {
    plan: {
      id: uuid(caseId + ":plan"),
      kind: "proposal",
      frozen_context: frozen,
    },
    step: {
      id: uuid(caseId + ":analysis"),
      task: "analyze_chunk",
      input: {
        block_id: source.id,
        start: 0,
        end: Array.from(source.text).length,
      },
    },
    requirements: [],
    steps: [],
  };
  const original = taskInput(originalCtx);
  const candidate = materializeSourceCandidate(
    "analyze_chunk",
    {
      processed_block_ids: [source.id],
      requirements: [
        {
          text: doc.text,
          category: fixture.category,
          mandatory: fixture.mandatory,
          source_refs: spans.map((s: any) => ({ id: s.id, quote: s.quote })),
          interpretation: fixture.interpretation,
          acceptance_evidence: "",
          owner_question: null,
          source_semantics: {
            version: 1,
            source_span_ids: spans.map((s: any) => s.id),
            authority_role: doc.authority_role,
            authority_status: doc.authority_status,
            ...fixture.source_semantics,
          },
        },
      ],
      questions: [],
      separate_volumes: false,
      summary: "",
    },
    original.context,
    original.evidence,
  );
  validateGenerationResult(originalCtx, original, candidate);
  check(
    verificationBatches(candidate, verificationPolicy(original.context))
      .length === 0,
    "RESERVE_VERIFIER_REQUIRES_MULTIPLE_REQUESTS",
  );
  const hash = sha256(JSON.stringify(candidate)),
    units = candidateContent(candidate);
  const legacy = {
    original_task: "analyze_chunk",
    original_context: original.context,
    candidate,
    candidate_hash: hash,
    candidate_text: units.map((u) => u.text).join("\n"),
    content_units: units,
  };
  const phaseOptions = {
    backend: phase.backend,
    job: phase.job,
    requestPrefix: `reserve:${caseId}`,
    evidence: original.evidence,
    requiredIds: original.requiredIds,
    language: material.language as "ar" | "en",
    repair: false,
  };
  // Only the no-existing-reservation/new-phase branch is declared here. This
  // does not assert a live configured route or provider availability.
  const ledger = {
    preflight: async () => ({
      providers: [],
      routing_mode: "round_robin",
      executor_version: 2,
    }),
  } as unknown as Ledger;
  const context = await verificationContext(
    phase.store,
    ledger,
    legacy,
    original.manifest,
    { phase: phaseOptions, typedCandidate: candidate },
  );
  const revision = await pinVerificationPrompt({
    ...phaseOptions,
    store: phase.store,
    context,
  });
  return {
    context,
    evidence: original.evidence,
    manifest: original.manifest,
    requiredIds: original.requiredIds,
    verificationRevision: revision,
    domainValidate: (report: unknown) =>
      validateGroundingReport(
        report,
        candidate,
        hash,
        original.evidence,
        original.requiredIds,
        undefined,
        groundingOptions(original.context),
      ),
    trace: {
      context_constructor:
        "actual analysis taskInput/materialization + verificationContext + pinVerificationPrompt + validateGroundingReport",
      verifier_prerequisites_sha256: VERIFIER_PREREQUISITES_SHA256,
      candidate_sha256: hash,
      original_context_sha256: sha256(JSON.stringify(original.context)),
      candidate_origin: "authored_direct_verifier_input",
      prior_provider_success: false,
      prior_semantic_approval: false,
      request_count: 1,
      source_projection: [
        {
          corpus_document_id: doc.id,
          canonical_id: source.id,
          source_sha256: doc.sha256,
          original_authority: doc.authority_role,
          spans: doc.spans.map((s: any, i: number) => ({
            corpus_span_id: s.id,
            canonical_span_id: spans[i].id,
            start: s.start,
            end: s.end,
            quote_sha256: sha256(s.quote),
          })),
        },
      ],
    },
  };
}
