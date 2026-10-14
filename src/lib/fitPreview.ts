import type { AppState, DocumentRecord, Opportunity } from "../types";
import { createSeedState } from "./seed";

export interface FitPreview {
  mode: "example" | "unassessed";
  level:
    "High" | "Medium" | "Low" | "Insufficient information" | "Not assessed";
  confidence: "Medium" | "Low" | "Not assessed";
  basis: string;
  summary: string;
  reasons: Array<{
    label: string;
    noticeEvidence: string;
    knowledgeTitle: string;
    knowledgeEvidence: string;
  }>;
  unknowns: string[];
  message?: string;
}

// A fixed baseline identifies untouched demonstration inputs. These examples are
// manually authored, not a scoring algorithm or a response from an AI service.
const baseline = createSeedState(new Date("2026-10-14T12:00:00Z"));
const exampleMessage =
  "Manually written design example using synthetic notice and company notes. No AI ran and no RFP was used.";
const commonUnknowns = [
  "Registration, certifications, references, and staff availability are not supplied in the demo company profile.",
  "Mandatory eligibility, full scope, and commercial terms have not been reviewed; no RFP was used.",
];

function reason(
  label: string,
  noticeEvidence: string,
  knowledgeId: "k1" | "k2" | "k3",
): FitPreview["reasons"][number] {
  const fact = baseline.knowledge.find((item) => item.id === knowledgeId)!;
  return {
    label,
    noticeEvidence,
    knowledgeTitle: fact.title,
    knowledgeEvidence: fact.content,
  };
}

type Example = Pick<
  FitPreview,
  "level" | "confidence" | "summary" | "reasons" | "unknowns"
>;

const examples: Record<string, Example> = {
  "opp-1": {
    level: "High",
    confidence: "Medium",
    summary:
      "The advertised AI design and service workflow scope overlaps the demo company's stated AI and software services.",
    reasons: [
      reason(
        "AI solution design",
        "a phased AI enablement program and an internal service assistant grounded in approved knowledge",
        "k1",
      ),
      reason(
        "Workflow implementation",
        "service request workflows, access controls, evaluation, and a managed handover",
        "k2",
      ),
    ],
    unknowns: [
      "Specific knowledge-assistant experience, hosting requirements, and access to approved content need confirmation.",
    ],
  },
  "opp-2": {
    level: "High",
    confidence: "Medium",
    summary:
      "The notice requests API integration, which is explicitly included in the demo company's capability notes.",
    reasons: [
      reason(
        "Documented API integration",
        "Design an API catalog and connect three existing applications using approved interfaces.",
        "k2",
      ),
    ],
    unknowns: [
      "Gateway product requirements, access to the three applications, and required certifications need confirmation.",
    ],
  },
  "opp-3": {
    level: "High",
    confidence: "Medium",
    summary:
      "Workflow automation and implementation are directly represented in the demo company's software capability notes.",
    reasons: [
      reason(
        "Workflow automation",
        "Replace email-based approvals with configurable workflows and operational dashboards.",
        "k2",
      ),
    ],
    unknowns: [
      "Workflow platform constraints, process complexity, and integration access need confirmation.",
    ],
  },
  "opp-4": {
    level: "Medium",
    confidence: "Low",
    summary:
      "AI discovery is within the demo profile, but predictive maintenance expertise and usable equipment data are not established.",
    reasons: [
      reason(
        "AI discovery overlap",
        "Assess maintenance records and design a limited predictive pilot for critical equipment.",
        "k1",
      ),
    ],
    unknowns: [
      "The notice itself leaves data history, instrumentation coverage, and access permissions unresolved.",
      "The demo profile does not establish predictive maintenance or equipment-domain experience.",
    ],
  },
  "opp-5": {
    level: "High",
    confidence: "Medium",
    summary:
      "The internal portal is broadly aligned with the demo company's web application and technical handover services.",
    reasons: [
      reason(
        "Web application delivery",
        "Deliver a searchable internal knowledge portal with document permissions, bilingual navigation, and a documented handover.",
        "k2",
      ),
    ],
    unknowns: [
      "Specific search, bilingual accessibility, and document-permission requirements need confirmation.",
    ],
  },
  "opp-6": {
    level: "Medium",
    confidence: "Low",
    summary:
      "An AI feasibility study aligns with the demo profile's discovery services; document extraction experience is not evidenced.",
    reasons: [
      reason(
        "Bounded AI feasibility study",
        "Evaluate document extraction, routing, and human review using representative records.",
        "k1",
      ),
    ],
    unknowns: [
      "The notice does not state production access or processing volumes.",
      "Document languages, formats, extraction accuracy targets, and relevant company experience need confirmation.",
    ],
  },
  "opp-7": {
    level: "Insufficient information",
    confidence: "Low",
    summary:
      "Only a title is available. It does not establish the scope needed for a useful company-fit assessment.",
    reasons: [],
    unknowns: [
      "Obtain a substantive notice description or accessible tender documents before assessing service overlap.",
    ],
  },
  "opp-8": {
    level: "High",
    confidence: "Medium",
    summary:
      "The described integration and reporting work overlaps the demo company's software services; the notice excludes replacing security products.",
    reasons: [
      reason(
        "API integration and automation",
        "Build a consolidated operational dashboard using existing security platform APIs.",
        "k2",
      ),
    ],
    unknowns: [
      "Security-platform API access, domain expertise, and reporting obligations need confirmation.",
    ],
  },
  "opp-9": {
    level: "Medium",
    confidence: "Low",
    summary:
      "The software integration scope is potentially relevant, but the demo profile does not establish building-system analytics experience.",
    reasons: [
      reason(
        "Software data integration",
        "Combine approved building-system metrics with occupancy summaries to support facilities planning.",
        "k2",
      ),
      reason(
        "Excluded physical works are outside this package",
        "Sensor deployment and civil works are outside the software package in this synthetic example.",
        "k3",
      ),
    ],
    unknowns: [
      "Building-system interfaces, data quality, occupancy privacy requirements, and domain experience need confirmation.",
    ],
  },
  "opp-10": {
    level: "Low",
    confidence: "Medium",
    summary:
      "The advertised construction and installation scope falls within the demo company's explicit exclusions.",
    reasons: [
      reason(
        "Civil construction excluded",
        "Civil construction, installation, and commissioning of a new electrical substation. No software engineering or AI service component is specified.",
        "k3",
      ),
    ],
    unknowns: [
      "No separate software or integration package is described in the notice.",
    ],
  },
  "opp-11": {
    level: "Low",
    confidence: "Medium",
    summary:
      "Furniture supply is explicitly excluded by the demo company's qualification notes.",
    reasons: [
      reason(
        "Furniture supply excluded",
        "Supply and install furniture for a new office.",
        "k3",
      ),
    ],
    unknowns: [
      "No software or digital transformation scope is described in the notice.",
    ],
  },
  "opp-12": {
    level: "Medium",
    confidence: "Low",
    summary:
      "Web application testing is adjacent to the requested review, but specialist accessibility and usability expertise is not evidenced.",
    reasons: [
      reason(
        "Web application testing overlap",
        "Assess an existing customer portal, document usability barriers, and deliver a prioritized remediation backlog.",
        "k2",
      ),
    ],
    unknowns: [
      "Required accessibility standards, review methods, and specialist experience need confirmation.",
    ],
  },
};

function noticeSignature(opportunity: Opportunity): string {
  return JSON.stringify({
    id: opportunity.id,
    reference: opportunity.reference,
    title: opportunity.title,
    buyer: opportunity.buyer,
    description: opportunity.description,
    sourceId: opportunity.sourceId,
    sourceUrl: opportunity.sourceUrl,
    category: opportunity.category,
    tags: opportunity.tags,
    language: opportunity.language,
  });
}

function companySignature(state: AppState): string {
  return JSON.stringify({
    name: state.settings.companyName,
    facts: state.knowledge
      .filter((fact) =>
        ["capability", "exclusion", "company"].includes(fact.category),
      )
      .map(({ id, category, title, content, verified, evidence }) => ({
        id,
        category,
        title,
        content,
        verified,
        evidence,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function documentSignature(documents: DocumentRecord[]): string {
  // The baseline's timestamps differ from the user's initial seed date. All
  // content-bearing fields are checked, including unreadable/error documents.
  return JSON.stringify(
    documents
      .map(({ id, name, size, text, status, classification, hash }) => ({
        id,
        name,
        size,
        text,
        status,
        classification,
        hash,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function unassessed(changed: boolean): FitPreview {
  return {
    mode: "unassessed",
    level: "Not assessed",
    confidence: "Not assessed",
    basis: "No assessment performed",
    summary: changed
      ? "The notice, company context, or documents differ from the design example. A fresh assessment is needed."
      : "This opportunity has no assessment yet. The frontend does not evaluate real opportunities or company files.",
    reasons: [],
    unknowns: [],
    message: changed
      ? "Inputs changed — assessment needed"
      : "Assessment needed — AI is not connected",
  };
}

/** Returns an honest preview only while its exact synthetic inputs still apply. */
export function getFitPreview(
  state: AppState,
  opportunity: Opportunity,
): FitPreview {
  const original = baseline.opportunities.find(
    (item) => item.id === opportunity.id,
  );
  const example = examples[opportunity.id];
  if (!original || !example) return unassessed(false);
  if (
    noticeSignature(opportunity) !== noticeSignature(original) ||
    companySignature(state) !== companySignature(baseline) ||
    state.knowledgeDocuments.some((document) => document.enabled) ||
    documentSignature(opportunity.documents) !==
      documentSignature(original.documents)
  ) {
    return unassessed(true);
  }
  return {
    mode: "example",
    ...example,
    basis: "Notice description only",
    reasons: example.reasons.map((item) => ({ ...item })),
    unknowns: [...example.unknowns, ...commonUnknowns],
    message: exampleMessage,
  };
}
