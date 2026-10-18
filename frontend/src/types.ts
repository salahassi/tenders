export type Role = "Owner" | "Editor" | "Reviewer";
export type OpportunityStatus =
  "new" | "shortlisted" | "deferred" | "declined" | "in_progress" | "submitted";
export interface Requirement {
  id: string;
  text: string;
  source: string;
  mandatory: boolean;
  status: "open" | "addressed" | "not_applicable";
  response: string;
}
export interface Gap {
  id: string;
  question: string;
  answer: string;
  required: boolean;
}
export interface DocumentRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  text: string;
  status: "ready" | "needs_ocr" | "needs_processing" | "error";
  classification: "synthetic" | "public" | "sanitized" | "unspecified";
  hash: string;
  persisted?: boolean;
  extractionConfirmed?: boolean;
  precedence?: number;
  supersedesId?: string | null;
}
export interface KnowledgeDocument extends DocumentRecord {
  verified?: boolean;
  category: "company" | "team" | "previous_proposal" | "template" | "other";
  enabled: boolean;
}
export interface Opportunity {
  revision?: number;
  discovery?: {
    state:
      | "queued"
      | "running"
      | "retry_wait"
      | "quota_wait"
      | "assessed"
      | "blocked"
      | "failed"
      | "pending_schedule"
      | "not_started";
    inboxVisible: boolean;
    expired?: boolean;
    error?: string;
    nextAttempt?: string;
  };
  noticeEvidence?: {
    status: string;
    fetchedAt: string;
    attachments: {
      url: string;
      status: string;
      includedPages: number;
      totalPages: number | null;
    }[];
  };
  assessment?: {
    score: number | null;
    coverage: number;
    routing: string;
    scope?: string;
    scopeEvidence?: string[];
    method?: string;
    companySources?: {
      id: string;
      entity_kind: string;
      entity_id: string;
      content_hash: string;
    }[];
    summary: string;
    stale: boolean;
    factors: Record<
      string,
      {
        rating: number | null;
        reason: string;
        notice_evidence: { id: string; quote: string }[];
        company_evidence: { id: string; quote: string }[];
      }
    >;
    missing: string[];
    risks: string[];
  };
  id: string;
  reference: string;
  title: string;
  buyer: string;
  description: string;
  category: string;
  tags: string[];
  deadline: string;
  score: number | null;
  coverage: number;
  status: OpportunityStatus;
  sourceId: string;
  value: number | null;
  saved: boolean;
  createdAt: string;
  documents: DocumentRecord[];
  requirements: Requirement[];
  gaps: Gap[];
  acquisition:
    "not_requested" | "requested" | "approved" | "document_available";
  language: "en" | "ar";
  sourceUrl: string;
  deadlineSource?: string;
}
export interface ProposalSection {
  id: string;
  title: string;
  body: string;
  evidence: string[];
}
export interface FinanceLine {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  rate: string;
  optional: boolean;
  basis?: {
    rfpRequirementIds: string[];
    proposalSectionIds: string[];
    deliverable: string;
    estimateJustification: string;
    rateSource: string;
  };
}
export interface ProposalReviewAnswer {
  questionId: string;
  answer: string;
  attachments?: DocumentRecord[];
}
export interface ProposalSectionChange {
  sectionId: string;
  sectionTitle: string;
  comment: string;
  attachments?: DocumentRecord[];
}
export interface ProposalRegenerationRequest {
  id: string;
  requestedAt: string;
  status: "awaiting_connection";
  baseVersion: number;
  sourceSignature: string;
  answers: ProposalReviewAnswer[];
  instructions: string;
  sectionChanges?: ProposalSectionChange[];
  attachments?: DocumentRecord[];
}
export interface ProposalReview {
  baseVersion: number;
  sourceSignature: string;
  answers: ProposalReviewAnswer[];
  instructions: string;
  sectionChanges?: ProposalSectionChange[];
  attachments?: DocumentRecord[];
  savedAt: string;
  regeneration?: ProposalRegenerationRequest;
}
export interface Proposal {
  versionId?: string;
  revision?: number;
  planId?: string;
  id: string;
  opportunityId: string;
  title: string;
  status: "draft" | "in_review" | "approved";
  version: number;
  sections: ProposalSection[];
  lines: FinanceLine[];
  includePricing?: boolean;
  currency?: string;
  pricingMode: "markup" | "margin";
  percentage: string;
  contingency: string;
  tax: string;
  approvalVersion: number | null;
  updatedAt: string;
  comments: { id: string; body: string; at: string; author: string }[];
  review?: ProposalReview;
}
export interface Source {
  revision?: number;
  approvedHosts?: string[];
  adapterConfig?: Record<string, unknown>;
  adapterRequired?: boolean;
  pollHours?: number;
  id: string;
  name: string;
  type: "rss" | "json_feed" | "link_directory" | "manual";
  url: string;
  status: "proposed" | "approved" | "paused" | "rejected";
  health: "healthy" | "unknown" | "unavailable" | "blocked";
  lastRun: string | null;
  nextRun: string | null;
  count: number;
  policy: string;
  tags: string[];
}
export interface KnowledgeFact {
  id: string;
  category: "capability" | "company" | "exclusion" | "rate" | "template";
  title: string;
  content: string;
  verified: boolean;
  evidence: string;
}
export interface Job {
  id: string;
  type: string;
  target: string;
  status:
    "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  progress: number;
  attempt: number;
  message: string;
  createdAt: string;
}
export interface Notification {
  id: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  action: string;
  target: string;
  at: string;
  actor: string;
}
export interface AppSettings {
  discoveryScope?: "all" | "software_services";
  role: Role;
  companyName: string;
  dailyCallLimit: number;
  inputTokenLimit: number;
  outputTokenLimit: number;
  pollHours: number;
  retentionDays: number;
}
export interface AppState {
  schemaVersion: 1;
  opportunities: Opportunity[];
  proposals: Proposal[];
  sources: Source[];
  knowledge: KnowledgeFact[];
  knowledgeDocuments: KnowledgeDocument[];
  jobs: Job[];
  notifications: Notification[];
  audit: AuditEntry[];
  settings: AppSettings;
}
export type StateMutation = (state: AppState) => AppState;
