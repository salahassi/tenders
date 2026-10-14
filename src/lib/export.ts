import type { Opportunity, Proposal } from "../types";
import { calculateFinance } from "./finance";

export async function exportProposal(
  proposal: Proposal,
  opportunity: Opportunity,
  volume: "technical" | "financial",
  isFinal: boolean,
  companyName: string,
) {
  const {
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
  } = await import("docx");
  const rtl = opportunity.language === "ar";
  const paragraph = (text: string, heading?: typeof HeadingLevel.HEADING_1) =>
    new Paragraph({
      bidirectional: rtl,
      heading,
      spacing: { after: 160 },
      children: [
        new TextRun({
          text,
          rightToLeft: rtl,
          highlight: /\[INPUT REQUIRED/i.test(text) ? "yellow" : undefined,
        }),
      ],
    });
  const table = (rows: string[][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(
        (row, index) =>
          new TableRow({
            tableHeader: index === 0,
            children: row.map(
              (text) =>
                new TableCell({
                  children: [
                    new Paragraph({
                      bidirectional: rtl,
                      children: [new TextRun({ text, bold: index === 0 })],
                    }),
                  ],
                }),
            ),
          }),
      ),
    });
  const total = calculateFinance(proposal);
  const children: (
    | InstanceType<typeof Paragraph>
    | InstanceType<typeof Table>
    | InstanceType<typeof TableOfContents>
  )[] = [
    new Paragraph({ text: companyName, spacing: { after: 200 } }),
    new Paragraph({
      text: opportunity.title,
      heading: HeadingLevel.TITLE,
      bidirectional: rtl,
    }),
    paragraph(
      `${volume === "technical" ? "Technical" : "Financial"} proposal · ${isFinal ? "Approved content" : "DRAFT"} · Version ${proposal.version}`,
    ),
    paragraph(
      `Prepared for ${opportunity.buyer} | Reference: ${opportunity.reference}`,
    ),
    paragraph(
      `Generated ${new Date().toLocaleDateString("en-US")}. ${isFinal ? "Approved source content; review this exported file before submission." : "Working draft. Not approved for submission."}`,
    ),
    new Paragraph({
      text: "Contents",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
    }),
    new TableOfContents("Contents", {
      hyperlink: true,
      headingStyleRange: "1-2",
    }),
    paragraph(
      "Before submission: open in Word, update the entire table of contents and all fields, save, and visually review every page.",
    ),
  ];
  if (volume === "technical") {
    for (const section of proposal.sections.filter(
      (s) =>
        !/commercial|financial|pricing|payment|offer validity|تجاري|الدفع|صلاحية/i.test(
          s.title,
        ),
    )) {
      children.push(
        new Paragraph({
          text: section.title,
          heading: HeadingLevel.HEADING_1,
          bidirectional: rtl,
        }),
      );
      section.body
        .split("\n")
        .forEach((line) => children.push(paragraph(line)));
    }
    children.push(paragraph("Compliance matrix", HeadingLevel.HEADING_1));
    children.push(
      table([
        ["Requirement", "Source", "Response", "Status"],
        ...opportunity.requirements.map((r) => [
          r.text,
          r.source,
          r.response || "[INPUT REQUIRED: response]",
          r.status.replaceAll("_", " "),
        ]),
      ]),
    );
  } else {
    children.push(paragraph("Pricing basis", HeadingLevel.HEADING_1));
    children.push(
      paragraph(
        "Currency: SAR. Rates, quantities, tax treatment, and inclusions require owner confirmation. Optional items are excluded from the base total.",
      ),
    );
    children.push(
      table([
        ["Description", "Quantity", "Unit", "Unit rate (SAR)", "Treatment"],
        ...proposal.lines.map((l) => [
          l.description,
          l.quantity,
          l.unit,
          l.rate,
          l.optional ? "Optional" : "Base",
        ]),
      ]),
    );
    children.push(paragraph("Commercial summary", HeadingLevel.HEADING_1));
    children.push(
      table([
        ["Item", "SAR"],
        ["Direct cost", String(total.subtotal)],
        ["Contingency", String(total.contingency)],
        ["Net price", String(total.net)],
        ["Tax", String(total.tax)],
        ["Gross total", String(total.total)],
        ["Optional direct cost", String(total.optionalTotal)],
      ]),
    );
    children.push(
      paragraph(
        `Method: ${proposal.pricingMode}. Percentage: ${proposal.percentage}%. Contingency: ${proposal.contingency}%. Tax input: ${proposal.tax}%.`,
      ),
    );
    children.push(
      paragraph("Commercial terms and assumptions", HeadingLevel.HEADING_1),
    );
    const commercialSections = proposal.sections.filter((s) =>
      /commercial|payment|validity|financial|تجاري|الدفع|صلاحية/i.test(s.title),
    );
    if (commercialSections.length)
      commercialSections.forEach((s) => {
        children.push(paragraph(s.title, HeadingLevel.HEADING_1));
        s.body.split("\n").forEach((line) => children.push(paragraph(line)));
      });
    else
      children.push(
        paragraph(
          "[INPUT REQUIRED: Confirm payment schedule, offer validity, recurring periods, and commercial exclusions before external use.]",
        ),
      );
  }
  const doc = new Document({
    creator: companyName,
    title: `${opportunity.title} — ${volume} proposal`,
    description: `${isFinal ? "Approved" : "Draft"} version ${proposal.version}`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: rtl ? "Arial" : "Calibri", size: 22 },
          paragraph: { spacing: { after: 160 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1100, bottom: 1100, left: 1100, right: 1100 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `${isFinal ? "Approved" : "Draft"} · v${proposal.version} · `,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT] }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${opportunity.reference.replace(/[^\w-]/g, "_")}_${volume}_v${proposal.version}_${isFinal ? "approved" : "draft"}.docx`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
