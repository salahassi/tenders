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
  status: "ready" | "needs_ocr" | "error";
  classification: "synthetic" | "public" | "sanitized";
  hash: string;
}
export interface Opportunity {
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
}
export interface Proposal {
  id: string;
  opportunityId: string;
  title: string;
  status: "draft" | "in_review" | "approved";
  version: number;
  sections: ProposalSection[];
  lines: FinanceLine[];
  pricingMode: "markup" | "margin";
  percentage: string;
  contingency: string;
  tax: string;
  approvalVersion: number | null;
  updatedAt: string;
  comments: { id: string; body: string; at: string; author: string }[];
}
export interface Source {
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
  jobs: Job[];
  notifications: Notification[];
  audit: AuditEntry[];
  settings: AppSettings;
}
export type StateMutation = (state: AppState) => AppState;
