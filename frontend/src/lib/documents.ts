import { extractDocumentOnWorker } from "./documentExtraction";
import type {
  DocumentRecord,
  Opportunity,
  Proposal,
  Requirement,
} from "../types";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export async function extractLocalDocument(
  file: File,
  classification: DocumentRecord["classification"] = "unspecified",
): Promise<DocumentRecord> {
  if (import.meta.env.MODE === "test")
    return extractDocumentOnWorker(file, classification);
  if (typeof Worker === "undefined")
    throw new Error(
      "This browser does not support background file extraction. Use a current browser.",
    );
  const worker = new Worker(
    new URL("./extraction.worker.ts", import.meta.url),
    { type: "module" },
  );
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          "Extraction exceeded two minutes. Split the document or supply a readable text replacement.",
        ),
      );
    }, 120000);
    worker.onmessage = ({ data }) => {
      // PDF.js can emit its own worker handshake on this channel while setting
      // up its fallback inside our background worker. Only our envelope ends
      // extraction; a library handshake is not an empty successful document.
      if (data?.kind !== "document-result") return;
      finish();
      data.error ? reject(new Error(data.error)) : resolve(data.document);
    };
    worker.onerror = () => {
      finish();
      reject(
        new Error(
          "Background extraction failed. Reattach a supported readable file.",
        ),
      );
    };
    worker.postMessage({ file, classification });
  });
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
  // A manual starter, not an AI-generated response or an inferred RFP outline.
  // Users add the sections their actual RFP requires; no fixed six-part form.
  const sections =
    opportunity.language === "ar"
      ? [
          [
            "فهم نطاق العمل",
            opportunity.description ||
              "[INPUT REQUIRED: اكتب فهمك لنطاق العمل من الكراسة المرفقة.]",
          ],
          [
            "الاستجابة المقترحة",
            "[INPUT REQUIRED: أضف محتوى العرض هنا، وأنشئ الأقسام المطلوبة في الكراسة.]",
          ],
        ]
      : [
          [
            "Understanding the request",
            opportunity.description ||
              "[INPUT REQUIRED: Describe the scope from the attached RFP.]",
          ],
          [
            "Proposed response",
            "[INPUT REQUIRED: Write your response here and add the sections required by the RFP.]",
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
    includePricing: false,
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
