import type { Opportunity, Proposal } from "../types";
import { calculateFinance } from "./finance";

export function proposalFileName(proposal: Proposal, opportunity: Opportunity) {
  const reference = opportunity.reference.replace(/[^\w-]/g, "_") || "proposal";
  return `${reference}_proposal_v${proposal.version}.docx`;
}

/** Produces one editable document containing exactly the user's section outline. */
export async function createProposalDocumentBlob(
  proposal: Proposal,
  opportunity: Opportunity,
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
  const approved =
    proposal.status === "approved" &&
    proposal.approvalVersion === proposal.version;
  const label = (en: string, ar: string) => (rtl ? ar : en);
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
                      children: [
                        new TextRun({
                          text,
                          bold: index === 0,
                          rightToLeft: rtl,
                        }),
                      ],
                    }),
                  ],
                }),
            ),
          }),
      ),
    });
  const children: (
    | InstanceType<typeof Paragraph>
    | InstanceType<typeof Table>
    | InstanceType<typeof TableOfContents>
  )[] = [
    paragraph(companyName),
    new Paragraph({
      text: proposal.title || opportunity.title,
      heading: HeadingLevel.TITLE,
      bidirectional: rtl,
    }),
    paragraph(`${label("Prepared for", "مقدم إلى")}: ${opportunity.buyer}`),
    paragraph(
      `${label("Reference", "المرجع")}: ${opportunity.reference} · ${label("Version", "النسخة")} ${proposal.version}`,
    ),
    paragraph(
      approved
        ? label(
            "Approved content. Review the exported file before submission.",
            "محتوى معتمد. تُراجع النسخة المصدرة قبل التقديم.",
          )
        : label(
            "Working draft — review before external use.",
            "مسودة عمل — تُراجع قبل الاستخدام الخارجي.",
          ),
    ),
    new Paragraph({
      text: label("Contents", "المحتويات"),
      pageBreakBefore: true,
      bidirectional: rtl,
      spacing: { after: 240 },
      children: [],
    }),
    new TableOfContents(label("Contents", "المحتويات"), {
      hyperlink: true,
      headingStyleRange: "1-2",
    }),
  ];
  proposal.sections.forEach((section, index) => {
    children.push(
      new Paragraph({
        text:
          section.title.trim() ||
          label(`Untitled section ${index + 1}`, `قسم بدون عنوان ${index + 1}`),
        heading: HeadingLevel.HEADING_1,
        bidirectional: rtl,
        pageBreakBefore: index === 0,
      }),
    );
    (
      section.body ||
      label(
        "[INPUT REQUIRED: section content]",
        "[INPUT REQUIRED: محتوى القسم]",
      )
    )
      .split("\n")
      .forEach((line) => children.push(paragraph(line)));
  });
  if (proposal.includePricing) {
    const total = calculateFinance(proposal);
    children.push(
      paragraph(
        label("Pricing schedule", "جدول التسعير"),
        HeadingLevel.HEADING_1,
      ),
    );
    children.push(
      paragraph(
        label(
          "Currency: SAR. Optional items are excluded from the base offer. The base cost is adjusted using the entered pricing assumptions.",
          "العملة: الريال السعودي. لا تشمل قيمة العرض الأساسية البنود الاختيارية. تُعدل التكلفة الأساسية وفق افتراضات التسعير المدخلة.",
        ),
      ),
    );
    children.push(
      table([
        [
          label("Description", "الوصف"),
          label("Quantity", "الكمية"),
          label("Unit", "الوحدة"),
          label("Unit cost (SAR)", "تكلفة الوحدة (ريال)"),
          label("Treatment", "النوع"),
        ],
        ...proposal.lines.map((line) => [
          line.description || "[INPUT REQUIRED]",
          line.quantity || "[INPUT REQUIRED]",
          line.unit || "[INPUT REQUIRED]",
          line.rate || "[INPUT REQUIRED]",
          line.optional ? label("Optional", "اختياري") : label("Base", "أساسي"),
        ]),
      ]),
    );
    if (total.isValid) {
      children.push(
        table([
          [label("Offer summary", "ملخص العرض"), "SAR"],
          [
            label("Base offer excluding tax", "قيمة العرض الأساسي قبل الضريبة"),
            total.net.toFixed(2),
          ],
          [label("Tax", "الضريبة"), total.tax.toFixed(2)],
          [
            label("Total including tax", "الإجمالي شامل الضريبة"),
            total.total.toFixed(2),
          ],
          [
            label(
              "Optional direct cost (excluded)",
              "تكلفة البنود الاختيارية (مستبعدة)",
            ),
            total.optionalTotal.toFixed(2),
          ],
        ]),
      );
      children.push(
        paragraph(
          `${label("Pricing method", "طريقة التسعير")}: ${proposal.pricingMode}; ${label("percentage", "النسبة")}: ${proposal.percentage}%; ${label("contingency", "احتياطي المخاطر")}: ${proposal.contingency}%; ${label("tax", "الضريبة")}: ${proposal.tax}%.`,
        ),
      );
    } else {
      children.push(
        paragraph(
          label(
            "[INPUT REQUIRED: Pricing is incomplete. Totals have not been included.]",
            "[INPUT REQUIRED: بيانات التسعير غير مكتملة؛ لم يتم إدراج الإجماليات.]",
          ),
        ),
      );
    }
  }
  const document = new Document({
    creator: companyName,
    title: proposal.title || opportunity.title,
    description: `${approved ? "Approved" : "Draft"} version ${proposal.version}`,
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
                    text: `${approved ? label("Approved", "معتمد") : label("Draft", "مسودة")} · v${proposal.version} · `,
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
  return Packer.toBlob(document);
}

export async function exportProposal(
  proposal: Proposal,
  opportunity: Opportunity,
  companyName: string,
) {
  const blob = await createProposalDocumentBlob(
    proposal,
    opportunity,
    companyName,
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = proposalFileName(proposal, opportunity);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
