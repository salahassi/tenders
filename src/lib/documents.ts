import type {
  DocumentRecord,
  Opportunity,
  Proposal,
  Requirement,
} from "../types";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export async function extractLocalDocument(
  file: File,
  classification: "public" | "synthetic" | "sanitized",
): Promise<DocumentRecord> {
  if (file.size > MAX_FILE_BYTES)
    throw new Error("The file exceeds the 10 MiB trial limit.");
  if (!file.size) throw new Error("The file is empty.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["txt", "md", "pdf", "docx"].includes(extension || ""))
    throw new Error("Choose a PDF, DOCX, TXT, or Markdown file.");
  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes.slice(0, 8));
  let text = "";
  let partialExtraction = false;
  if (extension === "pdf") {
    if (new TextDecoder().decode(prefix).slice(0, 5) !== "%PDF-")
      throw new Error("The file signature does not match PDF.");
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(0),
      enableXfa: false,
      stopAtErrors: true,
    });
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > 200)
        throw new Error("The trial supports up to 200 PDF pages per file.");
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        if (
          content.items.filter((item) => "str" in item && item.str.trim())
            .length === 0
        )
          partialExtraction = true;
        pages.push(
          `[Page ${pageNumber}]\n${content.items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")).join("")}`,
        );
        if (pages.join("").length > 1_000_000)
          throw new Error(
            "Extracted content exceeds the 1,000,000-character trial limit.",
          );
      }
      text = pages.join("\n\n");
    } finally {
      await loadingTask.destroy();
    }
  } else if (extension === "docx") {
    if (prefix[0] !== 80 || prefix[1] !== 75)
      throw new Error("The file signature does not match DOCX.");
    // Reject archive expansion before handing the bounded file to Mammoth.
    const view = new DataView(bytes);
    let entries = 0;
    let expandedBytes = 0;
    for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      entries++;
      expandedBytes += view.getUint32(offset + 24, true);
      if (entries > 2000 || expandedBytes > 50 * 1024 * 1024)
        throw new Error(
          "The DOCX archive exceeds safe local extraction limits.",
        );
      const length = view.getUint16(offset + 28, true);
      const entryName = new TextDecoder().decode(
        bytes.slice(offset + 46, offset + 46 + length),
      );
      if (/vbaProject|embeddings\//i.test(entryName))
        throw new Error(
          "Embedded executable or active content is not accepted.",
        );
    }
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    text = result.value;
  } else {
    if (prefix.some((byte) => byte === 0))
      throw new Error("The file does not appear to be plain text.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (text.length > 1_000_000)
    throw new Error(
      "Extracted content exceeds the 1,000,000-character trial limit.",
    );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const readable =
    text.replace(/\[Page \d+\]/g, "").trim().length >= 30 && !partialExtraction;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text,
    status: readable ? "ready" : "needs_ocr",
    classification,
    hash,
  };
}

export function suggestRequirements(document: DocumentRecord): Requirement[] {
  let page = "";
  return document.text
    .split(/\n+/)
    .flatMap((line, index) => {
      const pageMatch = line.match(/^\[Page (\d+)\]/);
      if (pageMatch) {
        page = pageMatch[1];
        return [];
      }
      const text = line.trim();
      if (
        text.length < 15 ||
        !/\b(must|shall|required|requirement|deliver|provide)\b|يجب|يتعين|يلتزم|المطلوب/i.test(
          text,
        )
      )
        return [];
      return [
        {
          id: crypto.randomUUID(),
          text: text.slice(0, 2000),
          source: `${document.name} · ${page ? `page ${page}` : `extracted line ${index + 1}`}`,
          mandatory: /\b(must|shall|required)\b|يجب|يتعين|يلتزم/i.test(text),
          status: "open" as const,
          response: "",
        },
      ];
    })
    .slice(0, 50);
}

export function createTemplateProposal(opportunity: Opportunity): Proposal {
  const summary =
    opportunity.language === "ar"
      ? "مسودة أولية مبنية على المعلومات المتاحة. تتطلب مراجعة بشرية وتأكيد جميع الافتراضات قبل الاعتماد."
      : "This preliminary response is based on the available opportunity information. Confirm the complete RFP scope and all assumptions before approval.";
  const sections =
    opportunity.language === "ar"
      ? [
          [
            "الملخص التنفيذي",
            `${summary}\n\n${opportunity.title}\n${opportunity.description}`,
          ],
          [
            "فهم المتطلبات",
            opportunity.requirements
              .map((r, i) => `${i + 1}. ${r.text}`)
              .join("\n") || "[INPUT REQUIRED: راجع متطلبات الكراسة]",
          ],
          [
            "الحل المقترح ونطاق العمل",
            "[INPUT REQUIRED: حدد الحل المقترح والنطاق والاستثناءات والافتراضات بناءً على متطلبات الكراسة.]",
          ],
          [
            "التنفيذ والفريق",
            "[INPUT REQUIRED: أكد مراحل التنفيذ والجهد وتوافر الفريق والمدة الزمنية.]",
          ],
          [
            "الاختبار والقبول والدعم",
            "[INPUT REQUIRED: حدد معايير القبول والاختبارات والضمان والدعم وفق الكراسة.]",
          ],
          [
            "Commercial terms / الشروط التجارية",
            "[INPUT REQUIRED: أكد جدول الدفعات وصلاحية العرض ومدد التكاليف المتكررة والاستثناءات التجارية.]",
          ],
        ]
      : [
          [
            "Executive summary",
            `${summary}\n\n${opportunity.title}\n${opportunity.description}`,
          ],
          [
            "Understanding of requirements",
            opportunity.requirements
              .map((r, i) => `${i + 1}. ${r.text}`)
              .join("\n") || "[INPUT REQUIRED: Review the RFP requirements.]",
          ],
          [
            "Proposed solution and scope",
            "[INPUT REQUIRED: Define the architecture, scope, exclusions, dependencies, and assumptions against the RFP. Do not invent infrastructure quantities or credentials.]",
          ],
          [
            "Delivery plan and team",
            "[INPUT REQUIRED: Confirm work phases, role effort, staff availability, and the delivery schedule.]",
          ],
          [
            "Testing, acceptance, and support",
            "[INPUT REQUIRED: Define tests, acceptance evidence, warranty, and support according to the RFP.]",
          ],
          [
            "Commercial terms",
            "[INPUT REQUIRED: Confirm payment schedule, offer validity, recurring cost periods, and commercial exclusions.]",
          ],
        ];
  return {
    id: crypto.randomUUID(),
    opportunityId: opportunity.id,
    title: `${opportunity.title} — proposal`,
    status: "draft",
    version: 1,
    sections: sections.map(([title, body]) => ({
      id: crypto.randomUUID(),
      title,
      body,
      evidence: opportunity.requirements.map((r) => r.id),
    })),
    lines: [],
    pricingMode: "markup",
    percentage: "",
    contingency: "",
    tax: "",
    approvalVersion: null,
    updatedAt: new Date().toISOString(),
    comments: [],
  };
}

export function contentBlockers(
  opportunity: Opportunity,
  proposal: Proposal,
): string[] {
  const blockers: string[] = [];
  if (!opportunity.documents.some((d) => d.status === "ready"))
    blockers.push("Add and review a readable RFP document.");
  if (!opportunity.requirements.length)
    blockers.push("Create and review the requirement inventory.");
  const unresolved = opportunity.requirements.filter(
    (r) => r.mandatory && (r.status === "open" || !r.response.trim()),
  );
  if (unresolved.length)
    blockers.push(
      `${unresolved.length} mandatory requirement${unresolved.length === 1 ? "" : "s"} need a response or a justified disposition.`,
    );
  const gaps = opportunity.gaps.filter((g) => g.required && !g.answer.trim());
  if (gaps.length)
    blockers.push(
      `${gaps.length} required input${gaps.length === 1 ? " is" : "s are"} unanswered.`,
    );
  if (
    !proposal.sections.length ||
    proposal.sections.some(
      (s) => !s.body.trim() || /\[INPUT REQUIRED/i.test(s.body),
    )
  )
    blockers.push(
      "Complete every proposal section and remove unresolved input markers.",
    );
  if (!proposal.lines.length)
    blockers.push("Add at least one confirmed commercial line.");
  return blockers;
}
