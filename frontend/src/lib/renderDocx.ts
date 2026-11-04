import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  TableOfContents,
  Table,
  TableRow,
  TableCell,
  WidthType,
  Footer,
  ImportedXmlComponent,
  AlignmentType,
  TableLayoutType,
  BorderStyle,
  VerticalAlign,
} from "docx";
import {
  nativeTableXml,
  packStreamedTables,
  type StreamedTable,
} from "./docxTableStream.ts";
import { docxRunSegments } from "../../../backend/supabase/functions/_shared/docxRunSegments.ts";
export type ExportBlock =
  | { type: "paragraph" | "bullet" | "heading" | "title"; text: string }
  | { type: "placeholder"; text: string; gap_id: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "toc"; text: string };
export interface RenderModel {
  /** New delivery snapshots use typed placeholders; legacy exports keep their pinned behavior. */
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
export type FontData = Record<
  "Amiri-Regular" | "Amiri-Bold" | "Carlito-Regular" | "Carlito-Bold",
  Uint8Array
>;
export async function renderDocx(
  model: RenderModel,
  fonts: FontData,
): Promise<Blob> {
  const rtl = model.language === "ar",
    font = { ascii: "Carlito", hAnsi: "Carlito", cs: "Amiri" },
    size = rtl ? 29 : 23;
  const highlighted = (text: string, placeholder: boolean) =>
    placeholder ||
    (model.placeholder_version === 2 &&
      /\[INPUT REQUIRED|\[مطلوب|\[مدخل(?:ات)? مطلوب/iu.test(text)) ||
    (!model.placeholder_version && /\[INPUT REQUIRED/i.test(text));
  const runOptions = (
    text: string,
    bold: boolean,
    runSize: number,
    highlight: boolean,
  ) => ({
    text: rtl && /^[A-Za-z0-9]/.test(text) ? "\u200e" + text + "\u200e" : text,
    bold,
    font,
    size:
      rtl && runSize === size && !/[\u0600-\u06ff]/.test(text) ? 23 : runSize,
    rightToLeft: /[\u0600-\u06ff]/.test(text),
    highlight: highlight ? ("yellow" as const) : undefined,
  });
  function runs(
    text: string,
    bold = false,
    runSize = size,
    placeholder = false,
  ) {
    const highlight = highlighted(text, placeholder);
    return Array.from(
      docxRunSegments(text),
      (part) => new TextRun(runOptions(part, bold, runSize, highlight)),
    );
  }
  const encoded = new TextEncoder(),
    runCache = new Map<string, Uint8Array>();
  function* textXml(
    text: string,
    bold = false,
    runSize = size,
    placeholder = false,
  ): Iterable<Uint8Array> {
    const highlight = highlighted(text, placeholder);
    for (const part of docxRunSegments(text)) {
      // Bound the optimization, never the content. Long or unique runs are
      // serialized individually; repeated short runs retain at most 64 entries.
      const key =
        part.length <= 256
          ? JSON.stringify([part, bold, runSize, highlight])
          : undefined;
      let bytes = key ? runCache.get(key) : undefined;
      if (!bytes) {
        bytes = encoded.encode(
          nativeTableXml(
            new TextRun(runOptions(part, bold, runSize, highlight)).prepForXml({
              file: doc,
              viewWrapper: doc.Document,
              stack: [],
            })!,
          ),
        );
        if (key && runCache.size < 64) runCache.set(key, bytes);
      }
      yield bytes;
    }
  }
  const para = (
    text: string,
    heading?: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.TITLE,
    keepNext = false,
    placeholder = false,
  ) =>
    new Paragraph({
      children: runs(
        text,
        !!heading,
        heading === HeadingLevel.TITLE
          ? rtl
            ? 44
            : 40
          : heading
            ? rtl
              ? 36
              : 30
            : size,
        placeholder,
      ),
      bidirectional: rtl,
      heading,
      spacing: { after: heading ? 180 : 120, line: rtl ? 360 : 300 },
      keepNext: !!heading || keepNext,
      widowControl: true,
    });
  const children: (Paragraph | Table | TableOfContents)[] = [];
  const tables: StreamedTable[] = [];
  let currentGroup: Array<() => Iterable<string | Uint8Array>> | undefined;
  const tableNonce = crypto.randomUUID();
  function appendStream(xml: () => Iterable<string | Uint8Array>) {
    if (!currentGroup) {
      const group: Array<() => Iterable<string | Uint8Array>> = [];
      const marker = `TENDERDESK_TABLE_${tableNonce}_${tables.length}`;
      tables.push({
        marker,
        *xml() {
          for (const block of group) yield* block();
        },
      });
      children.push(new Paragraph({ children: [new TextRun(marker)] }));
      currentGroup = group;
    }
    currentGroup.push(xml);
  }
  function appendParagraph(
    buildEmpty: () => Paragraph,
    text = "",
    placeholder = false,
  ) {
    appendStream(function* () {
      const wrapper = nativeTableXml(
        buildEmpty().prepForXml({
          file: doc,
          viewWrapper: doc.Document,
          stack: [],
        })!,
      );
      if (!wrapper.endsWith("</w:p>"))
        throw Error("Native paragraph template is invalid");
      yield wrapper.slice(0, -6);
      yield* textXml(text, false, size, placeholder);
      yield "</w:p>";
    });
  }
  let afterToc = false;
  for (const [blockIndex, b] of model.blocks.entries()) {
    if (b.type === "toc") {
      currentGroup = undefined;
      children.push(new Paragraph({ children: [], pageBreakBefore: true }));
      children.push(
        new Paragraph({
          children: runs(b.text, true, rtl ? 36 : 30),
          bidirectional: rtl,
          spacing: { after: 240 },
          keepNext: true,
        }),
      );
      children.push(
        new TableOfContents(b.text, {
          hyperlink: true,
          headingStyleRange: "1-2",
        }),
      );
      afterToc = true;
      continue;
    }
    if (afterToc) {
      currentGroup = undefined;
      children.push(new Paragraph({ children: [], pageBreakBefore: true }));
      afterToc = false;
    }
    if (b.type === "table") {
      const rowCount = b.rows.length;
      const columnCount = Math.max(
        b.headers.length,
        ...b.rows.map((row) => row.length),
      );
      const headers = Array.from(
        { length: columnCount },
        (_, index) => b.headers[index] || "",
      );
      const weights = headers.map((header, i) =>
        Math.min(
          45,
          Math.max(
            14,
            header.length,
            ...b.rows.map((row) =>
              Math.min((row[i] || "").length, i === 0 ? 45 : 28),
            ),
          ),
        ),
      );
      const sum = weights.reduce((a, b) => a + b, 0),
        widths = weights.map((x) => Math.floor((9360 * x) / sum));
      widths[widths.length - 1] += 9360 - widths.reduce((a, b) => a + b, 0);
      const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
      const tableOptions = {
        width: { size: 9360, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        visuallyRightToLeft: rtl,
        columnWidths: widths,
        borders: {
          top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border,
        },
      };
      const buildEmptyRow = (index: number) =>
        new TableRow({
          tableHeader: index === 0,
          cantSplit: true,
          children: headers.map(
            (_, i) =>
              new TableCell({
                width: { size: widths[i], type: WidthType.DXA },
                verticalAlign: VerticalAlign.CENTER,
                margins: { top: 100, bottom: 100, left: 100, right: 100 },
                shading: index === 0 ? { fill: "DCE8F2" } : undefined,
                children: [
                  new Paragraph({
                    bidirectional: rtl,
                    spacing: { after: 60, line: rtl ? 340 : 280 },
                    children: [],
                    widowControl: true,
                    keepNext:
                      headers.length === 2 &&
                      b.rows.length <= 7 &&
                      index < b.rows.length,
                  }),
                ],
              }),
          ),
        });
      appendStream(function* () {
        const context = { file: doc, viewWrapper: doc.Document, stack: [] };
        const empty = nativeTableXml(
          new Table({ ...tableOptions, rows: [] }).prepForXml(context)!,
        );
        if (!empty.endsWith("</w:tbl>"))
          throw Error("Native table template is invalid");
        yield empty.slice(0, -8);
        const templates = new Map<string, string[]>();
        function* rowXml(
          row: string[],
          index: number,
        ): Iterable<string | Uint8Array> {
          const kind = `${index === 0}:${headers.length === 2 && rowCount <= 7 && index < rowCount}`;
          let pieces = templates.get(kind);
          if (!pieces) {
            pieces = nativeTableXml(
              buildEmptyRow(index).prepForXml(context)!,
            ).split("</w:p>");
            if (pieces.length !== headers.length + 1)
              throw Error("Native row template is invalid");
            templates.set(kind, pieces);
          }
          for (let column = 0; column < headers.length; column++) {
            yield pieces[column];
            yield* textXml(row[column] || "", index === 0);
            yield "</w:p>";
          }
          yield pieces[headers.length];
        }
        yield* rowXml(headers, 0);
        let previousKey: string | undefined,
          previousXml: Uint8Array | undefined;
        for (let index = 0; index < b.rows.length; index++) {
          // Dense sparse tables repeat the same native row. Reuse exactly its
          // XML, still emitting every row/cell; keep-next is the only data-row
          // property that depends on its position in this renderer.
          const key = JSON.stringify([
            b.rows[index],
            headers.length === 2 &&
              b.rows.length <= 7 &&
              index + 1 < b.rows.length,
          ]);
          if (
            b.rows[index].reduce((total, text) => total + text.length, 0) > 4096
          ) {
            previousKey = undefined;
            previousXml = undefined;
            yield* rowXml(b.rows[index], index + 1);
            continue;
          }
          if (key !== previousKey) {
            const decoder = new TextDecoder();
            previousXml = encoded.encode(
              Array.from(rowXml(b.rows[index], index + 1), (part) =>
                typeof part === "string" ? part : decoder.decode(part),
              ).join(""),
            );
            previousKey = key;
          }
          yield previousXml!;
        }
        yield "</w:tbl>";
      });
      appendParagraph(() => para(""));
    } else if (b.type === "bullet")
      appendParagraph(
        () =>
          new Paragraph({
            children: [],
            bullet: { level: 0 },
            bidirectional: rtl,
            spacing: { after: 120 },
            widowControl: true,
          }),
        b.text,
      );
    else {
      const build = () =>
        para(
          b.text,
          b.type === "heading"
            ? HeadingLevel.HEADING_1
            : b.type === "title"
              ? HeadingLevel.TITLE
              : undefined,
          model.blocks[blockIndex + 1]?.type === "table",
          b.type === "placeholder",
        );
      if (b.type === "heading" || b.type === "title") {
        currentGroup = undefined;
        children.push(build());
      } else
        appendParagraph(
          () =>
            para(
              "",
              undefined,
              model.blocks[blockIndex + 1]?.type === "table",
              b.type === "placeholder",
            ),
          b.text,
          b.type === "placeholder",
        );
    }
  }
  const title = model.blocks.find((b) => b.type === "title");
  const pageInstruction = new ImportedXmlComponent("w:instrText", {
    "xml:space": "preserve",
  });
  pageInstruction.push("PAGE");
  const doc = new Document({
    creator: "Tenderdesk",
    lastModifiedBy: "Tenderdesk",
    title: title && "text" in title ? title.text : "Proposal",
    subject: "",
    description: "",
    keywords: "",
    revision: model.version,
    features: { updateFields: true },
    fonts: [
      {
        name: "Amiri",
        data: fonts["Amiri-Regular"] as any,
        bold: fonts["Amiri-Bold"] as any,
      },
      {
        name: "Carlito",
        data: fonts["Carlito-Regular"] as any,
        bold: fonts["Carlito-Bold"] as any,
      },
    ],
    styles: {
      paragraphStyles: [1, 2].map((level) => ({
        id: `TOC${level}`,
        name: `toc ${level}`,
        basedOn: "Normal",
        run: { font, size },
        paragraph: {
          bidirectional: rtl,
          alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
          spacing: { after: 140 },
        } as any,
      })),
      default: {
        document: {
          run: { font, size, color: "000000" },
          paragraph: { spacing: { after: 120 } },
        },
        title: {
          run: { font, size: rtl ? 44 : 40, color: "000000", bold: true },
          paragraph: { spacing: { before: 220, after: 240 } },
        },
        heading1: {
          run: { font, size: rtl ? 36 : 30, color: "000000", bold: true },
          paragraph: { spacing: { before: 260, after: 160 }, keepNext: true },
        },
        heading2: {
          run: { font, size: rtl ? 32 : 26, color: "000000", bold: true },
          paragraph: { keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1200, bottom: 1200, left: 1273, right: 1273 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                bidirectional: rtl,
                alignment: AlignmentType.CENTER,
                children: [
                  ...runs(model.footer),
                  new TextRun({
                    text: model.footer ? " · " : "",
                    font,
                    size: 20,
                  }),
                  // Keep each complex-field token in its own run. A single
                  // run containing begin/instruction/separate/end lets some
                  // office importers inherit the last body placeholder's
                  // formatting for the calculated PAGE result.
                  ...[
                    new ImportedXmlComponent("w:fldChar", {
                      "w:fldCharType": "begin",
                    }),
                    pageInstruction,
                    new ImportedXmlComponent("w:fldChar", {
                      "w:fldCharType": "separate",
                    }),
                    new ImportedXmlComponent("w:fldChar", {
                      "w:fldCharType": "end",
                    }),
                  ].map(
                    (field) =>
                      new TextRun({
                        children: [field],
                        font,
                        size: 20,
                        rightToLeft: false,
                        highlight: "none",
                      }),
                  ),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  // Only the native default bullet is supported here. Register its empty
  // exemplar before packing; all actual text/runs remain lazy and unchanged.
  if (model.blocks.some((block) => block.type === "bullet"))
    new Paragraph({ children: [], bullet: { level: 0 } }).prepForXml({
      file: doc,
      viewWrapper: doc.Document,
      stack: [],
    });
  return packStreamedTables(await Packer.toBlob(doc), tables);
}
