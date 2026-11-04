// @vitest-environment node
import { beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import {
  renderDocx,
  type FontData,
  type RenderModel,
} from "../../../frontend/src/lib/renderDocx";
import { verifyExportDocx } from "../../supabase/functions/_shared/export";
let fonts: FontData;
beforeAll(async () => {
  fonts = Object.fromEntries(
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
});
it.each(
  [1, 2, 3].flatMap((version) =>
    ["en", "ar"].map((language) => ({ version, language })),
  ),
)(
  "keeps $language renderer $version PAGE tokens separate after a yellow body placeholder",
  async ({ version, language }) => {
    const ar = language === "ar",
      model: RenderModel = {
        id: "synthetic-footer",
        version,
        language,
        placeholder_version: version === 3 ? 2 : 1,
        mode: "draft",
        volume: "combined",
        created_at: "2026-11-04T00:00:00Z",
        footer: ar ? "مسودة" : "Draft",
        blocks: [
          {
            type: "title",
            text: ar ? "فحص حقول المستند" : "Document field test",
          },
          { type: "toc", text: ar ? "المحتويات" : "Contents" },
          { type: "heading", text: ar ? "النطاق" : "Scope" },
          {
            type: "paragraph",
            text: ar ? "نص اصطناعي لفحص التنسيق." : "Synthetic layout text.",
          },
          {
            type: "placeholder",
            text: ar
              ? "[مطلوب: موعد القبول]"
              : "[INPUT REQUIRED: acceptance date]",
            gap_id: "gap-1",
          },
        ],
      };
    const bytes = new Uint8Array(
      await (await renderDocx(model, fonts)).arrayBuffer(),
    );
    expect(verifyExportDocx(bytes, model)).toBe(true);
    const files = unzipSync(bytes),
      footer = strFromU8(files["word/footer1.xml"]),
      document = strFromU8(files["word/document.xml"]);
    const fieldRuns = [...footer.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)]
      .map((match) => match[1])
      .filter((run) => /<w:(?:fldChar|instrText)\b/.test(run));
    expect(fieldRuns).toHaveLength(4);
    expect(
      fieldRuns.map(
        (run) => (run.match(/<w:(?:fldChar|instrText)\b/g) || []).length,
      ),
    ).toEqual([1, 1, 1, 1]);
    expect(
      fieldRuns.every((run) => run.includes('<w:highlight w:val="none"/>')),
    ).toBe(true);
    expect(fieldRuns[0]).toContain('w:fldCharType="begin"');
    expect(fieldRuns[1]).toContain(">PAGE</w:instrText>");
    expect(fieldRuns[2]).toContain('w:fldCharType="separate"');
    expect(fieldRuns[3]).toContain('w:fldCharType="end"');
    expect(footer).not.toContain('w:val="yellow"');
    expect(document).toContain('w:highlight w:val="yellow"');
    expect(document).toContain(">TOC ");
    expect(document).toContain(">PAGEREF ");
    expect(strFromU8(files["word/settings.xml"])).toContain("<w:updateFields");
  },
);
