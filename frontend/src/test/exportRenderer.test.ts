// @vitest-environment node
import { it, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { renderDocx, type FontData } from "../lib/renderDocx";
import {
  buildExportModel,
  verifyExportDocx,
} from "../../../backend/supabase/functions/_shared/export";
import { exportFixture } from "./fixtures/exportModels";
import JSZip from "jszip";
async function fonts() {
  return Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (n) => [
          n,
          new Uint8Array(
            await readFile(
              new URL(`../../public/fonts/${n}.ttf`, import.meta.url),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
}
it("packages exact authorized English/Arabic content with native tables, TOC, RTL and embedded fonts", async () => {
  const fontData = await fonts();
  for (const [language, volume, mode] of [
    ["en", "combined", "draft"],
    ["ar", "combined", "final"],
    ["en", "technical", "final"],
    ["en", "financial", "final"],
  ]) {
    const model = buildExportModel(exportFixture(language, volume, mode)),
      blob = await renderDocx(model, fontData),
      bytes = new Uint8Array(await blob.arrayBuffer());
    expect(() => verifyExportDocx(bytes, model)).not.toThrow();
    const zip = await JSZip.loadAsync(bytes);
    expect(
      Object.keys(zip.files).filter((p) => p.endsWith(".odttf")),
    ).toHaveLength(4);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("TOC");
    expect(xml).toContain("<w:tbl>");
    if (language === "ar") {
      expect(xml).toContain("w:bidi");
      expect(xml).toContain("w:bidiVisual");
      expect(xml).toContain("المتطلبات");
    }
    if (volume === "technical") expect(xml).not.toContain("16698");
    if (process.env.TENDERDESK_EXPORT_QA_DIR) {
      await mkdir(process.env.TENDERDESK_EXPORT_QA_DIR, { recursive: true });
      await writeFile(
        `${process.env.TENDERDESK_EXPORT_QA_DIR}/${language}_${volume}.docx`,
        bytes,
      );
    }
    zip.file(
      "word/document.xml",
      xml.replaceAll(
        language === "ar" ? "منهجية التنفيذ" : "Fixed approved wording",
        "Unapproved replacement",
      ),
    );
    await expect(async () =>
      verifyExportDocx(await zip.generateAsync({ type: "uint8array" }), model),
    ).rejects.toMatchObject({ code: "EXPORT_CONTENT_MISMATCH" });
  }
}, 30000);

it("renders saved section parts as one chapter while preserving every authorized paragraph and table", async () => {
  const base = exportFixture("en", "combined", "draft");
  const firstBlocks = [
    {
      type: "paragraph",
      text: "First saved part: establish the acceptance baseline.",
    },
    {
      type: "table",
      headers: ["Stage", "Evidence"],
      rows: [["Baseline", "Approved requirement inventory"]],
    },
  ];
  const secondBlocks = [
    {
      type: "paragraph",
      text: "Second saved part: verify the delivered workflow.",
    },
    {
      type: "table",
      headers: ["Check", "Result"],
      rows: [["Workflow test", "Recorded acceptance decision"]],
    },
    {
      type: "bullet",
      text: "Retain the decision record with the delivered documentation.",
    },
  ];
  const fixed = { ...base.snapshot.sections[1], fixed: true };
  const request = {
    ...base,
    snapshot: {
      ...base.snapshot,
      sections: [
        {
          section_key: "approach-part1",
          title: "Implementation approach",
          volume: "technical",
          body: "",
          content_blocks: firstBlocks,
        },
        {
          section_key: "approach-part2",
          title: "Implementation approach",
          volume: "technical",
          body: "",
          content_blocks: secondBlocks,
        },
        fixed,
      ],
      section_outline: {
        version: 1,
        groups: [
          {
            parent_section_key: "approach",
            title: "Implementation approach",
            volume: "technical",
            parts: [
              { section_key: "approach-part1", part_index: 1, part_count: 2 },
              { section_key: "approach-part2", part_index: 2, part_count: 2 },
            ],
          },
          {
            parent_section_key: fixed.section_key,
            title: fixed.title,
            volume: fixed.volume,
            parts: [
              { section_key: fixed.section_key, part_index: 1, part_count: 1 },
            ],
          },
        ],
      },
    },
  };
  const before = JSON.stringify(request.snapshot.sections);
  const model = buildExportModel(request);
  const chapterStart = model.blocks.findIndex(
    (b) => b.type === "heading" && b.text === "Implementation approach",
  );
  const chapterEnd = model.blocks.findIndex(
    (b) => b.type === "heading" && b.text === "Delivery schedule",
  );
  expect(chapterStart).toBeGreaterThan(-1);
  expect(model.blocks.slice(chapterStart, chapterEnd)).toEqual([
    { type: "heading", text: "Implementation approach" },
    ...firstBlocks,
    ...secondBlocks,
    { type: "heading", text: fixed.title },
    { type: "paragraph", text: fixed.body },
  ]);
  expect(JSON.stringify(request.snapshot.sections)).toBe(before);

  const blob = await renderDocx(model, await fonts());
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect(() => verifyExportDocx(bytes, model)).not.toThrow();
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(
    ([paragraph]) => paragraph,
  );
  const paragraphTexts = paragraphs.map((paragraph) =>
    [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map(([, text]) => text)
      .join(""),
  );
  const headingParagraphs = paragraphs.filter((paragraph) =>
    /<w:pStyle\b[^>]*w:val="Heading1"/.test(paragraph),
  );
  expect(
    headingParagraphs.filter((p) => p.includes("Implementation approach")),
  ).toHaveLength(1);
  expect(headingParagraphs.filter((p) => p.includes(fixed.title))).toHaveLength(
    1,
  );
  for (const text of [
    firstBlocks[0].text,
    "Approved requirement inventory",
    secondBlocks[0].text,
    "Recorded acceptance decision",
    secondBlocks[2].text,
    fixed.body,
  ]) {
    expect(text).toBeTruthy();
    expect(
      paragraphTexts.filter((paragraph) => paragraph === text),
    ).toHaveLength(1);
  }
  expect(paragraphTexts.indexOf(firstBlocks[0].text!)).toBeLessThan(
    paragraphTexts.indexOf(secondBlocks[0].text!),
  );
}, 30000);
