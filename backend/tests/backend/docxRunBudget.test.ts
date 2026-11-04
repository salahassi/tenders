// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { Zip, ZipDeflate, strFromU8, strToU8, unzipSync } from "fflate";
import {
  docxRunSegments,
  NATIVE_DOCX_RUN_OVERHEAD,
} from "../../supabase/functions/_shared/docxRunSegments";
import {
  verifyExportDocxAsync,
  type RenderModel,
} from "../../supabase/functions/_shared/export";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";

const legacy = (value: string) =>
  value
    .split(/([A-Za-z0-9](?:[A-Za-z0-9 .,:%_/@()+\-]*[A-Za-z0-9%])?)/g)
    .filter(Boolean);
it("matches historical native run segmentation without changing punctuation, direction or Unicode", () => {
  const samples = [
    "",
    "aب",
    "بabc123%",
    "a, b-12.5% / c",
    "a, ب, z",
    "٠0۰",
    "👩‍💻&<>aب",
    "a  ",
    "---abc---",
    "a%_%b",
    "\u200eA\u200eالعربية\nEnglish",
  ];
  for (const sample of samples)
    expect([...docxRunSegments(sample)]).toEqual(legacy(sample));
  const alphabet = ["a", "ب", "0", " ", "%", ","];
  const scan = (prefix: string, remaining: number) => {
    expect([...docxRunSegments(prefix)]).toEqual(legacy(prefix));
    if (remaining)
      for (const character of alphabet) scan(prefix + character, remaining - 1);
  };
  scan("", 5);
});

it("verifies actual native alternating-direction XML above40MiB with a source-derived run budget and yields to cancellation", async () => {
  const fonts = Object.fromEntries(
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
  const small: RenderModel = {
    id: "synthetic-run-budget",
    version: 1,
    mode: "draft",
    volume: "combined",
    language: "ar",
    created_at: "2026-11-04T00:00:00Z",
    footer: "Tenderdesk · Draft",
    placeholder_version: 2,
    blocks: [
      { type: "title", text: "عرض تجريبي" },
      { type: "toc", text: "المحتويات" },
      { type: "heading", text: "المنهجية" },
      { type: "paragraph", text: "aب" },
    ],
  };
  const native = unzipSync(
    new Uint8Array(await (await renderDocx(small, fonts)).arrayBuffer()),
  );
  const document = strFromU8(native["word/document.xml"]);
  const paragraph = [...document.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
    .map((match) => match[0])
    .find((xml) => xml.includes("\u200ea\u200e") && xml.includes(">ب<"))!;
  expect(paragraph).toBeTruthy();
  const first = paragraph.indexOf("<w:r>"),
    last = paragraph.lastIndexOf("</w:r>") + 6;
  const pair = paragraph.slice(first, last);
  const runs = [...pair.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map(
    (match) => match[0],
  );
  expect(runs).toHaveLength(2);
  expect(
    runs.every((run) => strToU8(run).length <= NATIVE_DOCX_RUN_OVERHEAD + 12),
  ).toBe(true);
  const repeat = 10000,
    count = 12;
  const model: RenderModel = {
    ...small,
    blocks: [
      ...small.blocks.slice(0, -1),
      ...Array.from({ length: count }, () => ({
        type: "paragraph" as const,
        text: "aب".repeat(repeat),
      })),
    ],
  };
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    chunks.push(bytes);
  });
  let expanded = 0;
  for (const [name, bytes] of Object.entries(native)) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    if (name !== "word/document.xml") {
      entry.push(bytes, true);
      continue;
    }
    const push = (text: string) => {
      const bytes = strToU8(text);
      expanded += bytes.length;
      entry.push(bytes);
    };
    const at = document.indexOf(paragraph);
    push(document.slice(0, at));
    for (let p = 0; p < count; p++) {
      push(paragraph.slice(0, first));
      for (let i = 0; i < repeat; i += 64)
        push(pair.repeat(Math.min(64, repeat - i)));
      push(paragraph.slice(last));
    }
    const suffix = strToU8(document.slice(at + paragraph.length));
    expanded += suffix.length;
    entry.push(suffix, true);
  }
  zip.end();
  const bytes = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  expect(expanded).toBeGreaterThan(40 * 1024 * 1024);
  expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
  let beats = 0;
  const timer = setInterval(() => beats++, 0);
  try {
    expect(await verifyExportDocxAsync(bytes, model)).toBe(true);
  } finally {
    clearInterval(timer);
  }
  expect(beats).toBeGreaterThan(5);
  // The same-size contiguous source has fewer native runs and cannot obtain the
  // larger archive allowance merely from an untrusted expanded-size declaration.
  const unrelated: RenderModel = {
    ...model,
    blocks: model.blocks.map((block) =>
      block.type === "paragraph"
        ? { ...block, text: "ب".repeat(block.text.length) }
        : block,
    ),
  };
  await expect(verifyExportDocxAsync(bytes, unrelated)).rejects.toThrow(
    "budget",
  );
  const controller = new AbortController();
  const reason = Error("synthetic canceled run expansion");
  setTimeout(() => controller.abort(reason), 0);
  await expect(
    verifyExportDocxAsync(bytes, model, controller.signal),
  ).rejects.toBe(reason);
}, 20000);
