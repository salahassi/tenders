/** Offline new/unstarted-phase construction only, not a live campaign runner. */
import { readFile } from "node:fs/promises";
import {
  loadReserve,
  CORPUS_SHA256,
  publicCase,
  sha256,
  type ReserveCase,
} from "./reserve.mjs";
import {
  taskInput,
  validateGenerationResult,
} from "../../supabase/functions/_shared/generation.ts";
import {
  canonicalSourceSpanId,
  sourceEvidenceContractSchema,
  resolveSourceSpan,
  assertSourceBlockHash,
} from "../../supabase/functions/_shared/sourceEvidence.ts";
import {
  executeModel,
  ModelError,
  modelPrompt,
  taskSystemInstructions,
  type Evidence,
  type ModelTask,
  type Reference,
  type ModelConfiguration,
  type Ledger,
} from "../../supabase/functions/_shared/model.ts";
import { pinSemanticPrompt } from "../../supabase/functions/_shared/modelSemanticPrompt.ts";
import type { StructuredRequest } from "../../supabase/functions/_shared/modelContract.ts";
export const ADAPTER_VERSION = 1;
const idFor = (name: string) => {
  const h = sha256(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const supported = (r: ReserveCase) =>
  r.task === "connection_probe" ||
  r.task === "inspect_source_page" ||
  (r.task === "analyze_chunk" && r.scenario === "retention_exception") ||
  (r.task === "summarize_review" && r.scenario === "advisory_note");
function unsupportedReason(row: ReserveCase) {
  if (["analyze_chunk", "summarize_review"].includes(row.task))
    return {
      code: "COMPOSITE_PRODUCTION_REQUEST_REQUIRED",
      prerequisite:
        "taskInput selects one immutable block/review. Freeze and review multi-request orchestration/schedule; do not concatenate source identities.",
    };
  if (row.task === "classify_opportunity")
    return {
      code: "NOTICE_PROJECTION_AND_SCOPE_POLICY_UNFROZEN",
      prerequisite:
        "Freeze a canonical notice projection and explicit service-scope policy. Buyer documents are rfp; do not silently relabel authority or invent policy.",
    };
  if (row.task === "verify_grounding")
    return {
      code: "TYPED_CANDIDATE_INPUT_UNFROZEN",
      prerequisite:
        "Freeze an exact typed candidate and source-bound original task context; candidate_semantics is not a canonical candidate.",
    };
  if (row.task === "repair_result")
    return {
      code: "REPAIR_CANDIDATE_AND_SCOPE_UNFROZEN",
      prerequisite:
        "Freeze failed typed candidate, actual diagnostics, hash/dependency closure and production patch scope; allowed_paths alone is insufficient.",
    };
  return {
    code: "ACCEPTED_WORKFLOW_PREREQUISITES_UNFROZEN",
    prerequisite:
      "Freeze source-bound requirements and required blueprint/draft/commercial inputs. Logical labels/source text are not accepted stage outputs.",
  };
}
export async function reserveAdapterCoverage() {
  const { corpus } = await loadReserve();
  return corpus.cases.map((row) => ({
    case_id: row.id,
    task: row.task,
    language: row.language,
    status: supported(row)
      ? "offline_single_request_constructible"
      : "unsupported",
    ...(supported(row) ? { request_count: 1 } : unsupportedReason(row)),
  }));
}
function phaseMemory() {
  const pins = new Map<string, any>();
  return {
    pins,
    store: {
      action: async (operation: string, input: any) => {
        if (operation === "result_get") return pins.get(input.key) ?? null;
        if (operation !== "result_put")
          throw Error("RESERVE_OFFLINE_OPERATION_FORBIDDEN");
        const previous = pins.get(input.key),
          value = { value: structuredClone(input.value) };
        if (previous && JSON.stringify(previous) !== JSON.stringify(value))
          throw Error("RESERVE_PHASE_PIN_CHANGED");
        pins.set(input.key, value);
        return value;
      },
    },
    backend: {
      internal: async (operation: string) => {
        if (operation !== "model_phase_started")
          throw Error("RESERVE_OFFLINE_OPERATION_FORBIDDEN");
        return false;
      },
    },
  };
}
export type ReserveAdapter = {
  caseId: string;
  caseLanguage: string;
  task: ModelTask;
  language: "ar" | "en";
  context: any;
  evidence: Evidence[];
  required: string[];
  manifest: Reference[];
  semanticRevision: 0 | 1 | 2 | 3 | 4 | 5;
  verificationRevision: 1;
  domainValidate?: (value: unknown) => void;
  trace: Record<string, any>;
  phasePins: any[];
};
export async function buildReserveAdapter(
  caseId: string,
): Promise<ReserveAdapter> {
  const { corpus } = await loadReserve(),
    row = corpus.cases.find((item) => item.id === caseId);
  if (!row) throw Error("RESERVE_CASE_UNKNOWN");
  if (!supported(row))
    throw Object.assign(
      Error(unsupportedReason(row).code),
      unsupportedReason(row),
    );
  // Gold is removed before construction can inspect any material fields.
  const material = publicCase(row),
    task = material.task as ModelTask;
  const phase = phaseMemory(),
    job = { id: idFor(caseId + ":job"), lease_token: idFor(caseId + ":lease") };
  let context: any = {},
    evidence: Evidence[] = [],
    required: string[] = [],
    manifest: Reference[] = [],
    domainValidate: ReserveAdapter["domainValidate"];
  const trace: Record<string, any> = {
    version: ADAPTER_VERSION,
    corpus_sha256: CORPUS_SHA256,
    case_id: caseId,
    case_language: row.language,
    new_unstarted_phase_only: true,
    database_authorization_proven: false,
    source_projection: [],
    authority_review:
      "Synthetic authority inputs; no human semantic approval is created.",
  };
  let language = row.language as "en" | "ar";
  if (task === "inspect_source_page") {
    const doc = material.documents[0],
      links = material.workflow_facts.links;
    if (
      material.workflow_facts.mode !== "collect_notices" ||
      material.workflow_facts.required_page_evidence_id !== "page"
    )
      throw Error("RESERVE_SOURCE_MODE_UNFROZEN");
    context = {
      mode: "collect_notices",
      url: `https://synthetic.invalid/page/${job.id}`,
      partial: false,
      links,
    };
    evidence = [
      { id: "page", kind: "notice", verified: false, text: doc.text },
      ...links.map((l: any) => ({
        id: l.id,
        kind: "notice",
        verified: false,
        text: l.text,
      })),
    ];
    // automaticSources uses Arabic request metadata for both source languages.
    language = "ar";
    const pageHash = sha256(JSON.stringify({ ...context, text: doc.text }));
    manifest = [
      { entity_kind: "source_page", entity_id: job.id, content_hash: pageHash },
    ];
    trace.source_projection = [
      {
        canonical_id: "page",
        corpus_document_id: doc.id,
        corpus_entity_id: doc.entity_id,
        source_sha256: doc.sha256,
        span_ids: doc.spans.map((s: any) => s.id),
        page_snapshot_sha256: pageHash,
      },
      ...links.map((l: any) => ({
        canonical_id: l.id,
        frozen_link: l,
        text_sha256: sha256(l.text),
      })),
    ];
    trace.context_constructor =
      "automaticSources projection + sourceReadingPrompt; no page fetched";
  } else if (task !== "connection_probe") {
    const doc = material.documents[0],
      isReview = task === "summarize_review";
    const source: any = {
      id: doc.entity_id,
      text: doc.text,
      kind: isReview ? "review" : "rfp",
      verified: false,
      reference: {
        entity_kind: isReview ? "review" : "document",
        entity_id: doc.entity_id,
        content_hash: doc.sha256,
      },
      block_hash: doc.sha256,
      extraction_version: "reserve-v1",
      locator: { kind: "extracted_character_range" },
      ...(isReview ? { target_kind: "general", target_id: "general" } : {}),
    };
    await assertSourceBlockHash(source);
    const spans = isReview
      ? []
      : doc.spans.map((span: any) => {
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
              decision_id: idFor(doc.id + ":authority"),
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
    // Empty administrative context adds no buyer fact. This in-memory envelope
    // is NOT evidence of an authenticated generation_context RPC/DB admission.
    const frozen = {
      notice: {
        id: idFor(caseId + ":notice"),
        text: "",
        kind: "notice",
        verified: false,
      },
      blocks: isReview ? [] : [source],
      reviews: isReview ? [source] : [],
      knowledge: [],
      rates: [],
      template: { id: idFor(caseId + ":template"), required_sections: [] },
      source_contract_version: 1,
      repair_contract_version: 1,
      source_evidence: contract,
      draft_input_version: 1,
      input_materials: {
        documents: isReview
          ? []
          : [{ document_id: doc.entity_id, used_for_draft: true }],
      },
    };
    const planContext: any = {
      plan: {
        id: idFor(caseId + ":plan"),
        kind: "proposal",
        frozen_context: frozen,
      },
      step: {
        id: idFor(caseId + ":step"),
        task,
        input: {
          [isReview ? "review_id" : "block_id"]: source.id,
          start: 0,
          end: Array.from(source.text).length,
        },
      },
      requirements: [],
      steps: [],
    };
    const actual = taskInput(planContext);
    if (actual.task !== task) throw Error("RESERVE_TASK_PROJECTION_CHANGED");
    ({ context, evidence, manifest } = actual);
    required = actual.requiredIds;
    domainValidate = (result) =>
      validateGenerationResult(planContext, actual, result);
    trace.source_projection = [
      {
        canonical_id: source.id,
        corpus_document_id: doc.id,
        source_sha256: doc.sha256,
        reference: source.reference,
        spans: doc.spans.map((s: any, i: number) => ({
          corpus_span_id: s.id,
          canonical_span_id: spans[i]?.id ?? null,
          start: s.start,
          end: s.end,
          coordinate: s.coordinate,
          quote_sha256: sha256(s.quote),
        })),
      },
    ];
    trace.context_constructor =
      "generation.taskInput + validateGenerationResult; synthetic envelope, not SQL admission";
  } else
    trace.context_constructor =
      "connection_probe empty context/evidence; no business quality claim";
  const semanticRevision = await pinSemanticPrompt({
    backend: phase.backend as any,
    store: phase.store as any,
    job,
    requestPrefix: `reserve:${caseId}`,
    task,
    context,
    evidence,
    requiredIds: required,
    language,
    repair: false,
    verificationRevision: 1,
  });
  trace.request_language = language;
  trace.context_sha256 = sha256(JSON.stringify(context));
  trace.evidence_sha256 = sha256(JSON.stringify(evidence));
  trace.manifest_sha256 = sha256(JSON.stringify(manifest));
  return {
    caseId,
    caseLanguage: row.language,
    task,
    language,
    context,
    evidence,
    required,
    manifest,
    semanticRevision,
    verificationRevision: 1,
    domainValidate,
    trace,
    phasePins: [...phase.pins].map(([key, value]) => ({ key, ...value })),
  };
}
/** Uses production preparation, stopping before beforeSend/reserve/fetch.
 * Caller supplies explicit configuration; no actual enabled target is assumed. */
export async function compileReserveRequest(
  adapter: ReserveAdapter,
  configuration: ModelConfiguration,
) {
  const fresh = await buildReserveAdapter(adapter.caseId);
  for (const field of [
    "task",
    "language",
    "context",
    "evidence",
    "required",
    "manifest",
    "semanticRevision",
    "verificationRevision",
    "trace",
    "phasePins",
  ] as const)
    if (JSON.stringify(adapter[field]) !== JSON.stringify(fresh[field]))
      throw Error("RESERVE_ADAPTER_INPUT_CHANGED");
  let captured: StructuredRequest | undefined,
    captures = 0,
    forbiddenOperations = 0;
  const forbid = async () => {
    forbiddenOperations++;
    throw Error("RESERVE_OFFLINE_SIDE_EFFECT_FORBIDDEN");
  };
  const environment = {
    provider: configuration.provider,
    model: configuration.model,
    projectRef: configuration.project_ref,
    key: "offline-unused-no-provider-access",
  };
  const ledger: Ledger = {
    preflight: async () => ({
      providers: [configuration],
      routing_mode: "round_robin",
      executor_version: 2,
    }),
    environment: () => environment,
    requestPrepared: async (request) => {
      captures++;
      captured = request;
      throw new ModelError("MODEL_IDENTITY_CHANGED");
    },
    beforeSend: forbid,
    reserve: forbid,
    settle: forbid,
    backgroundAllowed: async () => false,
  };
  try {
    await executeModel(
      adapter.task,
      adapter.context,
      adapter.evidence,
      adapter.required,
      adapter.manifest,
      { [configuration.provider]: environment },
      ledger,
      adapter.language,
      false,
      forbid as typeof fetch,
      adapter.verificationRevision,
      { semanticRevision: adapter.semanticRevision },
    );
  } catch (error) {
    if (!captured) throw error;
  }
  if (forbiddenOperations) throw Error("RESERVE_OFFLINE_SIDE_EFFECT_FORBIDDEN");
  if (!captured || captures !== 1)
    throw Error("RESERVE_REQUEST_NOT_CAPTURED_ONCE");
  const prompt = modelPrompt(
    adapter.task,
    adapter.context,
    adapter.evidence,
    adapter.required,
    adapter.language,
    false,
    adapter.verificationRevision,
    adapter.semanticRevision,
  );
  if (captured.prompt !== prompt || captured.inputHash !== sha256(prompt))
    throw Error("RESERVE_CANONICAL_REQUEST_DRIFT");
  const system = taskSystemInstructions(
    adapter.task,
    adapter.verificationRevision,
    adapter.semanticRevision,
    false,
  );
  // Durable inputHash is the application's user/context hash. Qualification's
  // full prompt pin additionally binds the actual separate system instruction.
  return {
    request: captured,
    system_instructions: system,
    user_prompt_sha256: sha256(prompt),
    system_prompt_sha256: sha256(system),
    request_pin: {
      input_sha256: captured.inputHash,
      prompt_sha256: sha256(JSON.stringify({ system, user: prompt })),
      output_schema_sha256: sha256(JSON.stringify(captured.schema)),
      contract_version: captured.contractVersion,
    },
    trace: adapter.trace,
    phase_pins: adapter.phasePins,
    adapter_sha256: sha256(await readFile(new URL(import.meta.url))),
    provider_calls: 0,
    reservations: 0,
    database_mutations: 0,
    semantic_qualification: "not_evaluated",
  };
}
