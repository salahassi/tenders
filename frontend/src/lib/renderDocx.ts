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
  PageNumber,
  AlignmentType,
  TableLayoutType,
  BorderStyle,
  VerticalAlign,
} from "docx";
export type ExportBlock =
  | { type: "paragraph" | "bullet" | "heading" | "title"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "toc"; text: string };
export interface RenderModel {
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
  function runs(text: string, bold = false, runSize = size) {
    return text
      .split(/([A-Za-z0-9][A-Za-z0-9 .,:%_/@()+\-]*)/g)
      .filter(Boolean)
      .map(
        (t) =>
          new TextRun({
            text: t,
            bold,
            font,
            size: runSize,
            rightToLeft: /[\u0600-\u06ff]/.test(t),
            highlight: /\[INPUT REQUIRED/i.test(text) ? "yellow" : undefined,
          }),
      );
  }
  const para = (
    text: string,
    heading?: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.TITLE,
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
      ),
      bidirectional: rtl,
      heading,
      spacing: { after: heading ? 180 : 120, line: rtl ? 360 : 300 },
      keepNext: !!heading,
      widowControl: true,
    });
  const children: (Paragraph | Table | TableOfContents)[] = [];
  let afterToc = false;
  for (const b of model.blocks) {
    if (b.type === "toc") {
      children.push(new Paragraph({ children: [], pageBreakBefore: true }));
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
      children.push(new Paragraph({ children: [], pageBreakBefore: true }));
      afterToc = false;
    }
    if (b.type === "table") {
      const weights = b.headers.map((header,i) => Math.min(45, Math.max(8, header.length, ...b.rows.map(row => Math.min((row[i]||"").length, i===0?45:28)))));
      const sum = weights.reduce((a,b)=>a+b,0), widths=weights.map(x=>Math.floor(9360*x/sum));
      widths[widths.length-1]+=9360-widths.reduce((a,b)=>a+b,0);
      const border={style:BorderStyle.SINGLE,size:4,color:"D9D9D9"};
      children.push(
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          visuallyRightToLeft: rtl,
          columnWidths: widths,
          borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},
          rows: [b.headers, ...b.rows].map(
            (row, index) =>
              new TableRow({
                tableHeader: index === 0,
                cantSplit: true,
                children: b.headers.map(
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
                          children: runs(row[i] || "", index === 0),
                          widowControl: true,
                        }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
      children.push(para(""));
    } else if (b.type === "bullet")
      children.push(
        new Paragraph({
          children: runs(b.text),
          bullet: { level: 0 },
          bidirectional: rtl,
          spacing: { after: 120 },
          widowControl: true,
        }),
      );
    else
      children.push(
        para(
          b.text,
          b.type === "heading"
            ? HeadingLevel.HEADING_1
            : b.type === "title"
              ? HeadingLevel.TITLE
              : undefined,
        ),
      );
  }
  const title = model.blocks.find((b) => b.type === "title");
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
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font,
                    size: 20,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}
