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

const xmlText = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const complexField = (instruction: string, result = "") =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${xmlText(instruction)}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

it.each([
  'INCLUDETEXT "https://example.invalid/unapproved.docx"',
  'INCLUDEPICTURE "https://example.invalid/unapproved.png"',
  "DDEAUTO application command",
  'HYPERLINK "https://example.invalid/"',
  "REF unapprovedBookmark",
])(
  "rejects both complex and simple dynamic field %s even with empty cached output",
  (instruction) => {
    for (const field of [
      complexField(instruction),
      `<w:fldSimple w:instr="${xmlText(instruction)}"/>`,
    ])
      expect(() =>
        verifyExportDocx(
          mutate("word/document.xml", (xml) =>
            xml.replace("<w:sectPr>", `<w:p>${field}</w:p><w:sectPr>`),
          ),
          model,
        ),
      ).toThrow("fields");
  },
);
it("checks the combined field instruction across runs and rejects incomplete/unbound fields", () => {
  const split = complexField(
    'INCLUDETEXT "https://example.invalid/unapproved.docx"',
  ).replace("INCLUDETEXT", "INCLUDE</w:instrText></w:r><w:r><w:instrText>TEXT");
  for (const field of [
    split,
    "<w:r><w:instrText>PAGE</w:instrText></w:r>",
    complexField("PAGE").replace(
      /<w:r><w:fldChar w:fldCharType="end"\/><\/w:r>$/,
      "",
    ),
  ])
    expect(() =>
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace("<w:sectPr>", `<w:p>${field}</w:p><w:sectPr>`),
        ),
        model,
      ),
    ).toThrow();
});
it("rejects an internal altChunk that would import additional visible content", () => {
  const changed = {
    ...files,
    "word/unapproved.html": strToU8(
      "<html><body><p>Unapproved supplier claim</p></body></html>",
    ),
    "word/document.xml": strToU8(
      strFromU8(files["word/document.xml"]).replace(
        "<w:sectPr>",
        '<w:altChunk r:id="syntheticChunk"/><w:sectPr>',
      ),
    ),
    "word/_rels/document.xml.rels": strToU8(
      strFromU8(files["word/_rels/document.xml.rels"]).replace(
        "</Relationships>",
        '<Relationship Id="syntheticChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="unapproved.html"/></Relationships>',
      ),
    ),
    "[Content_Types].xml": strToU8(
      strFromU8(files["[Content_Types].xml"]).replace(
        "</Types>",
        '<Override PartName="/word/unapproved.html" ContentType="text/html"/></Types>',
      ),
    ),
  };
  expect(() => verifyExportDocx(zipSync(changed), model)).toThrow("external");
});
it.each(["vanish", "webHidden", "specVanish"])(
  "rejects active %s without rejecting an explicit disabled property",
  (property) => {
    for (const value of ["", ' w:val="true"', ' w:val="1"', ' w:val="on"'])
      expect(() =>
        verifyExportDocx(
          mutate("word/document.xml", (xml) =>
            xml.replace("<w:rPr>", `<w:rPr><w:${property}${value}/>`),
          ),
          model,
        ),
      ).toThrow("visible");
    for (const value of ["false", "0", "off"])
      expect(
        verifyExportDocx(
          mutate("word/document.xml", (xml) =>
            xml.replace("<w:rPr>", `<w:rPr><w:${property} w:val="${value}"/>`),
          ),
          model,
        ),
      ).toBe(true);
  },
);
it("rejects hidden properties inherited from a style and permits ordinary nonhidden style metadata", () => {
  expect(() =>
    verifyExportDocx(
      mutate("word/styles.xml", (xml) =>
        xml.replace("<w:rPr>", "<w:rPr><w:vanish/>"),
      ),
      model,
    ),
  ).toThrow("visible");
  expect(
    verifyExportDocx(
      mutate("word/styles.xml", (xml) =>
        xml.replace("<w:rPr>", "<w:rPr><w:semiHidden/>"),
      ),
      model,
    ),
  ).toBe(true);
});
it("keeps a blank table in its authorized body position even when flattened text is unchanged", () => {
  const table = { type: "table" as const, headers: [""], rows: [[""]] };
  const shaped: RenderModel = {
    ...model,
    blocks: [
      ...model.blocks.filter((b) => b.type !== "table"),
      table,
      { type: "heading", text: "Later section" },
      { type: "paragraph", text: "Later content" },
    ],
  };
  const cell = "<w:tc><w:p/></w:tc>",
    tableXml = `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr>${cell}</w:tr><w:tr>${cell}</w:tr></w:tbl>`;
  const tail =
    "<w:p><w:r><w:t>Later section</w:t></w:r></w:p><w:p><w:r><w:t>Later content</w:t></w:r></w:p>";
  const canonical = mutate("word/document.xml", (xml) =>
    xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, tableXml + tail),
  );
  expect(verifyExportDocx(canonical, shaped)).toBe(true);
  const moved = mutate("word/document.xml", (xml) =>
    xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, tail + tableXml),
  );
  expect(() => verifyExportDocx(moved, shaped)).toThrow("table structure");
});
it("preserves native and Word-updated local TOC fields, split instructions and simple PAGE footer", () => {
  const updated = mutate("word/document.xml", (xml) =>
    xml.replace(
      /<w:instrText xml:space="preserve">TOC[\s\S]*?<\/w:instrText>/,
      '<w:instrText xml:space="preserve">TO</w:instrText><w:instrText xml:space="preserve">C \\o &quot;1-2&quot; \\h \\z \\u \\* MERGEFORMAT</w:instrText>',
    ),
  );
  expect(verifyExportDocx(updated, model)).toBe(true);
  const footerName = Object.keys(files).find((name) =>
    /^word\/footer\d+\.xml$/.test(name),
  )!;
  const simpleFooter = `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${xmlText(model.footer)} · </w:t></w:r><w:fldSimple w:instr=" PAGE \\* MERGEFORMAT "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  expect(
    verifyExportDocx(
      zipSync({ ...files, [footerName]: strToU8(simpleFooter) }),
      model,
    ),
  ).toBe(true);
});
it("requires every TOC page/hyperlink reference to name an authorized heading bookmark", () => {
  expect(() =>
    verifyExportDocx(
      mutate("word/document.xml", (xml) =>
        xml.replace(/PAGEREF _Toc[^\s<]+/, "PAGEREF _TocMissing"),
      ),
      model,
    ),
  ).toThrow("bookmark");
  const hyperlink = mutate("word/document.xml", (xml) =>
    xml.replace(/PAGEREF (_Toc[^\s<]+) \\h/, "HYPERLINK \\l &quot;$1&quot;"),
  );
  expect(verifyExportDocx(hyperlink, model)).toBe(true);
  expect(() =>
    verifyExportDocx(
      mutate("word/document.xml", (xml) =>
        xml.replace(
          /PAGEREF _Toc[^\s<]+ \\h/,
          "HYPERLINK &quot;https://example.invalid&quot;",
        ),
      ),
      model,
    ),
  ).toThrow("fields");
});
it.each(["undefined", 'foreign:ignored xmlns:foreign="urn:unapproved"'])(
  "does not count authorized text or yellow properties inside ignored %s wrappers",
  (wrapper) => {
    const close = wrapper.split(" ")[0];
    for (const changed of [
      mutate("word/document.xml", (xml) =>
        xml.replace(/(<w:t[^>]*>[\s\S]*?<\/w:t>)/, `<${wrapper}>$1</${close}>`),
      ),
      mutate("word/document.xml", (xml) =>
        xml.replace(
          /(<w:highlight w:val="yellow"\/>)/,
          `<${wrapper}>$1</${close}>`,
        ),
      ),
    ])
      expect(() => verifyExportDocx(changed, model)).toThrow();
    const footerName = Object.keys(files).find((name) =>
      /^word\/footer\d+\.xml$/.test(name),
    )!;
    expect(() =>
      verifyExportDocx(
        mutate(footerName, (xml) =>
          xml.replace(
            /(<w:t[^>]*>[\s\S]*?<\/w:t>)/,
            `<${wrapper}>$1</${close}>`,
          ),
        ),
        model,
      ),
    ).toThrow();
    expect(() =>
      verifyExportDocx(
        mutate(footerName, (xml) =>
          xml.replace(/(<w:fldChar[^>]*\/>)/, `<${wrapper}>$1</${close}>`),
        ),
        model,
      ),
    ).toThrow();
  },
);
it("refuses unmodeled drawing/text-box carriers instead of treating their text as an approved paragraph", () => {
  for (const tag of ["w:drawing", "w:pict", "w:txbxContent"])
    expect(() =>
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace(
            "<w:sectPr>",
            `<w:p><w:r><${tag}/></w:r></w:p><w:sectPr>`,
          ),
        ),
        model,
      ),
    ).toThrow();
});
it("does not let a safe PAGE field replace authorized footer text when refreshed", () => {
  const footerName = Object.keys(files).find((name) =>
    /^word\/footer\d+\.xml$/.test(name),
  )!;
  const forged = `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${complexField("PAGE", `<w:r><w:t>${xmlText(model.footer)} · 7</w:t></w:r>`)}</w:p></w:ftr>`;
  expect(() =>
    verifyExportDocx(
      zipSync({ ...files, [footerName]: strToU8(forged) }),
      model,
    ),
  ).toThrow("fields");
});
it("requires the contents field to finish inside its own content control", () => {
  const changed = mutate("word/document.xml", (xml) => {
    const end = xml.indexOf("</w:sdt>"),
      first = xml.slice(0, end),
      last = first.lastIndexOf('<w:fldChar w:fldCharType="end"/>');
    expect(last).toBeGreaterThan(0);
    return (
      first.slice(0, last) +
      first.slice(last + '<w:fldChar w:fldCharType="end"/>'.length) +
      xml.slice(end)
    ).replace(
      "<w:sectPr>",
      '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:sectPr>',
    );
  });
  expect(() => verifyExportDocx(changed, model)).toThrow("fields");
});
it("does not count tab or break characters inside ignored wrappers as authorized word separation", () => {
  for (const tag of ["w:tab", "w:br", "w:cr"])
    expect(() =>
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace(
            "Configure ",
            `Configure</w:t><undefined><${tag}/></undefined><w:t>`,
          ),
        ),
        model,
      ),
    ).toThrow();
  for (const tag of ["w:tab", "w:br", "w:cr"])
    expect(
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace("Configure ", `Configure</w:t><${tag}/><w:t>`),
        ),
        model,
      ),
    ).toBe(true);
});
it("preserves native Word hyphen characters and refuses ignored wrappers around them", () => {
  for (const [tag, character] of [
    ["w:noBreakHyphen", "\u2011"],
    ["w:softHyphen", "\u00ad"],
  ]) {
    const shaped: RenderModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.type === "paragraph"
          ? {
              ...block,
              text: block.text.replace("Configure ", `Configure${character}`),
            }
          : block,
      ),
    };
    expect(
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace("Configure ", `Configure</w:t><${tag}/><w:t>`),
        ),
        shaped,
      ),
    ).toBe(true);
    expect(() =>
      verifyExportDocx(
        mutate("word/document.xml", (xml) =>
          xml.replace(
            "Configure ",
            `Configure</w:t><undefined><${tag}/></undefined><w:t>`,
          ),
        ),
        shaped,
      ),
    ).toThrow();
  }
});
it("does not admit a canonical blank table into the live TOC result where refresh could erase it", async () => {
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
  const shaped: RenderModel = {
    ...model,
    blocks: [
      ...model.blocks.slice(0, 2),
      { type: "table", headers: [""], rows: [[""]] },
      ...model.blocks.slice(2).filter((block) => block.type !== "table"),
    ],
  };
  const original = new Uint8Array(
    await (await renderDocx(shaped, fonts)).arrayBuffer(),
  );
  expect(verifyExportDocx(original, shaped)).toBe(true);
  const packageFiles = unzipSync(original),
    xml = strFromU8(packageFiles["word/document.xml"]),
    table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)![0];
  const stripped = xml.replace(table, ""),
    tocEnd = stripped.indexOf("</w:sdtContent>"),
    fieldEnd = stripped.lastIndexOf("<w:p>", tocEnd);
  expect(fieldEnd).toBeGreaterThan(0);
  const changed =
    stripped.slice(0, fieldEnd) + table + stripped.slice(fieldEnd);
  expect(() =>
    verifyExportDocx(
      zipSync({ ...packageFiles, "word/document.xml": strToU8(changed) }),
      shaped,
    ),
  ).toThrow("table structure");
});
