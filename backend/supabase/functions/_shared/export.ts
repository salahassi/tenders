import { Decimal } from "decimal.js";
import { AppError } from "./http.ts";
import { verifyBoundedDocx, verifyBoundedDocxAsync } from "./boundedDocx.ts";
import { blockedContent } from "./model.ts";
import { exportSectionGroups } from "./proposalOutline.ts";
import {
  hasNativeVerifierRuntime,
  verifyDeliveryIsolated,
  verifyOwnedDeliverySnapshot,
} from "./deliveryVerifyIsolation.ts";
type Row = Record<string, any>;
export type ExportBlock =
  | { type: "paragraph" | "bullet" | "heading" | "title"; text: string }
  | { type: "placeholder"; text: string; gap_id: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "toc"; text: string };
export interface RenderModel {
  placeholder_version?: 1 | 2;
  id: string;
  version: number;
  mode: string;
  volume: string;
  language: string;
  created_at: string;
  footer: string;
  blocks: ExportBlock[];
}
const clean = (v: unknown) => (typeof v === "string" ? v : "");
export function buildExportModel(
  request: Row,
  placeholderPolicy: 2 | undefined = request.snapshot
    ?.export_renderer_version === "ordinary-2"
    ? 2
    : undefined,
): RenderModel {
  const s = request.snapshot,
    rtl = s.language === "ar",
    l = (en: string, ar: string) => (rtl ? ar : en),
    blocks: ExportBlock[] = [];
  const p = (text: string) => {
      if (text) blocks.push({ type: "paragraph", text });
    },
    h = (text: string) => blocks.push({ type: "heading", text });
  p(clean(s.template?.style_config?.company_name));
  blocks.push({ type: "title", text: s.title });
  p(s.opportunity_title);
  const date = (value: string, time = false) =>
    new Intl.DateTimeFormat(rtl ? "ar-EG-u-nu-latn" : "en-US", {
      dateStyle: "long",
      ...(time
        ? { timeStyle: "short" as const, hourCycle: "h23" as const }
        : {}),
      timeZone: "UTC",
    }).format(new Date(time ? value : value + "T12:00:00Z"));
  const number = (value: string) => new Decimal(value).toFixed();
  const draft = request.mode === "draft";
  const proposed = draft ? s.commercial_draft : null;
  const unknown = (field: string) => `[INPUT REQUIRED: ${field}]`;
  const supplied = (value: unknown, field: string) =>
    clean(value).trim() || unknown(field);
  // Column headings already identify each missing input. Short localized cell
  // values stay readable in narrow RTL tables and never imply a zero amount.
  const cell = (value: unknown) =>
    clean(value).trim() ||
    (placeholderPolicy === 2
      ? unknown(l("Not supplied", "غير محدد"))
      : l("Not supplied", "غير محدد"));
  const sectionTitle = (key: string) =>
    s.sections.find((section: Row) => section.section_key === key)?.title ||
    l("Unlinked section", "قسم غير مرتبط");
  // Global review items go in the financial volume when volumes are separate.
  // They can contain pricing: never leak them into the technical submission.
  const reviewItemInVolume = (keys: string[]) =>
    request.volume === "combined" ||
    (keys.length
      ? keys.some((key) =>
          s.sections.some(
            (section: Row) =>
              section.section_key === key &&
              (section.volume === request.volume ||
                section.volume === "shared"),
          ),
        )
      : request.volume === "financial");
  p(`${l("Version", "النسخة")} ${s.ordinal}`);
  p(
    `${l("Generated", "تاريخ الإنشاء")}: ${date(request.created_at, true)} UTC`,
  );
  p(
    request.mode === "draft"
      ? l(
          "DRAFT — Review before external use",
          "مسودة — تُراجع قبل الاستخدام الخارجي",
        )
      : l("Approved proposal content", "محتوى العرض المعتمد"),
  );
  p(
    request.volume === "technical"
      ? l("Technical volume", "العرض الفني")
      : request.volume === "financial"
        ? l("Financial volume", "العرض المالي")
        : l("Technical and commercial proposal", "العرض الفني والمالي"),
  );
  blocks.push({ type: "toc", text: l("Contents", "المحتويات") });
  const groups = exportSectionGroups(s.sections, s.section_outline);
  const structuredMatrix = groups.some((group) => group.generated_matrix);
  const appendMatrix = (
    title = l("Requirement compliance matrix", "مصفوفة الامتثال للمتطلبات"),
  ) => {
    h(title);
    blocks.push({
      type: "table",
      headers: [
        l("Requirement", "المتطلب"),
        l("Response", "الاستجابة"),
        l("Proposal sections", "أقسام العرض"),
      ],
      rows: s.requirements
        .filter((r: Row) =>
          request.volume === "technical"
            ? r.category !== "commercial"
            : request.volume === "financial"
              ? r.category === "commercial"
              : true,
        )
        .map((r: Row) => {
          const c = s.compliance.find((x: Row) => x.requirement_id === r.id);
          const suggested =
            !c && draft
              ? s.review_result?.responses?.find(
                  (x: Row) => x.requirement_id === r.id,
                )
              : null;
          const status: Record<string, string> = {
            answered: l("Answered", "تمت الاستجابة"),
            question: l("Clarification required", "يتطلب توضيحًا"),
            not_applicable: l("Not applicable", "غير منطبق"),
            not_applicable_with_reason: l(
              "Not applicable, with reason",
              "غير منطبق مع توضيح السبب",
            ),
            gap: l("Unresolved gap", "فجوة لم تُحل"),
            partial: l("Partially answered", "استجابة جزئية"),
            missing: l("Missing response", "استجابة مفقودة"),
            clarification_required: l(
              "Clarification required",
              "يتطلب توضيحًا",
            ),
            not_applicable_approved: l(
              "Not applicable, approved",
              "غير منطبق بموافقة المالك",
            ),
          };
          return [
            r.text,
            c
              ? status[c.status] || l("Not confirmed", "غير مؤكد")
              : suggested
                ? `${l("Model review (not confirmed)", "مراجعة الموديل (غير مؤكدة)")}: ${status[suggested.status] || l("Not confirmed", "غير مؤكد")}${suggested.rationale ? " — " + clean(suggested.rationale) : ""}`
                : l("Not confirmed", "غير مؤكد"),
            (c?.section_keys || suggested?.section_ids || [])
              .map(sectionTitle)
              .join(rtl ? "، " : ", "),
          ];
        }),
    });
  };
  let matrixRendered = false;
  for (const group of groups.filter(
    (x) =>
      request.volume === "combined" ||
      x.volume === request.volume ||
      x.volume === "shared",
  )) {
    if (group.generated_matrix) {
      if (!matrixRendered) appendMatrix(group.title);
      matrixRendered = true;
      continue;
    }
    h(group.title);
    for (const section of group.sections) {
      if (section.title !== group.title) p(section.title);
      if (
        Array.isArray(section.content_blocks) &&
        section.content_blocks.length
      )
        for (const b of section.content_blocks) {
          if (b.type === "table")
            blocks.push({
              type: "table",
              headers: [...b.headers],
              // Preserve every authorized cell. The native renderer pads rows
              // and headers to the widest row without inventing heading text.
              rows: b.rows.map((r: string[]) => [...r]),
            });
          else
            blocks.push({
              type: b.type === "bullet" ? "bullet" : "paragraph",
              text: b.text,
            });
        }
      else for (const line of clean(section.body).split("\n")) p(line);
    }
  }
  if (request.volume !== "financial") {
    h(l("Delivery schedule", "جدول التسليم"));
    const d = s.delivery?.calculated;
    if (d) {
      p(
        `${l("Effort in person-days", "الجهد بأيام العمل للفرد")}: ${number(d.effort_person_days)}; ${l("Elapsed working days", "المدة بأيام العمل")}: ${number(d.duration_workdays)}`,
      );
      blocks.push({
        type: "table",
        headers: [
          l("Task", "المهمة"),
          l("Role", "الدور"),
          l("Effort", "الجهد"),
          l("Start", "البداية"),
          l("End", "النهاية"),
        ],
        rows: d.tasks.map((t: Row) => [
          t.title || t.key,
          t.role,
          number(t.effort_days),
          number(t.start_workday),
          number(t.end_workday),
        ]),
      });
    } else if (Array.isArray(proposed?.tasks) && proposed.tasks.length) {
      p(
        l(
          "Proposed delivery inputs — awaiting review. Effort, allocation and duration are not an approved schedule.",
          "مدخلات تنفيذ مقترحة بانتظار المراجعة. الجهد والتخصيص والمدة لا تمثل خطة تسليم معتمدة.",
        ),
      );
      blocks.push({
        type: "table",
        headers: [
          l("Task", "المهمة"),
          l("Role", "الدور"),
          l("Effort (person-days)", "الجهد بأيام عمل للفرد"),
          l("Allocation", "التخصيص"),
          l("Duration (working days)", "المدة بأيام العمل"),
        ],
        rows: proposed.tasks.map((task: Row) => [
          clean(task.title) || clean(task.key),
          cell(task.role),
          cell(task.effort_days),
          cell(task.allocation),
          cell(task.duration_days),
        ]),
      });
      for (const task of proposed.tasks) {
        const dependencies = (task.predecessors || []).map(
          (key: string) =>
            proposed.tasks.find((other: Row) => other.key === key)?.title ||
            key,
        );
        p(
          `${clean(task.title) || clean(task.key)} — ${l("Dependencies", "الاعتماديات")}: ${dependencies.join(rtl ? "، " : ", ") || l("None specified", "لم تُحدّد")}`,
        );
        if (task.basis) p(`${l("Basis", "الأساس")}: ${clean(task.basis)}`);
      }
    } else
      p(
        l(
          "[INPUT REQUIRED: approved delivery schedule]",
          "[INPUT REQUIRED: خطة تسليم معتمدة]",
        ),
      );
    if (!structuredMatrix) appendMatrix();
  }
  if (structuredMatrix && !matrixRendered) appendMatrix();
  if (request.volume !== "technical") {
    h(l("Commercial schedule", "الجدول المالي"));
    const e = s.estimate,
      c = e?.calculated;
    if (c) {
      const money = (v: string) =>
        new Decimal(v).toFixed(c.precision ?? 2, Decimal.ROUND_HALF_UP);
      p(`${l("Currency", "العملة")}: ${c.currency}`);
      const charge: Record<string, string> = {
        one_time: l("One-time", "لمرة واحدة"),
        recurring: l("Recurring", "متكرر"),
        optional: l("Optional", "اختياري"),
      };
      blocks.push({
        type: "table",
        headers: [
          l("Item", "البند"),
          l("Quantity and unit", "الكمية والوحدة"),
          l("Charge", "نوع التكلفة"),
        ],
        rows: e.input.lines.map((line: Row) => [
          line.description,
          `${number(line.quantity)} ${line.unit} × ${number(line.period_count)}`,
          `${line.included_in_base ? l("Base", "أساسي") : l("Optional", "اختياري")} · ${charge[line.charge_group] || ""}`,
        ]),
      });
      blocks.push({
        type: "table",
        headers: [
          l("Item", "البند"),
          l("Net", "قبل الضريبة"),
          l("Tax", "الضريبة"),
          l("Total", "الإجمالي"),
        ],
        rows: e.input.lines.map((line: Row) => {
          const amount = c.lines.find((r: Row) => r.id === line.id);
          return [
            line.description,
            money(amount.net_price),
            money(amount.tax),
            money(amount.gross_total),
          ];
        }),
      });
      blocks.push({
        type: "table",
        headers: [l("Offer summary", "ملخص العرض"), c.currency],
        rows: [
          [
            l("Base excluding tax", "القيمة الأساسية قبل الضريبة"),
            money(c.net_price),
          ],
          [l("Tax", "الضريبة"), money(c.tax)],
          [l("Base total", "الإجمالي الأساسي"), c.display_gross],
          [
            l(
              "Optional items excluded from base",
              "البنود الاختيارية غير المشمولة في الأساسي",
            ),
            money(c.optional_gross),
          ],
          [l("Rounding adjustment", "فرق التقريب"), c.rounding_adjustment],
        ],
      });
      h(l("Payment milestones", "مراحل الدفع"));
      p(
        `${l("Payment basis", "أساس احتساب الدفعات")}: ${c.payment_basis === "base_net" ? l("Base amount excluding tax", "القيمة الأساسية قبل الضريبة") : l("Base amount including tax", "القيمة الأساسية شاملة الضريبة")}`,
      );
      blocks.push({
        type: "table",
        headers: [
          l("Milestone", "المرحلة"),
          l("Percent", "النسبة"),
          l("Amount", "المبلغ"),
        ],
        rows: c.payments.map((x: Row) => [x.title, x.percent + "%", x.amount]),
      });
      p(
        `${l("Offer valid through", "يسري العرض حتى")}: ${date(e.input.validity_date)}`,
      );
      p(e.input.commercial_terms);
    } else if (Array.isArray(proposed?.lines) && proposed.lines.length) {
      p(
        l(
          "Proposed commercial inputs — awaiting review. These items have no confirmed prices or calculated totals.",
          "مدخلات تجارية مقترحة بانتظار المراجعة. لا تتضمن هذه البنود أسعارًا مؤكدة أو إجماليات محسوبة.",
        ),
      );
      p(
        `${l("Currency", "العملة")}: ${unknown(l("confirm offer currency", "تأكيد عملة العرض"))}`,
      );
      const charge: Record<string, string> = {
        one_time: l("One-time", "لمرة واحدة"),
        recurring: l("Recurring", "متكرر"),
        optional: l("Optional", "اختياري"),
      };
      blocks.push({
        type: "table",
        headers: [
          l("Item", "البند"),
          l("Quantity and unit", "الكمية والوحدة"),
          l("Number of periods", "عدد الفترات"),
          l("Charge", "نوع التكلفة"),
          l("Price", "السعر"),
        ],
        rows: proposed.lines.map((line: Row) => [
          clean(line.description),
          `${cell(line.quantity)} ${clean(line.unit)}`.trim(),
          cell(line.period_count),
          `${line.included_in_base ? l("Proposed base", "أساسي مقترح") : l("Outside proposed base", "خارج الأساسي المقترح")} · ${charge[line.charge_group] || clean(line.charge_group)}`,
          placeholderPolicy === 2
            ? unknown(l("confirm pricing", "تأكيد التسعير"))
            : l("Awaiting confirmed pricing", "بانتظار تأكيد التسعير"),
        ]),
      });
      for (const line of proposed.lines) {
        if (line.deliverable)
          p(
            `${clean(line.description)} — ${l("Deliverable", "المخرج")}: ${clean(line.deliverable)}`,
          );
        if (line.basis) p(`${l("Basis", "الأساس")}: ${clean(line.basis)}`);
        p(
          `${l("Tax category", "الفئة الضريبية")}: ${supplied(line.tax_category, l("tax category", "الفئة الضريبية"))}`,
        );
      }
    } else
      p(
        l(
          "[INPUT REQUIRED: approved commercial estimate]",
          "[INPUT REQUIRED: تقدير مالي معتمد]",
        ),
      );
  }
  if (draft) {
    const questions = (s.questions || []).filter((q: Row) =>
      reviewItemInVolume(q.target_section_key ? [q.target_section_key] : []),
    );
    const findings = (s.review_result?.findings || []).filter((finding: Row) =>
      reviewItemInVolume(finding.section_ids || []),
    );
    if (questions.length || findings.length) {
      h(
        l(
          "Open questions and review items",
          "الأسئلة المفتوحة وملاحظات المراجعة",
        ),
      );
      p(
        l(
          "Resolve these items before final approval. Model review findings are suggestions for human review.",
          "تُراجع هذه البنود قبل الاعتماد النهائي. نتائج مراجعة الموديل ملاحظات تحتاج إلى مراجعة بشرية.",
        ),
      );
      const levels: Record<string, string> = {
        generation: l("Generation input", "مدخل للإنشاء"),
        finalization: l(
          "Required before final approval",
          "مطلوب قبل الاعتماد النهائي",
        ),
        advisory: l("Advisory", "إرشادي"),
        blocking: l("Requires review", "يحتاج إلى مراجعة"),
      };
      for (const q of questions) {
        blocks.push({
          type: "bullet",
          text: `${levels[q.blocking_level] || l("Review", "مراجعة")}: ${clean(q.question)}`,
        });
        if (q.target_section_key)
          p(`${l("Section", "القسم")}: ${sectionTitle(q.target_section_key)}`);
      }
      const existing = new Set(questions.map((q: Row) => clean(q.question)));
      for (const finding of findings)
        if (!existing.has(clean(finding.detail)))
          blocks.push({
            type: "bullet",
            text: `${l("Model review", "مراجعة الموديل")} — ${levels[finding.severity] || l("Review", "مراجعة")}: ${clean(finding.detail)}`,
          });
    }
  }
  const model: RenderModel = {
    ...(placeholderPolicy === 2 ? { placeholder_version: 2 as const } : {}),
    id: request.id,
    version: s.ordinal,
    mode: request.mode,
    volume: request.volume,
    language: s.language,
    created_at: request.created_at,
    footer: clean(s.template?.style_config?.footer),
    blocks,
  };
  const visible = exportParagraphs(model).join("\n");
  if (blockedContent(visible))
    throw new AppError(
      422,
      "DATA_POLICY_BLOCKED",
      "Export content requires eligibility review.",
    );
  if (request.mode === "final" && /\[INPUT REQUIRED/i.test(visible))
    throw new AppError(
      422,
      "EXPORT_BLOCKED",
      "Resolve missing input before final export.",
    );
  if (
    request.volume === "technical" &&
    /(?:\b(?:SAR|USD|AED|EUR)\s*[\d]|\d[\d,.]*\s*(?:ريال|دولار))/.test(visible)
  )
    throw new AppError(
      422,
      "TECHNICAL_VOLUME_CONTAINS_PRICE",
      "Review pricing separation before export.",
    );
  return model;
}
export function exportParagraphs(model: RenderModel): string[] {
  return model.blocks
    .flatMap((b) =>
      b.type === "table" ? [b.headers, ...b.rows].flat() : [b.text],
    )
    .map(normalize)
    .filter(Boolean);
}
const normalize = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[\u200e\u200f\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
export function verifyExportDocx(bytes: Uint8Array, model: RenderModel) {
  return verifyBoundedDocx(bytes, model, blockedContent);
}

export function verifyExportDocxAsync(
  bytes: Uint8Array,
  model: RenderModel,
  signal?: AbortSignal,
) {
  if (hasNativeVerifierRuntime())
    return verifyDeliveryIsolated(bytes, model, signal);
  return verifyBoundedDocxAsync(bytes, model, blockedContent, signal);
}

/** Internal deliveryBytes bridge. Both inputs are already private call-time
 * snapshots; no caller-owned buffer or mutable model is accepted on this path. */
export function verifyOwnedExportDocxSnapshot(
  bytes: Uint8Array,
  modelJson: string,
  signal?: AbortSignal,
) {
  if (hasNativeVerifierRuntime())
    return verifyOwnedDeliverySnapshot(bytes, modelJson, signal);
  return verifyBoundedDocxAsync(
    bytes,
    JSON.parse(modelJson) as RenderModel,
    blockedContent,
    signal,
  );
}
