/** Explicit synthetic notice projection; never an assertion of collection. */
import { readFile } from "node:fs/promises";
import { sha256, CORPUS_SHA256, type publicCase } from "./reserve.mjs";
import {
  taskInput,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import { serviceScopeSchema } from "../../supabase/functions/_shared/discovery.ts";
export const ASSESSMENT_PREREQUISITES_SHA256 =
  "fbc9f3382a17263fea80de7b7071d221bd3e6e785aeade61d759b907d4751a2b";
const url = new URL(
  "../../tests/backend/fixtures/qualification-reserve/assessment-prerequisites-v1.json",
  import.meta.url,
);
const uuid = (name: string) => {
  const h = sha256(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export async function loadAssessmentPrerequisites() {
  const bytes = await readFile(url);
  check(
    sha256(bytes) === ASSESSMENT_PREREQUISITES_SHA256,
    "RESERVE_ASSESSMENT_PREREQUISITES_CHANGED",
  );
  const value = JSON.parse(bytes.toString());
  check(
    value.version === 1 &&
      value.corpus_sha256 === CORPUS_SHA256 &&
      value.cases.length === 4,
    "RESERVE_ASSESSMENT_CENSUS",
  );
  const migration = new URL(
    "../../supabase/migrations/20261018210235_configurable_company_scope.sql",
    import.meta.url,
  );
  check(
    sha256(await readFile(migration)) === value.scope_policy_origin.sha256,
    "RESERVE_SCOPE_DEFAULT_CHANGED",
  );
  return value;
}
export async function buildAssessmentInput(
  caseId: string,
  material: ReturnType<typeof publicCase>,
) {
  const prerequisites = await loadAssessmentPrerequisites(),
    fixture = prerequisites.cases.find((r: any) => r.case_id === caseId);
  check(
    fixture && material.task === "classify_opportunity",
    "RESERVE_ASSESSMENT_CASE",
  );
  const buyer = material.documents.find(
    (d: any) => d.id === fixture.buyer_document_id,
  );
  check(
    buyer &&
      buyer.authority_role === "buyer_rfp" &&
      buyer.authority_status === "confirmed" &&
      sha256(buyer.text) === buyer.sha256,
    "RESERVE_NOTICE_PROJECTION_SOURCE",
  );
  check(
    fixture.notice_projection ===
      "exact_original_text_without_added_title_or_newlines" &&
      fixture.notice_evidence === null,
    "RESERVE_NOTICE_PROJECTION_CHANGED",
  );
  const noticeId = uuid(caseId + ":synthetic-notice");
  const notice = {
    id: noticeId,
    kind: "notice",
    text: buyer.text,
    verified: false,
    reference: {
      entity_kind: "notice",
      entity_id: noticeId,
      content_hash: buyer.sha256,
    },
  };
  const knowledge = fixture.company_document_ids.map((id: string) => {
    const doc = material.documents.find((d: any) => d.id === id);
    check(
      doc &&
        doc.authority_role === "company_evidence" &&
        doc.authority_status === "confirmed" &&
        sha256(doc.text) === doc.sha256,
      "RESERVE_COMPANY_PROJECTION_SOURCE",
    );
    return {
      id: doc.entity_id,
      kind: "company",
      verified: true,
      text: doc.text,
      reference: {
        entity_kind: "knowledge",
        entity_id: doc.entity_id,
        content_hash: doc.sha256,
      },
    };
  });
  check(
    knowledge.length + 1 === material.documents.length,
    "RESERVE_ASSESSMENT_SOURCE_OMITTED",
  );
  const scope = serviceScopeSchema.parse(prerequisites.scope_policy);
  const ctx: any = {
    plan: {
      id: uuid(caseId + ":plan"),
      kind: "assessment",
      stage: "assessment",
      frozen_context: {
        notice,
        notice_evidence: null,
        blocks: [],
        reviews: [],
        knowledge,
        rates: [],
        discovery_scope_policy: scope,
      },
    },
    step: {
      id: uuid(caseId + ":step"),
      task: "classify_opportunity",
      input: {},
    },
    requirements: [],
    steps: [],
  };
  const actual = taskInput(ctx);
  return {
    ...actual,
    domainValidate: (value: unknown) =>
      validateGenerationResult(ctx, actual, value),
    trace: {
      context_constructor:
        "generation.taskInput + validateGenerationResult; explicit synthetic document-to-notice projection",
      assessment_prerequisites_sha256: ASSESSMENT_PREREQUISITES_SHA256,
      scope_policy_origin: prerequisites.scope_policy_origin,
      notice_collection_performed: false,
      source_projection: [
        {
          corpus_document_id: buyer.id,
          canonical_id: noticeId,
          original_entity_id: buyer.entity_id,
          original_authority: buyer.authority_role,
          canonical_kind: "notice",
          source_sha256: buyer.sha256,
          projection:
            "synthetic exact-text notice, not a published/collected notice",
          span_ids: buyer.spans.map((s: any) => s.id),
        },
        ...fixture.company_document_ids.map((id: string) => {
          const doc = material.documents.find((d: any) => d.id === id)!;
          return {
            corpus_document_id: id,
            canonical_id: doc.entity_id,
            original_authority: doc.authority_role,
            canonical_kind: "company",
            source_sha256: doc.sha256,
            span_ids: doc.spans.map((s: any) => s.id),
          };
        }),
      ],
    },
  };
}
