import { deliveryPayloadSchema, type DeliveryGap } from "./deliveryContract.ts";
import { AppError } from "./http.ts";
import {
  blockedContent,
  hasRestrictedDocumentContent,
} from "./contentPolicy.ts";
import {
  exportParagraphs,
  type ExportBlock,
  type RenderModel,
} from "./export.ts";

export const DELIVERY_RENDERER_VERSION = "1";
export function deliveryRendererVersion(
  snapshot: Record<string, any>,
): "1" | "2" | "3" {
  const parsed = deliveryPayloadSchema.safeParse(snapshot.payload);
  if (!parsed.success)
    throw new AppError(
      422,
      "DELIVERY_ARTIFACT_INVALID",
      "The saved draft contract is invalid.",
    );
  const payload = parsed.data;
  return payload.version === 3 ? "3" : payload.version === 2 ? "2" : "1";
}
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type DeliveryVolume = "combined" | "technical" | "financial";
export type DeliveryRenderGap = Omit<DeliveryGap, "reason"> & {
  reason:
    | DeliveryGap["reason"]
    | "CONTENT_WITHHELD_POLICY"
    | "FINANCIAL_CONTENT_SEPARATION_REQUIRED";
  origin: "snapshot" | "rendering";
};
export type DeliveryRenderingGapSummary = {
  snapshot_gap_count: number;
  rendering_gap_count: number;
  total_gap_count: number;
  gaps: DeliveryRenderGap[];
};

const currencyCodes =
  "SAR|USD|AED|EUR|GBP|QAR|KWD|BHD|OMR|JPY|CNY|RMB|INR|PKR|BDT|EGP|JOD|IQD|LBP|CHF|CAD|AUD|NZD|SGD|HKD|KRW|TRY|RUB|ZAR|MYR|IDR|PHP|THB|VND|BRL|MXN";
const currencyCode = new RegExp(
  `(?<![A-Za-z])(?:${currencyCodes})(?![A-Za-z])`,
);
const currencyAmount = new RegExp(
  `(?:\\p{Nd}\\s*(?:${currencyCodes})(?![A-Za-z])|(?<![A-Za-z])(?:${currencyCodes})\\s*\\p{Nd})`,
  "iu",
);
/** Conservative financial markers, not assurance that unclassified prose is a
 * completed technical response. Omissions always become explicit review items. */
function financialContent(text: string) {
  const normalized = text
    .normalize("NFKC")
    .replace(/ی/g, "ي")
    .replace(/[\u200e\u200f\u2066-\u2069]/g, "");
  // Bare codes are case-sensitive: ordinary "try" is not Turkish lira. Lowercase
  // codes adjacent to an amount remain monetary markers, including Arabic digits.
  return (
    currencyCode.test(normalized) ||
    currencyAmount.test(normalized) ||
    /\p{Sc}|\b(?:prices?|pricing|fees?|budget|payment|invoice|costs?|financial amount|dollars?|euros?|riyals?|dirhams?|dinars?|pounds?|rupees?|yuan|yen)\b|(?:ريال|دولار|درهم|دينار|جنيه|يورو|أسعار|اسعار|سعر|تكلفة|تكاليف|ميزانية|مبلغ|رسوم|دفعات|دفعة|فاتورة|الدفع)/iu.test(
      normalized,
    )
  );
}
const blockText = (block: {
  type: string;
  text?: string;
  headers?: string[];
  rows?: string[][];
}) =>
  block.type === "table"
    ? [...(block.headers || []), ...(block.rows || []).flat()].join("\n")
    : block.text || "";

function projectDelivery(
  snapshot: Record<string, any>,
  volume: DeliveryVolume,
): { model: RenderModel; summary: DeliveryRenderingGapSummary } {
  const parsed = deliveryPayloadSchema.safeParse(snapshot.payload);
  if (!parsed.success)
    throw new AppError(
      422,
      "DELIVERY_ARTIFACT_INVALID",
      "The saved draft contract is invalid.",
    );
  const payload = parsed.data;
  if (payload.separate_volumes ? volume === "combined" : volume !== "combined")
    throw new AppError(
      422,
      "BUYER_VOLUME_RULE",
      "Use the saved proposal volume rule.",
    );
  const ar = payload.language === "ar";
  const l = (en: string, arabic: string) => (ar ? arabic : en);
  const gaps = new Map(payload.gaps.map((gap) => [gap.id, gap]));
  if (gaps.size !== payload.gaps.length)
    throw new AppError(
      422,
      "DELIVERY_GAP_INVALID",
      "Missing-input identities must be unique.",
    );
  const sections = payload.sections
    .map((section, index) => ({ section, index }))
    .filter(
      ({ section }) =>
        volume === "combined" ||
        section.volume === volume ||
        section.volume === "shared",
    );
  const includedGaps = new Set<string>();
  const visibleGaps: DeliveryRenderGap[] = [];
  const usedIds = new Set(gaps.keys());
  const blocks: ExportBlock[] = [];
  let gapSequence = 0;
  type Location = {
    section_key: string;
    field_path: string;
    source_ids: string[];
  };
  const location = (field_path: string): Location => ({
    section_key: "document",
    field_path,
    source_ids: [],
  });
  const addGap = (
    reason: "CONTENT_WITHHELD_POLICY" | "FINANCIAL_CONTENT_SEPARATION_REQUIRED",
    at: Location,
    existing?: DeliveryGap,
  ) => {
    let id = existing?.id;
    if (!id)
      do {
        id = `render:${volume}:${++gapSequence}`;
      } while (usedIds.has(id));
    usedIds.add(id);
    const label =
      reason === "CONTENT_WITHHELD_POLICY"
        ? l(
            "Content withheld from this draft under the content policy. It may contain required information; review the saved original through its authorized source before completing this response.",
            "حُجب محتوى من هذه المسودة وفق سياسة المحتوى، وقد يتضمن معلومات مطلوبة. راجع الأصل المحفوظ من مصدره المصرح به قبل استكمال الاستجابة.",
          )
        : l(
            "Financial content withheld from the technical volume. It may include a requirement or condition; review the saved original and the financial volume before completing this response.",
            "حُجب محتوى مالي من العرض الفني، وقد يتضمن متطلبًا أو شرطًا. راجع الأصل المحفوظ والعرض المالي قبل استكمال الاستجابة.",
          );
    visibleGaps.push({
      ...at,
      id,
      reason,
      label,
      required_for: "substantive_completion",
      origin: "rendering",
    });
    blocks.push({ type: "placeholder", text: label, gap_id: id });
  };
  const reasonFor = (text: string) =>
    blockedContent(text)
      ? ("CONTENT_WITHHELD_POLICY" as const)
      : volume === "technical" && financialContent(text)
        ? ("FINANCIAL_CONTENT_SEPARATION_REQUIRED" as const)
        : null;
  const addText = (
    type: "title" | "heading" | "paragraph" | "bullet",
    text: string,
    at: Location,
  ) => {
    const reason = reasonFor(text);
    if (reason) {
      if (type === "title" || type === "heading")
        blocks.push({
          type,
          text: l(
            "Draft content requiring review",
            "محتوى المسودة المطلوب مراجعته",
          ),
        });
      addGap(reason, at);
    } else blocks.push({ type, text });
  };

  addText("title", payload.title, location("$.title"));
  blocks.push(
    {
      type: "paragraph",
      text:
        payload.version === 3
          ? l(
              "GENERATED RESPONSE DRAFT — model checks recorded; final source review and approval required",
              "مسودة الاستجابة المولدة — سُجلت فحوص النماذج؛ مراجعة المصادر والاعتماد النهائي مطلوبان",
            )
          : payload.version === 2 && payload.substantive_complete
            ? l(
                "DRAFT — substantive responses reviewed; final approval required",
                "مسودة — روجع محتوى الاستجابات؛ الاعتماد النهائي مطلوب",
              )
            : l(
                "DRAFT — incomplete response; review before external use",
                "مسودة — الاستجابة غير مكتملة؛ تُراجع قبل الاستخدام الخارجي",
              ),
    },
    {
      type: "paragraph",
      text: `${l("Saved draft", "المسودة المحفوظة")} ${snapshot.ordinal}`,
    },
  );
  addText("paragraph", payload.notice, location("$.notice"));
  blocks.push(
    {
      type: "paragraph",
      text:
        volume === "technical"
          ? l("Technical volume", "العرض الفني")
          : volume === "financial"
            ? l("Financial volume", "العرض المالي")
            : l("Technical and commercial draft", "مسودة العرض الفني والمالي"),
    },
    { type: "toc", text: l("Contents", "المحتويات") },
  );

  // A classification mark or credential can govern its entire source, including
  // following key-body lines. Do not hide only its first line and leak the rest.
  const restrictedSections = new Set<number>(),
    restrictedSources = new Set<string>();
  payload.sections.forEach((section, index) => {
    if (
      hasRestrictedDocumentContent(
        [section.title, ...section.content_blocks.map(blockText)].join("\n"),
      )
    ) {
      restrictedSections.add(index);
      section.source_ids.forEach((id) => restrictedSources.add(id));
    }
  });
  const restrictedDocument =
    hasRestrictedDocumentContent(payload.title) ||
    hasRestrictedDocumentContent(payload.notice);
  for (const { section, index } of sections) {
    const at = (field: string): Location => ({
      section_key: section.section_key,
      field_path: `$.sections[${index}].${field}`,
      source_ids: [...section.source_ids],
    });
    const restricted =
      restrictedDocument ||
      restrictedSections.has(index) ||
      section.source_ids.some((id) => restrictedSources.has(id));
    if (restricted) {
      blocks.push({
        type: "heading",
        text: l(
          "Source content requiring review",
          "محتوى المصدر المطلوب مراجعته",
        ),
      });
      addGap("CONTENT_WITHHELD_POLICY", at("title"));
    } else addText("heading", section.title, at("title"));
    if (section.kind === "source_extract")
      blocks.push({
        type: "paragraph",
        text: l(
          "Source extract — retained for context; this is not a prepared response or a confirmed requirement classification.",
          "مقتطف من المصدر محفوظ للسياق؛ لا يمثل استجابة معدّة أو تصنيفًا مؤكدًا للمتطلبات.",
        ),
      });
    if (section.kind === "accepted_unit")
      blocks.push({
        type: "paragraph",
        text: l(
          "Previously accepted content — its original verification applies; current assurance review is still required.",
          "محتوى مقبول سابقًا وفق تحققه الأصلي؛ ما زالت مراجعة ضمانه الحالية مطلوبة.",
        ),
      });
    const financialSection =
      volume === "technical" && financialContent(section.title);
    section.content_blocks.forEach((block, blockIndex) => {
      const position = at(`content_blocks[${blockIndex}]`);
      if (block.type === "placeholder") {
        const gap = gaps.get(block.gap_id);
        if (
          !gap ||
          gap.section_key !== section.section_key ||
          includedGaps.has(gap.id)
        )
          throw new AppError(
            422,
            "DELIVERY_GAP_INVALID",
            "The missing-input reference is invalid.",
          );
        includedGaps.add(gap.id);
        const reason = restricted
          ? "CONTENT_WITHHELD_POLICY"
          : reasonFor(gap.label);
        if (reason)
          addGap(
            reason,
            {
              ...position,
              field_path: gap.field_path,
              source_ids: [...gap.source_ids],
            },
            gap,
          );
        else {
          visibleGaps.push({ ...gap, origin: "snapshot" });
          blocks.push({ type: "placeholder", text: gap.label, gap_id: gap.id });
        }
        return;
      }
      if (restricted) {
        addGap("CONTENT_WITHHELD_POLICY", position);
        return;
      }
      if (financialSection) {
        addGap("FINANCIAL_CONTENT_SEPARATION_REQUIRED", position);
        return;
      }
      const text = blockText(block),
        reason = reasonFor(text);
      if (!reason) {
        blocks.push(block);
        return;
      }
      if (block.type === "table") {
        addGap(reason, position);
        return;
      }
      // Retain safe source sentences/lines in their original order. A removed
      // segment gets a visible gap; withholding never asserts full coverage.
      const segments = block.text
        .split(/(?<=[.!?؟。])[ \t]+|\r?\n+/u)
        .filter((part) => part.trim());
      for (const [part, segment] of segments.entries())
        addText(block.type, segment, {
          ...position,
          field_path: `${position.field_path}.segments[${part}]`,
        });
    });
  }
  if (
    payload.gaps.some(
      (gap) =>
        sections.some(
          ({ section }) => section.section_key === gap.section_key,
        ) && !includedGaps.has(gap.id),
    )
  )
    throw new AppError(
      422,
      "DELIVERY_GAP_INVALID",
      "Every missing input must appear in the draft.",
    );
  const model: RenderModel = {
    placeholder_version: payload.version === 3 ? 2 : 1,
    id: snapshot.id,
    version: snapshot.ordinal,
    mode: "draft",
    volume,
    language: payload.language,
    created_at: snapshot.created_at,
    footer: l("Draft — review required", "مسودة — تحتاج إلى مراجعة"),
    blocks,
  };
  // Defense in depth: derived labels never contain the withheld value.
  if (blockedContent(exportParagraphs(model).join("\n")))
    throw new AppError(
      422,
      "DATA_POLICY_BLOCKED",
      "Draft content requires eligibility review.",
    );
  const rendering = visibleGaps.filter(
    (gap) => gap.origin === "rendering",
  ).length;
  return {
    model,
    summary: {
      snapshot_gap_count: visibleGaps.length - rendering,
      rendering_gap_count: rendering,
      total_gap_count: visibleGaps.length,
      gaps: visibleGaps,
    },
  };
}

/** Only the rendering projection changes; the authorized snapshot stays immutable. */
export function buildDeliveryExport(
  snapshot: Record<string, any>,
  volume: DeliveryVolume,
): RenderModel {
  return projectDelivery(snapshot, volume).model;
}
export function deliveryRenderingGapSummary(
  snapshot: Record<string, any>,
  volume: DeliveryVolume,
): DeliveryRenderingGapSummary {
  return projectDelivery(snapshot, volume).summary;
}
