import type { Backend } from "./backend.ts";
import { AppError } from "./http.ts";
import {
  deliveryPayloadV3Schema,
  type DeliveryGap,
} from "./deliveryContract.ts";
import { deliveryRenderingGapSummary } from "./deliveryExport.ts";
import {
  assessGeneratedDelivery,
  type GeneratedDeliveryReport,
} from "./generatedProposalConsistency.ts";
import { consistencyHash } from "./proposalConsistency.ts";

type Row = Record<string, any>;
/** Inputs are service-resolved accepted graph receipts, never browser supplied
 * attestations. Final human assurance stays pending after machine issuance. */
export async function buildGeneratedPayload(
  context: Row,
  report: GeneratedDeliveryReport,
) {
  if (!report.machine_eligible || report.blockers.length)
    throw new AppError(
      422,
      "GENERATED_DELIVERY_VALIDATION_FAILED",
      "The accepted responses did not pass the complete draft checks.",
    );
  if (
    context.input_review_complete === false &&
    !report.human_gaps.some((g) => g.code === "INPUT_COVERAGE_REVIEW_REQUIRED")
  )
    report = {
      ...report,
      human_gaps: [
        ...report.human_gaps,
        {
          code: "INPUT_COVERAGE_REVIEW_REQUIRED",
          detail:
            "Source extraction requires current page review before final approval.",
        },
      ],
    };
  const frozen = context.plan.frozen_context;
  const ar = frozen.language === "ar";
  const l = (en: string, arabic: string) => (ar ? arabic : en);
  const labels: Record<string, string> = {
    SOURCE_MEANING_OR_AUTHORITY_REVIEW_REQUIRED: l(
      "Review source authority and obligation meaning before final approval.",
      "راجع سلطة المصدر ومعنى الالتزامات قبل الاعتماد النهائي.",
    ),
    INPUT_COVERAGE_REVIEW_REQUIRED: l(
      "Review unread or incomplete source material and its effect before approval.",
      "راجع المواد غير المقروءة أو الناقصة وأثرها قبل الاعتماد.",
    ),
    REQUIREMENT_INVENTORY_REVIEW_REQUIRED: l(
      "Confirm the requirement inventory against the original sources.",
      "طابق قائمة المتطلبات مع المصادر الأصلية.",
    ),
    FINALIZATION_INPUT_REQUIRED: l(
      "Resolve the recorded inputs and commitments before final approval.",
      "استكمل المدخلات والالتزامات المسجلة قبل الاعتماد النهائي.",
    ),
    AUTHORIZED_FINAL_PROPOSAL_REVIEW_REQUIRED: l(
      "An authorized person must review this exact proposal and evidence before final approval.",
      "يجب أن تراجع جهة مخولة هذه النسخة من العرض وأدلتها قبل الاعتماد النهائي.",
    ),
  };
  const gaps: DeliveryGap[] = report.human_gaps.map((gap, index) => ({
    id: `generated-review-${index}`,
    section_key: "generated-review-gaps",
    field_path: gap.requirement_id
      ? `$.requirements[${JSON.stringify(gap.requirement_id)}]`
      : "$.generation",
    reason:
      gap.code === "INPUT_COVERAGE_REVIEW_REQUIRED"
        ? "UNREAD_INPUT"
        : gap.code === "COMPANY_EVIDENCE_INPUT_REQUIRED"
          ? "COMPANY_EVIDENCE_REQUIRED"
          : gap.code === "COMMERCIAL_INPUT_REQUIRED"
            ? "COMMERCIAL_CONFIRMATION_REQUIRED"
            : "MODEL_INPUT_REQUIRED",
    label: labels[gap.code] || gap.detail || gap.code,
    required_for: "final_approval",
    source_ids: [],
  }));
  const machineValidation = { ...report, passed: true as const };
  const sourceIds = [
    ...new Set<string>(
      context.source_manifest.map((ref: Row) => ref.entity_id),
    ),
  ];
  const payload = deliveryPayloadV3Schema.parse({
    version: 3,
    title: frozen.title,
    language: frozen.language,
    template: frozen.template,
    separate_volumes: context.version.separate_volumes,
    input_state: report.human_gaps.some(
      (g) => g.code === "INPUT_COVERAGE_REVIEW_REQUIRED",
    )
      ? "partial"
      : "available",
    content_state: "generated_review_draft",
    assurance_state: "source_review_required",
    substantive_complete: false,
    approval_state: "draft",
    notice: l(
      "The generated responses passed the saved machine checks. This review draft has not received final human approval; pending source and commercial reviews remain explicit.",
      "اجتازت الاستجابات المولدة الفحوص الآلية المحفوظة. هذه مسودة للمراجعة لم تحصل على اعتماد بشري نهائي؛ المراجعات المعلقة للمصادر والجوانب التجارية موضحة.",
    ),
    source_manifest: context.source_manifest,
    input_materials: frozen.input_materials || {},
    sections: [
      ...context.sections.map((section: Row) => ({
        section_key: section.key || section.section_key,
        title: section.title,
        volume: section.volume,
        kind: "accepted_unit",
        content_blocks: section.content_blocks,
        source_ids: sourceIds,
        provenance: {
          origin: "accepted_generation_version",
          proposal_version_id: context.version.id,
          plan_id: context.plan.id,
          version_content_hash: context.version.content_hash,
        },
      })),
      {
        section_key: "generated-review-gaps",
        title: l("Pending final reviews", "المراجعات النهائية المعلقة"),
        volume: "shared",
        kind: "response",
        content_blocks: gaps.map((g) => ({
          type: "placeholder",
          gap_id: g.id,
        })),
        source_ids: [],
        provenance: null,
      },
    ],
    gaps,
    generation: {
      proposal_version_id: context.version.id,
      plan_id: context.plan.id,
      version_content_hash: context.version.content_hash,
      plan_input_hash: context.plan.input_hash,
      machine_validation: machineValidation,
      machine_validation_hash: await consistencyHash(machineValidation),
      receipt_pins: context.accepted_receipts.map((r: Row) => ({
        step_id: r.step_id,
        receipt_id: r.receipt_id,
        verification_receipt_id: r.verification_receipt_id,
        candidate_hash: r.candidate_hash,
      })),
    },
  });
  for (const volume of payload.separate_volumes
    ? (["technical", "financial"] as const)
    : (["combined"] as const)) {
    if (
      deliveryRenderingGapSummary({ id: context.version.id, payload }, volume)
        .rendering_gap_count
    )
      throw new AppError(
        422,
        "GENERATED_DELIVERY_CONTENT_WITHHELD",
        "The complete accepted response cannot be rendered under the current content and volume rules.",
      );
  }
  return payload;
}

/** A separately leased local job closes the finalization-to-render crash window.
 * SQL rechecks the exact context, actor, source and request deadline on publish. */
export async function processGeneratedDelivery(backend: Backend, job: Row) {
  const identity = { job_id: job.id, lease: job.lease_token };
  try {
    const context = await backend.internal(
      "generated_delivery_context",
      identity,
    );
    const report = await assessGeneratedDelivery(context);
    const payload = await buildGeneratedPayload(context, report);
    const snapshot = await backend.internal("publish_generated_delivery", {
      ...identity,
      expected_context_hash: context.context_hash,
      payload,
    });
    return { snapshot_id: snapshot.id, projected: true };
  } catch (error) {
    const code =
      error instanceof AppError
        ? error.code
        : "GENERATED_DELIVERY_VALIDATION_FAILED";
    await backend.internal("fail_generated_delivery", {
      ...identity,
      error_code: code,
    });
    return { error_code: code };
  }
}
