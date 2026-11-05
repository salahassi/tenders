/** Offline composite construction only. Never executes a provider or hides a
 * second request in the existing one-request activation/receipt contract. */
import { readFile } from "node:fs/promises";
import { CORPUS_SHA256, loadReserve, publicCase, sha256 } from "./reserve.mjs";
import {
  buildReserveReviewSegment,
  compileReserveRequest,
  reserveAdapterCoverage,
  verifiedReserveAdapter,
  type ReserveAdapter,
} from "./reserve-adapters.ts";
import { taskInput } from "../../supabase/functions/_shared/generation.ts";
import { primaryModelSchemas } from "../../supabase/functions/_shared/modelSchemas.ts";
import {
  validateModelResult,
  type ModelConfiguration,
} from "../../supabase/functions/_shared/model.ts";

export type ReviewComposite = {
  version: 1;
  case_id: string;
  corpus_sha256: string;
  logical_cells_per_repetition: 1;
  physical_requests_per_repetition: 2;
  automatic_retries: 0;
  segments: ReserveAdapter[];
};
const minted = new WeakMap<ReviewComposite, string>();
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}

export async function buildReviewComposite(
  caseId: string,
): Promise<ReviewComposite> {
  const segments = [
    await buildReserveReviewSegment(caseId, 0),
    await buildReserveReviewSegment(caseId, 1),
  ];
  const plan: ReviewComposite = {
    version: 1,
    case_id: caseId,
    corpus_sha256: CORPUS_SHA256,
    logical_cells_per_repetition: 1,
    physical_requests_per_repetition: 2,
    automatic_retries: 0,
    segments,
  };
  minted.set(plan, caseId);
  return plan;
}
async function verify(plan: ReviewComposite) {
  const caseId = minted.get(plan);
  check(
    caseId &&
      plan.case_id === caseId &&
      plan.version === 1 &&
      plan.corpus_sha256 === CORPUS_SHA256 &&
      plan.logical_cells_per_repetition === 1 &&
      plan.physical_requests_per_repetition === 2 &&
      plan.automatic_retries === 0 &&
      plan.segments.length === 2,
    "RESERVE_COMPOSITE_CHANGED",
  );
  const segments = await Promise.all(plan.segments.map(verifiedReserveAdapter));
  check(
    segments.every(
      (s, i) => s.caseId === caseId && s.trace.composite_segment.index === i,
    ),
    "RESERVE_COMPOSITE_ORDER_CHANGED",
  );
  return { caseId, segments };
}

export async function compileReviewComposite(
  plan: ReviewComposite,
  configuration: ModelConfiguration,
) {
  configuration = structuredClone(configuration);
  const { caseId, segments } = await verify(plan);
  const requests = await Promise.all(
    segments.map((segment) => compileReserveRequest(segment, configuration)),
  );
  const pins = requests.map((value, index) => ({
    index,
    ...value.request_pin,
    source_review_id: segments[index].required[0],
    adapter_sha256: value.adapter_sha256,
  }));
  return {
    version: 1,
    case_id: caseId,
    corpus_sha256: CORPUS_SHA256,
    logical_cells_per_repetition: 1,
    physical_requests_per_repetition: 2,
    automatic_retries: 0,
    requests,
    request_pins: pins,
    composite_pin_sha256: sha256(JSON.stringify(pins)),
    composite_adapter_sha256: sha256(await readFile(new URL(import.meta.url))),
    existing_activation_contract_compatible: false,
    activation_status: "requires_versioned_composite_activation_contract",
    provider_calls: 0,
    reservations: 0,
    database_mutations: 0,
    semantic_qualification: "not_evaluated",
  };
}

export async function reviewCompositeCoverage() {
  const single = await reserveAdapterCoverage();
  const cases = single.map((row) =>
    row.task === "summarize_review" && row.case_id.includes(".review_identity.")
      ? {
          ...row,
          status: "offline_two_request_composite_constructible",
          request_count: 2,
          code: undefined,
          prerequisite: undefined,
        }
      : row,
  );
  return {
    cases,
    logical_cells_per_model: 100,
    repetitions: 2,
    constructible_logical_cells:
      cases.filter((r) => r.status !== "unsupported").length * 2,
    constructible_physical_requests: cases.reduce(
      (n, r) => n + ("request_count" in r ? r.request_count : 0) * 2,
      0,
    ),
    unsupported_logical_cells:
      cases.filter((r) => r.status === "unsupported").length * 2,
    live_activation_authorized: false,
    existing_activation_contract_compatible: false,
  };
}

type ReviewResult = ReturnType<
  typeof primaryModelSchemas.summarize_review.parse
>;
type Observation =
  | { index: number; status: "completed"; output: unknown }
  | {
      index: number;
      status:
        | "unavailable"
        | "transport_error"
        | "refused"
        | "invalid_output"
        | "not_attempted";
    };

/** A source-keyed evaluator view of two actual task outputs, not a fabricated
 * single model output. Each constituent must pass its original canonical check.
 * Failure preserves both slots and cannot expose a partial success aggregate. */
export async function projectReviewComposite(
  plan: ReviewComposite,
  observations: Observation[],
) {
  // Snapshot caller-owned receipts before the first asynchronous boundary.
  observations = structuredClone(observations);
  const { caseId, segments } = await verify(plan);
  check(
    observations.length === 2 && observations.every((r, i) => r.index === i),
    "RESERVE_COMPOSITE_RECEIPT_CENSUS",
  );
  const allowed = new Set([
    "completed",
    "unavailable",
    "transport_error",
    "refused",
    "invalid_output",
    "not_attempted",
  ]);
  check(
    observations.every(
      (r) =>
        allowed.has(r.status) &&
        Object.keys(r).sort().join() ===
          (r.status === "completed" ? "index,output,status" : "index,status"),
    ),
    "RESERVE_COMPOSITE_RECEIPT_INVALID",
  );
  const outputs = observations.map((r, i) => {
    if (r.status !== "completed") return null;
    const value = primaryModelSchemas.summarize_review.parse(r.output);
    // executeModel validates against selected request evidence before the
    // broader immutable-block domain check. Preserve both boundaries: a valid
    // quote from the other frozen review is still outside this request.
    validateModelResult(
      segments[i].task,
      value,
      segments[i].evidence,
      segments[i].required,
      { sourceContext: segments[i].context },
    );
    segments[i].domainValidate!(value);
    return value;
  });
  const statuses = observations.map((r, i) => ({
    index: r.index,
    status: r.status,
    ...(outputs[i]
      ? {
          canonical_validation: "passed",
          output_sha256: sha256(JSON.stringify(outputs[i])),
        }
      : {}),
  }));
  if (observations.some((r) => r.status !== "completed"))
    return {
      status: "incomplete" as const,
      observations: statuses,
      aggregate: null,
      downstream_planning_context: null,
      semantic_qualification: "not_evaluated",
    };
  check(
    outputs.every((r): r is ReviewResult => r !== null),
    "RESERVE_COMPOSITE_RECEIPT_INVALID",
  );
  const { corpus } = await loadReserve();
  const row = corpus.cases.find((r) => r.id === caseId)!;
  const material = publicCase(row);
  // This actual downstream taskInput projection is source assembly only. The
  // supplied observations are not asserted to be provider/DB accepted results.
  const reviews = material.documents.map((d) => ({
    id: d.entity_id,
    text: d.text,
    kind: "review",
    verified: false,
    reference: {
      entity_kind: "review",
      entity_id: d.entity_id,
      content_hash: d.sha256,
    },
    block_hash: d.sha256,
    extraction_version: "reserve-v1",
    locator: { kind: "extracted_character_range" },
    target_kind: "general",
    target_id: "general",
  }));
  const steps = outputs.map((output, index) => ({
    task: "summarize_review",
    status: "completed",
    ordinal: index,
    input: {
      review_id: reviews[index].id,
      start: 0,
      end: Array.from(reviews[index].text).length,
    },
    output,
  }));
  const context: any = {
    plan: {
      kind: "proposal",
      frozen_context: {
        notice: {
          id: "empty-administrative-context",
          text: "",
          kind: "notice",
          verified: false,
        },
        blocks: [],
        reviews,
        knowledge: [],
        rates: [],
        template: { id: "synthetic-template", required_sections: [] },
        source_contract_version: 1,
        repair_contract_version: 1,
        source_evidence: { version: 1, spans: [], reviews: [] },
      },
    },
    step: { task: "plan_proposal", input: { requirement_ids: [] } },
    requirements: [],
    steps,
  };
  const downstream = taskInput(context);
  const aggregate = {
    processed_review_ids: outputs.flatMap((r) => r.processed_review_ids),
    directives: outputs.flatMap((r) => r.directives),
    questions: outputs.flatMap((r) => r.questions),
  };
  const lineage = outputs.flatMap((output: ReviewResult, index) =>
    ["directives", "questions"].flatMap((kind) =>
      output[kind as "directives" | "questions"].map((value, ordinal) => ({
        request_index: index,
        review_id: reviews[index].id,
        kind,
        ordinal,
        output_sha256: sha256(JSON.stringify(value)),
      })),
    ),
  );
  return {
    status: "completed" as const,
    observations: statuses,
    aggregate,
    lineage,
    constituent_output_sha256: outputs.map((r) => sha256(JSON.stringify(r))),
    downstream_planning_context: downstream.context,
    downstream_evidence: downstream.evidence,
    projection_origin:
      "supplied_constituent_outputs_not_prior_provider_or_database_success",
    semantic_qualification: "not_evaluated",
  };
}
