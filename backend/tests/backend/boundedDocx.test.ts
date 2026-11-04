// @vitest-environment node
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  Zip,
  ZipPassThrough,
} from "fflate";
import {
  verifyExportDocx,
  verifyExportDocxAsync,
  type RenderModel,
} from "../../supabase/functions/_shared/export";
import { readDocxArchiveChunks } from "../../supabase/functions/_shared/boundedDocxArchive";
import { BoundedXml } from "../../supabase/functions/_shared/boundedXml";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";
const model: RenderModel = {
  id: "synthetic-bounded",
  version: 1,
  mode: "draft",
  volume: "combined",
  language: "ar",
  created_at: "2026-11-04T00:00:00Z",
  footer: "Tenderdesk · Draft",
  placeholder_version: 2,
  blocks: [
    { type: "title", text: "عرض <مراجعة> & تشغيل" },
    { type: "toc", text: "المحتويات" },
    { type: "heading", text: "المنهجية" },
    {
      type: "paragraph",
      text: "Configure A&B < C, preserve 0 and execute the acceptance checks.",
    },
    {
      type: "placeholder",
      text: "[مطلوب: دليل الشهادة]",
      gap_id: "certificate",
    },
    {
      type: "table",
      headers: ["Method", "Evidence"],
      rows: [["Verify all access roles", "[INPUT REQUIRED: confirmation]"]],
    },
  ],
};
let bytes: Uint8Array, files: Record<string, Uint8Array>;
beforeAll(async () => {
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
  bytes = new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
  files = unzipSync(bytes);
});
const mutate = (name: string, change: (xml: string) => string) =>
  zipSync({ ...files, [name]: strToU8(change(strFromU8(files[name]))) });
function duplicateArchive() {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, value] of [
    ...Object.entries(files),
    ["word/document.xml", files["word/document.xml"]] as [string, Uint8Array],
  ]) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(value, true);
  }
  zip.end();
  const result = new Uint8Array(chunks.reduce((size, c) => size + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
it("preserves Arabic/English escaped text, native TOC/fonts, zero and exact yellow gaps", () => {
  expect(verifyExportDocx(bytes, model)).toBe(true);
});
it.each([
  ["unclosed document", (xml: string) => xml.replace("</w:document>", "")],
  ["mismatched close", (xml: string) => xml.replace("</w:body>", "</w:wrong>")],
  [
    "duplicate attribute",
    (xml: string) =>
      xml.replace(
        '<w:t xml:space="preserve">',
        '<w:t xml:space="preserve" xml:space="preserve">',
      ),
  ],
  [
    "unknown entity",
    (xml: string) => xml.replace("Configure", "&unregistered;"),
  ],
  [
    "DTD",
    (xml: string) =>
      xml.replace(
        "<w:document",
        '<!DOCTYPE document [<!ENTITY injected "hidden">]><w:document',
      ),
  ],
  ["illegal scalar", (xml: string) => xml.replace("Configure", "&#xD800;")],
  ["extra root", (xml: string) => xml + "<extra/>"],
])("rejects malformed XML: %s", (_label, change) => {
  expect(() =>
    verifyExportDocx(mutate("word/document.xml", change), model),
  ).toThrow();
});
it("rejects truncated archives, duplicate parts and changed local names", () => {
  expect(() =>
    verifyExportDocx(bytes.subarray(0, bytes.length - 10), model),
  ).toThrow();
  expect(() => verifyExportDocx(duplicateArchive(), model)).toThrow();
  const altered = bytes.slice();
  altered[30] ^= 1;
  expect(() => verifyExportDocx(altered, model)).toThrow();
});
it("checks actual expanded CRC, not only matching directory/header claims", () => {
  const altered = bytes.slice(),
    view = new DataView(altered.buffer);
  for (let pos = 0; pos + 46 < altered.length; pos++) {
    if (view.getUint32(pos, true) !== 0x02014b50) continue;
    const name = strFromU8(
      altered.subarray(pos + 46, pos + 46 + view.getUint16(pos + 28, true)),
    );
    if (name !== "word/document.xml") continue;
    const wrong = view.getUint32(pos + 16, true) ^ 1,
      local = view.getUint32(pos + 42, true);
    view.setUint32(pos + 16, wrong, true);
    view.setUint32(local + 14, wrong, true);
    break;
  }
  expect(() => verifyExportDocx(altered, model)).toThrow("archive");
});
it("rejects archive-declared expansion above authorized content before inflation", () => {
  const altered = bytes.slice(),
    view = new DataView(altered.buffer);
  for (let pos = 0; pos + 46 < altered.length; pos++) {
    if (view.getUint32(pos, true) !== 0x02014b50) continue;
    const name = strFromU8(
      altered.subarray(pos + 46, pos + 46 + view.getUint16(pos + 28, true)),
    );
    if (name === "word/document.xml") {
      view.setUint32(pos + 24, 0x7fffffff, true);
      break;
    }
  }
  expect(() => verifyExportDocx(altered, model)).toThrow("budget");
});
it("rejects missing font targets, external relationships and personal metadata", () => {
  const missing = { ...files };
  delete missing[Object.keys(missing).find((key) => /\.odttf$/.test(key))!];
  expect(() => verifyExportDocx(zipSync(missing), model)).toThrow();
  expect(() =>
    verifyExportDocx(
      mutate("word/_rels/document.xml.rels", (xml) =>
        xml.replace("<Relationship ", '<Relationship TargetMode="External" '),
      ),
      model,
    ),
  ).toThrow("external");
  expect(() =>
    verifyExportDocx(
      mutate("docProps/core.xml", (xml) =>
        xml.replace("<dc:creator>Tenderdesk", "<dc:creator>Private Author"),
      ),
      model,
    ),
  ).toThrow("personal");
});
it("retains content/TOC/field/highlight failures independently of bounded parsing", () => {
  expect(() =>
    verifyExportDocx(
      mutate("word/document.xml", (xml) => xml.replace("Configure", "Invent")),
      model,
    ),
  ).toThrow("content");
  expect(() =>
    verifyExportDocx(
      mutate("word/document.xml", (xml) =>
        xml.replace(/(<w:sdt>[\s\S]*?<w:t[^>]*>)[^<]+/, "$1Unapproved TOC"),
      ),
      model,
    ),
  ).toThrow("contents");
  expect(() =>
    verifyExportDocx(
      mutate("word/settings.xml", (xml) =>
        xml.replace(/<w:updateFields[^>]*\/>/, ""),
      ),
      model,
    ),
  ).toThrow("live contents");
  expect(() =>
    verifyExportDocx(
      mutate("word/document.xml", (xml) =>
        xml.replace(/<w:highlight w:val="yellow"\/>/g, ""),
      ),
      model,
    ),
  ).toThrow("yellow");
});
it("never discards visible text merely because it starts with a TOC token", () => {
  const changed = mutate("word/document.xml", (xml) =>
    xml.replace("</w:t>", " TOC unapproved claim</w:t>"),
  );
  expect(() => verifyExportDocx(changed, model)).toThrow("content");
});
it("compares alternate and default Word namespace text instead of ignoring visible content", () => {
  for (const fragment of [
    '<x:r xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:t>unapproved claim</x:t></x:r>',
    '<r xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><t>unapproved claim</t></r>',
  ])
    expect(() =>
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace("</w:p>", fragment + "</w:p>"),
        ),
        model,
      ),
    ).toThrow("content");
  const renamed = mutate("word/document.xml", (xml) =>
    xml.replace(/xmlns:w=/g, "xmlns:x=").replace(/(<\/?|\s)w:/g, "$1x:"),
  );
  expect(verifyExportDocx(renamed, model)).toBe(true);
});
it("streams entities and Unicode at every split without dropping or duplicating text", () => {
  const xml =
    '<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:t>A&amp;B &#x1F600; عربي &lt;x&gt;</w:t></root>';
  for (let cut = 1; cut < xml.length; cut++) {
    let text = "";
    const parser = new BoundedXml({
      start() {},
      end() {},
      text(value) {
        text += value;
      },
    });
    parser.push(xml.slice(0, cut), false);
    parser.push(xml.slice(cut), true);
    expect(text).toBe("A&B 😀 عربي <x>");
  }
});

it.each(["false", "0", "off"])(
  "requires enabled field updates, not %s",
  (value) => {
    expect(() =>
      verifyExportDocx(
        mutate("word/settings.xml", (xml) =>
          xml.replace(
            /<w:updateFields[^>]*\/>/,
            `<w:updateFields w:val="${value}"/>`,
          ),
        ),
        model,
      ),
    ).toThrow("enabled");
  },
);
it("rejects malformed qualified names, reserved namespace rebinding and duplicate expanded attributes", () => {
  for (const xml of [
    '<root xmlns:w="urn:word"><w:t:extra/></root>',
    "<root></ root>",
    "<root><xmlns:p/></root>",
    '<root xmlns:xml="urn:wrong"/>',
    '<root xmlns:x="http://www.w3.org/XML/1998/namespace"/>',
    '<root xmlns:x="urn:same" xmlns:y="urn:same" x:value="1" y:value="2"/>',
  ]) {
    expect(() =>
      new BoundedXml({ start() {}, end() {}, text() {} }).push(xml, true),
    ).toThrow();
  }
});
it("rejects aliased personal author metadata", () => {
  expect(() =>
    verifyExportDocx(
      mutate("docProps/core.xml", (xml) =>
        xml
          .replace(/xmlns:dc=/g, "xmlns:person=")
          .replace(/<\/?dc:/g, (tag) => tag.replace("dc:", "person:"))
          .replace(
            "<person:creator>Tenderdesk",
            "<person:creator>Private Author",
          ),
      ),
      model,
    ),
  ).toThrow("personal");
});
it("bounds inflation callbacks even for a highly compressible valid stream", () => {
  const zipped = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      "<doc>" + " ".repeat(8 * 1024 * 1024) + "</doc>",
    ),
  });
  let max = 0,
    total = 0;
  const chunks = readDocxArchiveChunks(
    zipped,
    40 * 1024 * 1024,
    () => (chunk) => {
      max = Math.max(max, chunk.length);
      total += chunk.length;
    },
  );
  for (;;) {
    if (chunks.next().done) break;
  }
  expect(total).toBeGreaterThan(8 * 1024 * 1024);
  expect(max).toBeGreaterThan(32768);
  expect(max).toBeLessThanOrEqual(1024 * 1024);
});
it("yields concurrent verification to the event loop and cancels without a partial pass", async () => {
  const text = "Configure approvals and preserve acceptance evidence.";
  const count = 12000;
  const largeModel: RenderModel = {
    ...model,
    blocks: [
      ...model.blocks,
      ...Array.from({ length: count }, () => ({
        type: "paragraph" as const,
        text,
      })),
    ],
  };
  const large = mutate("word/document.xml", (xml) =>
    xml.replace(
      "<w:sectPr>",
      `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`.repeat(count) + "<w:sectPr>",
    ),
  );
  let beats = 0;
  const timer = setInterval(() => beats++, 1);
  try {
    expect(
      await Promise.all([
        verifyExportDocxAsync(large, largeModel),
        verifyExportDocxAsync(large, largeModel),
      ]),
    ).toEqual([true, true]);
    expect(beats).toBeGreaterThan(2);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 0);
    await expect(
      verifyExportDocxAsync(large, largeModel, abort.signal),
    ).rejects.toThrow();
    expect(await verifyExportDocxAsync(bytes, model)).toBe(true);
  } finally {
    clearInterval(timer);
  }
});
it("preserves every blank row/cell and rejects shifted content with unchanged flattened text", () => {
  const table = {
    type: "table" as const,
    headers: ["A", "B", "C"],
    rows: [
      ["first", "", "last"],
      ["", "", ""],
    ],
  };
  const shaped: RenderModel = {
    ...model,
    blocks: model.blocks.map((b) => (b.type === "table" ? table : b)),
  };
  const cell = (text: string) =>
    `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const row = (values: string[]) => `<w:tr>${values.map(cell).join("")}</w:tr>`;
  const grid =
    '<w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid>';
  const canonical = `<w:tbl>${grid}${[table.headers, ...table.rows].map(row).join("")}</w:tbl>`;
  const packageWith = (xml: string) =>
    mutate("word/document.xml", (document) =>
      document.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, xml),
    );
  expect(verifyExportDocx(packageWith(canonical), shaped)).toBe(true);
  expect(() =>
    verifyExportDocx(
      packageWith(canonical.replace(row(["", "", ""]), "")),
      shaped,
    ),
  ).toThrow("table");
  expect(() =>
    verifyExportDocx(
      packageWith(
        canonical.replace(row(table.rows[0]), row(["first", "last"])),
      ),
      shaped,
    ),
  ).toThrow("table");
  expect(() =>
    verifyExportDocx(
      packageWith(
        canonical.replace(row(table.rows[0]), row(["first", "last", ""])),
      ),
      shaped,
    ),
  ).toThrow("table cell");
  expect(() =>
    verifyExportDocx(
      packageWith(canonical.replace('<w:gridCol w:w="1000"/>', "")),
      shaped,
    ),
  ).toThrow("grid");
});
it("accepts honest blank padding for an authorized ragged table while retaining overflow cells", () => {
  const table = {
    type: "table" as const,
    headers: ["Method"],
    rows: [["first", "", "last"], [""]],
  };
  const shaped: RenderModel = {
    ...model,
    blocks: model.blocks.map((b) => (b.type === "table" ? table : b)),
  };
  const cell = (text: string) =>
    `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const canonical =
    "<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>" +
    [table.headers, ...table.rows]
      .map(
        (row) =>
          "<w:tr>" +
          Array.from({ length: 3 }, (_, i) => cell(row[i] ?? "")).join("") +
          "</w:tr>",
      )
      .join("") +
    "</w:tbl>";
  const changed = mutate("word/document.xml", (xml) =>
    xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, canonical),
  );
  expect(verifyExportDocx(changed, shaped)).toBe(true);
});
