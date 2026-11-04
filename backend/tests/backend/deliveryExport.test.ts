import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  buildDeliveryExport,
  deliveryRenderingGapSummary,
} from "../../supabase/functions/_shared/deliveryExport.ts";
import { verifyExportDocx } from "../../supabase/functions/_shared/export.ts";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx.ts";

const snapshot = (language = "en", separate = false): Record<string, any> => ({
  id: "00000000-0000-4000-8000-000000000001",
  ordinal: 1,
  created_at: "2026-11-04T00:00:00Z",
  payload: {
    version: 1,
    title:
      language === "ar"
        ? "عرض مراجعة إجراءات التشغيل"
        : "Operating procedure review proposal",
    language,
    template: {},
    separate_volumes: separate,
    input_state: "available",
    content_state: "source_draft",
    assurance_state: "unreviewed",
    substantive_complete: false,
    approval_state: "draft",
    notice:
      language === "ar"
        ? "معلومات المصدر محفوظة، والاستجابة قيد الإعداد."
        : "Source information is saved; response preparation is pending.",
    source_manifest: [],
    input_materials: {},
    sections: [
      {
        section_key: "scope",
        title: "Scope",
        volume: "technical",
        kind: "source_extract",
        source_ids: [],
        provenance: null,
        content_blocks: [
          {
            type: "paragraph",
            text:
              language === "ar"
                ? "يجب إعداد دليل تشغيل خلال ثلاثين يومًا."
                : "An operating manual is required within thirty days.",
          },
          { type: "placeholder", gap_id: "scope.response" },
        ],
      },
      {
        section_key: "commercial",
        title: "Commercial inputs",
        volume: "financial",
        kind: "response",
        source_ids: [],
        provenance: null,
        content_blocks: [{ type: "placeholder", gap_id: "commercial.price" }],
      },
    ],
    gaps: [
      {
        id: "scope.response",
        section_key: "scope",
        field_path: "response",
        reason: "RESPONSE_NOT_PREPARED",
        label:
          language === "ar"
            ? "مطلوب: منهجية الاستجابة وجدول التنفيذ"
            : "Required: response approach and delivery schedule",
        required_for: "substantive_completion",
        source_ids: [],
      },
      {
        id: "commercial.price",
        section_key: "commercial",
        field_path: "price",
        reason: "COMMERCIAL_CONFIRMATION_REQUIRED",
        label:
          language === "ar"
            ? "مطلوب: السعر والعملة المعتمدان"
            : "Required: confirmed price and currency",
        required_for: "final_approval",
        source_ids: [],
      },
    ],
  },
});
async function fonts(): Promise<FontData> {
  return Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
}

it("keeps source context and typed gaps honest without model success or company/price fabrication", () => {
  const model = buildDeliveryExport(snapshot(), "combined");
  expect(model.mode).toBe("draft");
  expect(model.placeholder_version).toBe(1);
  expect(model.blocks.filter((block) => block.type === "placeholder")).toEqual([
    {
      type: "placeholder",
      text: "Required: response approach and delivery schedule",
      gap_id: "scope.response",
    },
    {
      type: "placeholder",
      text: "Required: confirmed price and currency",
      gap_id: "commercial.price",
    },
  ]);
  expect(model.blocks).toContainEqual({
    type: "paragraph",
    text: "An operating manual is required within thirty days.",
  });
  expect(JSON.stringify(model)).not.toMatch(
    /insufficient information|approved proposal|USD 0/i,
  );
});

it("separates volumes and refuses missing, duplicate or wrong-section gap references", () => {
  const value = snapshot("en", true);
  const technical = buildDeliveryExport(value, "technical");
  expect(JSON.stringify(technical)).not.toContain("confirmed price");
  expect(
    buildDeliveryExport(value, "financial").blocks.some(
      (b) => b.type === "placeholder" && b.gap_id === "commercial.price",
    ),
  ).toBe(true);
  expect(() => buildDeliveryExport(value, "combined")).toThrowError(
    expect.objectContaining({ code: "BUYER_VOLUME_RULE" }),
  );
  for (const change of [
    (x: any) => {
      x.payload.gaps.pop();
    },
    (x: any) => {
      x.payload.gaps[0].section_key = "commercial";
    },
    (x: any) => {
      x.payload.gaps.push(x.payload.gaps[0]);
    },
    (x: any) => {
      x.payload.sections[0].content_blocks.pop();
    },
  ]) {
    const invalid = snapshot();
    change(invalid);
    expect(() => buildDeliveryExport(invalid, "combined")).toThrowError(
      expect.objectContaining({ code: "DELIVERY_GAP_INVALID" }),
    );
  }
});

it("renders Arabic and English typed gaps yellow and rejects missing or misplaced highlighting with identical text", async () => {
  const fontData = await fonts();
  for (const language of ["en", "ar"]) {
    const model = buildDeliveryExport(snapshot(language), "combined");
    const bytes = new Uint8Array(
      await (await renderDocx(model, fontData)).arrayBuffer(),
    );
    expect(verifyExportDocx(bytes, model)).toBe(true);
    const archive = unzipSync(bytes);
    const xml = strFromU8(archive["word/document.xml"]);
    expect(xml).toContain('w:highlight w:val="yellow"');
    if (language === "ar") expect(xml).toContain("w:bidi");
    for (const mutate of [
      (s: string) => s.replace(/<w:highlight w:val="yellow"\/>/g, ""),
      (s: string) =>
        s.replace(
          /<w:highlight w:val="yellow"\/>/g,
          '<w:highlight w:val="green"/>',
        ),
      (s: string) =>
        s.replace("<w:rPr>", '<w:rPr><w:highlight w:val="yellow"/>'),
    ]) {
      const changed = zipSync({
        ...archive,
        "word/document.xml": strToU8(mutate(xml)),
      });
      expect(() => verifyExportDocx(changed, model)).toThrowError(
        expect.objectContaining({ code: "EXPORT_PLACEHOLDER_MISMATCH" }),
      );
    }
  }
}, 30000);

it.each(["source_extract", "accepted_unit"])(
  "withholds a contact sentence from %s while preserving useful source clauses, immutable original and truthful gaps",
  (kind) => {
    const value = snapshot();
    value.payload.sections[0].kind = kind;
    value.payload.sections[0].source_ids = [
      "10000000-0000-4000-8000-000000000001",
    ];
    value.payload.sections[0].content_blocks[0].text =
      "Deliver the manual within thirty days. Contact procurement@example.test for scheduling. Buyer approval remains required.";
    const original = structuredClone(value);
    const model = buildDeliveryExport(value, "combined");
    const summary = deliveryRenderingGapSummary(value, "combined");
    const output = JSON.stringify({ model, summary });
    expect(output).toContain("Deliver the manual within thirty days.");
    expect(output).toContain("Buyer approval remains required.");
    expect(output).not.toContain("procurement@example.test");
    expect(summary).toMatchObject({
      snapshot_gap_count: 2,
      rendering_gap_count: 1,
      total_gap_count: 3,
    });
    expect(
      summary.gaps.find((gap) => gap.origin === "rendering"),
    ).toMatchObject({
      reason: "CONTENT_WITHHELD_POLICY",
      source_ids: value.payload.sections[0].source_ids,
      field_path: "$.sections[0].content_blocks[0].segments[1]",
    });
    expect(
      model.blocks.filter((block) => block.type === "placeholder"),
    ).toHaveLength(summary.total_gap_count);
    expect(model.mode).toBe("draft");
    expect(value).toEqual(original);
    expect(deliveryRenderingGapSummary(value, "combined")).toEqual(summary);
  },
);

it.each([
  "100 USD",
  "USD100",
  "100USD",
  "usd100",
  "$100",
  "SAR ١٠٠",
  "۱۰۰ ریال",
  "€100",
  "JPY 10,000",
  "One hundred US dollars",
  "Payment requires buyer approval",
  "السعر مئة ريال",
])(
  "keeps financial source '%s' in the financial volume with an explicit technical gap",
  (financial) => {
    const value = snapshot("en", true);
    value.payload.sections[0].volume = "shared";
    value.payload.sections[0].content_blocks[0].text = `Deliver the operations manual. ${financial}. Retain buyer sign-off.`;
    const original = structuredClone(value);
    const technical = buildDeliveryExport(value, "technical");
    const monetary = buildDeliveryExport(value, "financial");
    expect(JSON.stringify(technical)).toContain(
      "Deliver the operations manual.",
    );
    expect(JSON.stringify(technical)).toContain("Retain buyer sign-off.");
    expect(JSON.stringify(technical)).not.toContain(financial);
    expect(JSON.stringify(monetary)).toContain(financial);
    const summary = deliveryRenderingGapSummary(value, "technical");
    expect(summary.rendering_gap_count).toBe(1);
    expect(
      summary.gaps.some(
        (gap) => gap.reason === "FINANCIAL_CONTENT_SEPARATION_REQUIRED",
      ),
    ).toBe(true);
    expect(
      summary.gaps.find((gap) => gap.origin === "rendering")?.label,
    ).toContain("requirement or condition");
    expect(value).toEqual(original);
  },
);

it("withholds financial tables as a unit and detects a financial heading over bare numeric cells", () => {
  const value = snapshot("en", true);
  value.payload.sections[0].volume = "shared";
  value.payload.sections[0].content_blocks.unshift({
    type: "table",
    headers: ["Item", "Unit price"],
    rows: [["Synthetic service", "100"]],
  });
  const technical = buildDeliveryExport(value, "technical");
  expect(technical.blocks.some((block) => block.type === "table")).toBe(false);
  expect(JSON.stringify(technical)).toContain(
    "An operating manual is required",
  );
  expect(
    buildDeliveryExport(value, "financial").blocks.some(
      (block) => block.type === "table",
    ),
  ).toBe(true);
  value.payload.sections[0].title = "Budget schedule";
  value.payload.sections[0].content_blocks = [
    { type: "paragraph", text: "123456" },
    { type: "placeholder", gap_id: "scope.response" },
  ];
  expect(JSON.stringify(buildDeliveryExport(value, "technical"))).not.toContain(
    "123456",
  );
  expect(JSON.stringify(buildDeliveryExport(value, "financial"))).toContain(
    "123456",
  );
});

it("propagates restricted source classification across its blocks and accepted fragments without leaking credential body lines", () => {
  const value = snapshot();
  const source = "10000000-0000-4000-8000-000000000001";
  value.payload.sections[0].source_ids = [source];
  value.payload.sections[0].content_blocks.unshift(
    { type: "paragraph", text: "-----BEGIN PRIVATE KEY-----" },
    { type: "paragraph", text: "SYNTHETIC-KEY-BODY-NOT-A-REAL-KEY" },
  );
  value.payload.sections.push({
    section_key: "retained",
    title: "Retained response",
    volume: "shared",
    kind: "accepted_unit",
    source_ids: [source],
    provenance: null,
    content_blocks: [
      { type: "paragraph", text: "Previously accepted confidential fragment" },
    ],
  });
  const original = structuredClone(value),
    model = buildDeliveryExport(value, "combined"),
    summary = deliveryRenderingGapSummary(value, "combined");
  expect(JSON.stringify({ model, summary })).not.toMatch(
    /SYNTHETIC-KEY-BODY|BEGIN PRIVATE|Previously accepted confidential fragment|An operating manual is required/,
  );
  expect(
    summary.gaps
      .filter((gap) => gap.origin === "rendering")
      .every((gap) => gap.reason === "CONTENT_WITHHELD_POLICY"),
  ).toBe(true);
  expect(value).toEqual(original);
});

it("replaces unsafe title, notice and existing gap label without leaking the value or double-counting placeholders", () => {
  const value = snapshot();
  value.payload.title = "Proposal for contact@example.test";
  value.payload.notice = "Reach contact@example.test";
  value.payload.gaps[0].label = "Required: contact@example.test";
  const model = buildDeliveryExport(value, "combined"),
    summary = deliveryRenderingGapSummary(value, "combined");
  expect(JSON.stringify({ model, summary })).not.toContain(
    "contact@example.test",
  );
  expect(summary).toMatchObject({
    snapshot_gap_count: 1,
    rendering_gap_count: 3,
    total_gap_count: 4,
  });
  expect(
    model.blocks.filter((block) => block.type === "placeholder"),
  ).toHaveLength(4);
  expect(summary.gaps.find((gap) => gap.id === "scope.response")).toMatchObject(
    { origin: "rendering", reason: "CONTENT_WITHHELD_POLICY" },
  );
});

it("renders every derived policy and financial gap yellow in Arabic and English while preserving safe content", async () => {
  const data = await fonts();
  for (const language of ["ar", "en"]) {
    const value = snapshot(language, true);
    value.payload.sections[0].volume = "shared";
    value.payload.sections[0].content_blocks.unshift({
      type: "paragraph",
      text: "Keep buyer approval. Contact private@example.test. Price USD 100.",
    });
    const model = buildDeliveryExport(value, "technical"),
      summary = deliveryRenderingGapSummary(value, "technical");
    expect(summary.rendering_gap_count).toBe(2);
    const bytes = new Uint8Array(
      await (await renderDocx(model, data)).arrayBuffer(),
    );
    expect(verifyExportDocx(bytes, model)).toBe(true);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).not.toContain("private@example.test");
    expect(xml).not.toContain("USD 100");
    expect(
      xml.replace(/<[^>]*>/g, "").replace(/[\u200e\u200f]/g, ""),
    ).toContain("Keep buyer approval.");
    expect(
      (xml.match(/w:highlight w:val="yellow"/g) || []).length,
    ).toBeGreaterThanOrEqual(summary.total_gap_count);
  }
}, 30000);

it("does not expose titles or gap labels from a restricted source and keeps derived identities distinct", () => {
  const value = snapshot();
  value.payload.sections[0].title = "Secret project description";
  value.payload.sections[0].content_blocks.unshift({
    type: "paragraph",
    text: "CONFIDENTIAL: synthetic restricted source",
  });
  value.payload.gaps[0].label = "Missing input for secret-project-alpha";
  value.payload.gaps[0].id = "render:combined:1";
  value.payload.sections[0].content_blocks[2].gap_id = "render:combined:1";
  const model = buildDeliveryExport(value, "combined"),
    summary = deliveryRenderingGapSummary(value, "combined");
  expect(JSON.stringify({ model, summary })).not.toMatch(
    /Secret project description|secret-project-alpha|CONFIDENTIAL:/,
  );
  expect(new Set(summary.gaps.map((gap) => gap.id)).size).toBe(
    summary.total_gap_count,
  );
  expect(
    model.blocks.filter((block) => block.type === "placeholder"),
  ).toHaveLength(summary.total_gap_count);
});

it("retains ordinary technical retry language rather than treating lowercase try as a currency", () => {
  const value = snapshot("en", true);
  value.payload.sections[0].content_blocks[0].text =
    "Try to restore the service within thirty minutes.";
  expect(JSON.stringify(buildDeliveryExport(value, "technical"))).toContain(
    "Try to restore the service within thirty minutes.",
  );
  expect(
    deliveryRenderingGapSummary(value, "technical").rendering_gap_count,
  ).toBe(0);
});
