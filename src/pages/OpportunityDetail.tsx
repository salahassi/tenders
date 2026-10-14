import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  Check,
  CheckCircle2,
  FileText,
  Plus,
  ShieldCheck,
  Upload,
  Clock3,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { useApp } from "../lib/store";
import { getApprovalBlockers } from "../lib/domain";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Modal,
  Field,
  Tabs,
  Metric,
  StatusBadge,
} from "../components/ui";
import type { Opportunity, DocumentRecord, Requirement } from "../types";
import {
  createTemplateProposal,
  extractLocalDocument,
  suggestRequirements,
} from "../lib/documents";
import "./workspace.css";
const date = (value: string) =>
  value
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Not provided";

export default function OpportunityDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, update, notify } = useApp();
  const opportunity = state.opportunities.find((o) => o.id === id);
  const [tab, setTab] = useState(searchParams.get("tab") || "overview");
  useEffect(() => {
    const value = searchParams.get("tab");
    if (
      value &&
      [
        "overview",
        "scoring",
        "acquisition",
        "documents",
        "requirements",
        "proposals",
        "audit",
      ].includes(value)
    )
      setTab(value);
  }, [searchParams]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [classification, setClassification] = useState<"public" | "synthetic">(
    "synthetic",
  );
  const [eligible, setEligible] = useState(false);
  const [preview, setPreview] = useState<DocumentRecord | null>(null);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewDocument, setViewDocument] = useState<DocumentRecord | null>(null);
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [submitDate, setSubmitDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [submitVersion, setSubmitVersion] = useState("");
  const [submissionAcknowledged, setSubmissionAcknowledged] = useState(false);
  const role = state.settings.role,
    canEdit = role !== "Reviewer",
    isOwner = role === "Owner";
  if (!opportunity)
    return (
      <EmptyState
        title="Opportunity not found"
        description="This record may have been removed from the local workspace."
        action={<Link to="/opportunities">Back to opportunities</Link>}
      />
    );
  const o = opportunity;
  const proposals = state.proposals.filter((p) => p.opportunityId === o.id);
  const source = state.sources.find((s) => s.id === o.sourceId);
  const approved = proposals.filter(
    (p) =>
      p.status === "approved" &&
      p.approvalVersion === p.version &&
      getApprovalBlockers(state, p).length === 0,
  );
  const exported = approved.filter((p) =>
    state.audit.some(
      (a) =>
        a.target === p.id &&
        a.action.startsWith("Exported approved") &&
        a.action.endsWith(`proposal version ${p.version}`),
    ),
  );
  const audit = state.audit.filter(
    (a) =>
      a.target === o.id ||
      a.target === o.title ||
      proposals.some((p) => p.id === a.target),
  );
  function change(patch: Partial<Opportunity>, action: string) {
    if (!canEdit) return;
    update(
      (s) => ({
        ...s,
        opportunities: s.opportunities.map((item) =>
          item.id === o.id ? { ...item, ...patch } : item,
        ),
      }),
      action,
      o.id,
    );
  }
  function newProposal() {
    if (!canEdit) return;
    if (!o.documents.some((d) => d.status === "ready")) {
      notify("Add and review a readable RFP before creating a draft.");
      setTab("documents");
      return;
    }
    if (!o.requirements.length) {
      notify("Add and review at least one requirement first.");
      setTab("requirements");
      return;
    }
    const proposal = createTemplateProposal(o);
    update(
      (s) => ({ ...s, proposals: [proposal, ...s.proposals] }),
      "Created local template draft",
      o.id,
    );
    navigate(`/proposals/${proposal.id}`);
  }
  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    setPreview(null);
    setComplete(false);
    if (!eligible) {
      setError(
        "Confirm that the file is public or synthetic before selecting it.",
      );
      return;
    }
    if (o.documents.length >= 10) {
      setError("This package already contains the maximum of 10 files.");
      return;
    }
    setBusy(true);
    try {
      const result = await extractLocalDocument(file, classification);
      const pageCount = (text: string) =>
        (text.match(/^\[Page \d+\]$/gm) || []).length;
      if (
        o.documents.reduce((sum, d) => sum + pageCount(d.text), 0) +
          pageCount(result.text) >
        200
      )
        throw new Error(
          "The package exceeds the aggregate limit of 200 PDF pages.",
        );
      if (o.documents.some((d) => d.hash === result.hash))
        throw new Error("This exact file is already in the package.");
      if (
        o.documents.reduce((n, d) => n + d.text.length, 0) +
          result.text.length >
        1_000_000
      )
        throw new Error("The package exceeds the extracted-text limit.");
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be read.");
    } finally {
      setBusy(false);
    }
  }
  function acceptDocument() {
    if (!preview || !complete || !canEdit) return;
    change(
      {
        documents: [...o.documents, preview],
        acquisition:
          preview.status === "ready" ? "document_available" : o.acquisition,
      },
      `Added ${preview.name}; extraction ${preview.status}`,
    );
    setUploadOpen(false);
    setPreview(null);
    setEligible(false);
    setComplete(false);
    notify("Document saved locally. Review the requirement inventory next.");
  }
  function saveRequirement() {
    if (!requirement || !canEdit) return;
    if (!requirement.text.trim() || !requirement.source.trim()) {
      notify("Enter the requirement and its source reference.");
      return;
    }
    if (requirement.status !== "open" && !requirement.response.trim()) {
      notify(
        "Provide a response or a reason before resolving this requirement.",
      );
      return;
    }
    change(
      {
        requirements: o.requirements.some((r) => r.id === requirement.id)
          ? o.requirements.map((r) =>
              r.id === requirement.id ? requirement : r,
            )
          : [...o.requirements, requirement],
      },
      "Updated requirement inventory",
    );
    setRequirement(null);
  }
  function createSuggestions() {
    if (!canEdit) return;
    const suggested = o.documents
      .filter((d) => d.status === "ready")
      .flatMap(suggestRequirements);
    const fresh = suggested.filter(
      (r) => !o.requirements.some((existing) => existing.text === r.text),
    );
    if (!fresh.length) {
      notify(
        "No new requirement-like lines found. Add requirements manually from the RFP.",
      );
      return;
    }
    change(
      { requirements: [...o.requirements, ...fresh] },
      "Added keyword-based requirement suggestions for review",
    );
    notify(
      `${fresh.length} suggestions added. This is a keyword scan, not AI analysis or proof of complete coverage.`,
    );
  }
  function recordSubmission() {
    if (
      !isOwner ||
      !reference.trim() ||
      !submitDate ||
      !submissionAcknowledged ||
      !exported.some((p) => p.id === submitVersion)
    )
      return;
    const p = exported.find((p) => p.id === submitVersion)!;
    if (getApprovalBlockers(state, p).length) {
      notify("This version has unresolved approval blockers.");
      return;
    }
    update(
      (s) => ({
        ...s,
        opportunities: s.opportunities.map((item) =>
          item.id === o.id ? { ...item, status: "submitted" } : item,
        ),
      }),
      `Recorded manual submission on ${submitDate}: ${reference.trim()} · proposal ${p.id} v${p.version}. Final artifact hash unverified; Owner attested review. No portal action performed.`,
      o.id,
    );
    setSubmissionOpen(false);
    notify(
      "Manual submission recorded. Nothing was sent to an external portal.",
    );
  }
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "scoring", label: "Fit assessment" },
    { id: "acquisition", label: "Acquisition" },
    { id: "documents", label: "Documents", count: o.documents.length },
    { id: "requirements", label: "Requirements", count: o.requirements.length },
    { id: "proposals", label: "Proposals", count: proposals.length },
    { id: "audit", label: "Activity" },
  ];
  return (
    <div className="workspace-page">
      <Link className="workspace-back" to="/opportunities">
        <ArrowLeft size={15} /> All opportunities
      </Link>
      <PageHeader
        eyebrow={`${o.reference} · ${o.category}`}
        title={o.title}
        description={o.buyer}
        actions={
          <>
            <Button
              aria-label={o.saved ? "Unsave opportunity" : "Save opportunity"}
              onClick={() =>
                change(
                  { saved: !o.saved },
                  o.saved ? "Unsaved opportunity" : "Saved opportunity",
                )
              }
              disabled={!canEdit}
            >
              <Bookmark size={16} fill={o.saved ? "currentColor" : "none"} />
            </Button>
            <Button variant="primary" onClick={newProposal} disabled={!canEdit}>
              <Plus size={16} /> Create draft
            </Button>
          </>
        }
      />
      <div className="workspace-meta">
        <StatusBadge status={o.status} />
        <span>
          <Clock3 size={14} /> Deadline {date(o.deadline)}
        </span>
        <span>{source?.name || "Manual source"}</span>
        <Badge tone="neutral">Local demo record</Badge>
      </div>
      <Tabs items={tabs} active={tab} onChange={setTab} />
      {tab === "overview" && (
        <div className="workspace-columns">
          <div className="stack">
            <section className="panel workspace-pad">
              <div className="workspace-kicker">THE OPPORTUNITY</div>
              <h2 className="section-title">A closer look at the brief</h2>
              <p className="workspace-prose">
                {o.description ||
                  "No description has been provided. Review the source before deciding."}
              </p>
              <div className="row workspace-tags">
                {o.tags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              {/^https:\/\//.test(o.sourceUrl) && (
                <a
                  className="workspace-text-link"
                  href={o.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View original announcement <ArrowUpRight size={15} />
                </a>
              )}
            </section>
            <section className="panel workspace-pad">
              <div className="panel-header">
                <h2 className="section-title">Information still needed</h2>
                <Badge
                  tone={
                    o.gaps.some((g) => g.required && !g.answer)
                      ? "amber"
                      : "green"
                  }
                >
                  {o.gaps.filter((g) => !g.answer).length} open
                </Badge>
              </div>
              {o.gaps.length ? (
                o.gaps.map((g) => (
                  <GapField
                    key={`${g.id}-${g.answer}`}
                    question={g.question}
                    answer={g.answer}
                    required={g.required}
                    disabled={!canEdit}
                    onSave={(answer) =>
                      change(
                        {
                          gaps: o.gaps.map((item) =>
                            item.id === g.id ? { ...item, answer } : item,
                          ),
                        },
                        "Updated missing information",
                      )
                    }
                  />
                ))
              ) : (
                <p className="muted">
                  No open questions recorded. Confirm the complete RFP before
                  treating the scope as final.
                </p>
              )}
            </section>
          </div>
          <aside className="stack">
            <section className="panel workspace-pad">
              <h2 className="section-title">Planning details</h2>
              <DeadlineField
                key={o.deadline}
                value={o.deadline}
                disabled={!canEdit}
                onSave={(deadline) =>
                  change(
                    {
                      deadline,
                      gaps: o.gaps.map((g) =>
                        /deadline|timezone/i.test(g.question)
                          ? {
                              ...g,
                              answer: `Confirmed deadline: ${deadline} (entered in Asia/Riyadh)`,
                            }
                          : g,
                      ),
                    },
                    "Confirmed submission deadline",
                  )
                }
              />
              <Field label="Proposal language">
                <select
                  className="input"
                  disabled={!canEdit}
                  value={o.language}
                  onChange={(e) =>
                    change(
                      { language: e.target.value as "en" | "ar" },
                      "Changed proposal language",
                    )
                  }
                >
                  <option value="en">English</option>
                  <option value="ar">Arabic</option>
                </select>
              </Field>
            </section>
            <section className="panel workspace-pad workspace-decision">
              <div className="workspace-kicker">YOUR DECISION</div>
              <h2 className="section-title">Worth a closer look?</h2>
              <p className="muted">
                Your decision stays separate from fit scoring and RFP
                acquisition.
              </p>
              <Button
                variant={o.status === "shortlisted" ? "primary" : "secondary"}
                disabled={!canEdit || o.status === "submitted"}
                onClick={() =>
                  change({ status: "shortlisted" }, "Shortlisted opportunity")
                }
              >
                <Check size={16} /> Shortlist opportunity
              </Button>
              <div className="row">
                <Button
                  disabled={!canEdit || o.status === "submitted"}
                  onClick={() =>
                    change({ status: "deferred" }, "Deferred opportunity")
                  }
                >
                  Defer
                </Button>
                <Button
                  variant="ghost"
                  disabled={!canEdit || o.status === "submitted"}
                  onClick={() =>
                    change({ status: "declined" }, "Declined opportunity")
                  }
                >
                  Not a fit
                </Button>
              </div>
            </section>
            <section className="panel workspace-pad">
              <div className="workspace-score">
                <span>{o.score ?? "—"}</span>
                <div>
                  <strong>Fit score</strong>
                  <p className="muted small">Out of 100 · not a probability</p>
                </div>
              </div>
              <div className="workspace-meter">
                <i style={{ width: `${o.coverage}%` }} />
              </div>
              <p className="muted small">{o.coverage}% evidence coverage</p>
              <Button variant="ghost" onClick={() => setTab("scoring")}>
                Review assessment <ArrowRight size={14} />
              </Button>
            </section>
            <section className="notice">
              <ShieldCheck size={18} />
              <div>
                <strong>You stay in control</strong>
                <p className="small">
                  No automatic purchase, payment, external message, or bid
                  submission.
                </p>
              </div>
            </section>
          </aside>
        </div>
      )}
      {tab === "scoring" && (
        <div className="stack">
          <div className="workspace-metrics">
            <Metric
              label="Fit score"
              value={o.score === null ? "Pending" : `${o.score}/100`}
              detail="Relevance to the company profile"
            />
            <Metric
              label="Evidence coverage"
              value={`${o.coverage}%`}
              detail="How much of the assessment is supported"
            />
            <Metric
              label="Business decision"
              value={o.status.replaceAll("_", " ")}
              detail="Set by a person, never by this score"
            />
          </div>
          <section className="panel workspace-pad">
            <h2 className="section-title">Make the score explainable</h2>
            <p className="workspace-prose">
              The trial weighs capability fit (50%), scope relevance (25%),
              sector alignment (15%), and known prerequisites (10%). An
              energy-sector preference does not make a construction contract a
              software opportunity.
            </p>
            <div className="notice notice-warning">
              <AlertTriangle size={18} />
              <div>
                <strong>
                  {o.coverage < 60
                    ? "Human review needed"
                    : "Review the available evidence"}
                </strong>
                <p className="small">
                  {o.coverage < 60
                    ? "There is not enough evidence for a confident recommendation."
                    : "Check the original announcement and missing inputs before committing."}{" "}
                  These stored demo scores are illustrative. No live model was
                  called and no factor-level audit was fabricated.
                </p>
              </div>
            </div>
            <div className="workspace-evidence">
              <span className="workspace-kicker">AVAILABLE SOURCE TEXT</span>
              <blockquote>{o.description || o.title}</blockquote>
            </div>
          </section>
        </div>
      )}
      {tab === "acquisition" && (
        <div className="workspace-columns">
          <section className="panel workspace-pad">
            <h2 className="section-title">Obtain the RFP</h2>
            <p className="muted">
              Track the decision here. Obtain and pay for the document manually
              on the source portal.
            </p>
            <div className="workspace-steps">
              {[
                [
                  "not_requested",
                  "Request document",
                  "Decide whether to obtain the full tender.",
                ],
                [
                  "requested",
                  "Owner approval",
                  "Approval records a decision, not a payment.",
                ],
                [
                  "approved",
                  "Acquire manually",
                  "Follow the source portal’s purchase or download instructions.",
                ],
                [
                  "document_available",
                  "Add the RFP",
                  "Upload eligible content and confirm extraction.",
                ],
              ].map(([key, title, description], index) => (
                <div className="workspace-step" key={key}>
                  <span
                    className={
                      [
                        "not_requested",
                        "requested",
                        "approved",
                        "document_available",
                      ].indexOf(o.acquisition) >= index
                        ? "done"
                        : ""
                    }
                  >
                    {index + 1}
                  </span>
                  <div>
                    <strong>{title}</strong>
                    <p className="muted small">{description}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="row">
              {o.acquisition === "not_requested" && (
                <Button
                  variant="primary"
                  disabled={!canEdit}
                  onClick={() =>
                    change(
                      { acquisition: "requested" },
                      "Requested manual RFP acquisition",
                    )
                  }
                >
                  Request acquisition
                </Button>
              )}
              {o.acquisition === "requested" && (
                <Button
                  variant="primary"
                  disabled={!isOwner}
                  onClick={() =>
                    change(
                      { acquisition: "approved" },
                      "Owner approved manual acquisition; no payment made",
                    )
                  }
                >
                  Approve acquisition
                </Button>
              )}
              <Button
                onClick={() => {
                  setTab("documents");
                  setUploadOpen(true);
                }}
                disabled={!canEdit}
              >
                <Upload size={15} /> Add document
              </Button>
            </div>
          </section>
          <aside className="panel workspace-pad">
            <div className="workspace-kicker">CURRENT STATUS</div>
            <StatusBadge status={o.acquisition} />
            <p className="workspace-prose">
              Free public documents can be added directly. Paid acquisition
              requires your own manual purchase. This frontend has no payment
              credentials or portal integration.
            </p>
            {/^https:\/\//.test(o.sourceUrl) && (
              <a
                className="workspace-text-link"
                href={o.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open source portal <ArrowUpRight size={15} />
              </a>
            )}
          </aside>
        </div>
      )}
      {tab === "documents" && (
        <section className="panel">
          <div className="panel-header workspace-pad">
            <div>
              <h2 className="section-title">RFP document package</h2>
              <p className="muted small">
                PDF, DOCX, TXT, or Markdown · up to 10 MiB each · processed on
                this device
              </p>
            </div>
            <Button
              variant="primary"
              disabled={!canEdit}
              onClick={() => {
                setError("");
                setUploadOpen(true);
              }}
            >
              <Upload size={16} /> Add document
            </Button>
          </div>
          {!o.documents.length ? (
            <EmptyState
              title="Start with the full brief"
              description="Add a public or synthetic RFP. Review the extracted text before using it to prepare a proposal."
            />
          ) : (
            <div className="workspace-document-list">
              {o.documents.map((d) => (
                <div className="workspace-document" key={d.id}>
                  <div className="workspace-file-icon">
                    <FileText size={22} />
                  </div>
                  <div className="workspace-document-info">
                    <strong>{d.name}</strong>
                    <p className="muted small">
                      {(d.size / 1024).toFixed(1)} KB · {d.classification} ·{" "}
                      {date(d.uploadedAt)}
                    </p>
                  </div>
                  <StatusBadge status={d.status} />
                  <Button size="sm" onClick={() => setViewDocument(d)}>
                    View text
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${d.name} from this local package? Related proposal approvals will be invalidated. You can then add a readable replacement.`,
                        )
                      ) {
                        const remaining = o.documents.filter(
                          (item) => item.id !== d.id,
                        );
                        change(
                          {
                            documents: remaining,
                            acquisition: remaining.some(
                              (item) => item.status === "ready",
                            )
                              ? "document_available"
                              : "not_requested",
                            requirements: o.requirements.map((r) =>
                              r.source.includes(d.name)
                                ? { ...r, status: "open" }
                                : r,
                            ),
                          },
                          `Removed document ${d.name}`,
                        );
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="workspace-pad">
            <div className="notice">
              <ShieldCheck size={17} />
              <p className="small">
                Files are read locally and extracted text is stored in this
                browser. Originals are not uploaded. Do not use confidential or
                personal files in this public demo.
              </p>
            </div>
          </div>
        </section>
      )}
      {tab === "requirements" && (
        <div className="stack">
          <div className="panel workspace-pad">
            <div className="panel-header">
              <div>
                <h2 className="section-title">Requirement inventory</h2>
                <p className="muted small">
                  {
                    o.requirements.filter((r) => r.status === "addressed")
                      .length
                  }{" "}
                  of {o.requirements.length} addressed · retain source
                  references
                </p>
              </div>
              <div className="row">
                <Button
                  disabled={
                    !canEdit || !o.documents.some((d) => d.status === "ready")
                  }
                  onClick={createSuggestions}
                >
                  Scan for suggestions
                </Button>
                <Button
                  variant="primary"
                  disabled={!canEdit}
                  onClick={() =>
                    setRequirement({
                      id: crypto.randomUUID(),
                      text: "",
                      source: "",
                      mandatory: true,
                      status: "open",
                      response: "",
                    })
                  }
                >
                  <Plus size={15} /> Add requirement
                </Button>
              </div>
            </div>
            <p className="notice small">
              Keyword scanning only finds explicit requirement-like lines.
              Review all pages yourself; no AI analysis or full-coverage claim
              is made.
            </p>
          </div>
          {!o.requirements.length ? (
            <section className="panel">
              <EmptyState
                title="Build the response checklist"
                description="Add requirements from the RFP, or scan the locally extracted text for suggestions. Every item needs a source reference."
              />
            </section>
          ) : (
            o.requirements.map((r, index) => (
              <section className="panel workspace-pad" key={r.id}>
                <div className="panel-header">
                  <div className="row">
                    <span className="workspace-kicker">
                      REQ {String(index + 1).padStart(2, "0")}
                    </span>
                    {r.mandatory && <Badge tone="amber">Mandatory</Badge>}
                    <StatusBadge status={r.status} />
                  </div>
                  <Button
                    size="sm"
                    disabled={!canEdit}
                    onClick={() => setRequirement({ ...r })}
                  >
                    Edit response
                  </Button>
                </div>
                <p className="workspace-prose">{r.text}</p>
                <p className="workspace-source-ref">
                  <FileText size={13} />
                  {r.source}
                </p>
                {r.response && (
                  <div className="workspace-response">
                    <strong>Proposed response</strong>
                    <p>{r.response}</p>
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      )}
      {tab === "proposals" && (
        <div className="stack">
          <section className="panel">
            <div className="panel-header workspace-pad">
              <h2 className="section-title">Proposal workspace</h2>
              <Button
                variant="primary"
                disabled={!canEdit}
                onClick={newProposal}
              >
                <Plus size={16} /> Create template draft
              </Button>
            </div>
            {proposals.length ? (
              <div className="workspace-document-list">
                {proposals.map((p) => (
                  <Link
                    to={`/proposals/${p.id}`}
                    className="workspace-document workspace-linked"
                    key={p.id}
                  >
                    <div className="workspace-file-icon">
                      <FileText size={22} />
                    </div>
                    <div className="workspace-document-info">
                      <strong>{p.title}</strong>
                      <p className="muted small">
                        Version {p.version} · Updated {date(p.updatedAt)}
                      </p>
                    </div>
                    <StatusBadge status={p.status} />
                    <ArrowRight size={17} />
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Your next proposal starts here"
                description="After reviewing the RFP and requirements, create an editable template draft. No model or paid service is used."
              />
            )}
          </section>
          <section className="panel workspace-pad">
            <div className="panel-header">
              <div>
                <h2 className="section-title">Manual submission record</h2>
                <p className="muted">
                  Exporting never submits a bid. Record the external submission
                  only after it happened.
                </p>
              </div>
              <Button
                disabled={
                  !isOwner || !exported.length || o.status === "submitted"
                }
                onClick={() => {
                  setSubmitVersion(exported[0]?.id || "");
                  setSubmissionAcknowledged(false);
                  setSubmissionOpen(true);
                }}
              >
                Record submission
              </Button>
            </div>
            {o.status === "submitted" && (
              <Badge tone="green">Submission recorded · see activity</Badge>
            )}
            {!exported.length && (
              <p className="small muted">
                An approved current proposal version with no blockers and a
                recorded approved DOCX export is required.
              </p>
            )}
          </section>
        </div>
      )}
      {tab === "audit" && (
        <section className="panel workspace-pad">
          <h2 className="section-title">Activity trail</h2>
          {audit.length ? (
            <div className="workspace-timeline">
              {audit.map((a) => (
                <div key={a.id}>
                  <span className="workspace-timeline-dot" />
                  <div>
                    <strong>{a.action}</strong>
                    <p className="muted small">
                      {a.actor} · {new Date(a.at).toLocaleString("en-US")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No recorded changes yet"
              description="Decisions, document updates, and proposal actions appear here as you work."
            />
          )}
        </section>
      )}
      <Modal
        open={uploadOpen}
        onClose={() => !busy && setUploadOpen(false)}
        title="Add an RFP document"
      >
        <div className="stack">
          <p className="muted">
            Read an eligible file locally. No file is sent to a server or AI
            provider.
          </p>
          <Field label="Data classification">
            <select
              className="input"
              value={classification}
              onChange={(e) => {
                setClassification(e.target.value as "public" | "synthetic");
                setPreview(null);
              }}
            >
              <option value="synthetic">Synthetic test document</option>
              <option value="public">Public, nonpersonal document</option>
            </select>
          </Field>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={eligible}
              onChange={(e) => setEligible(e.target.checked)}
            />
            I confirm this content contains no confidential, personal, or
            sensitive data.
          </label>
          <Field
            label="Choose a document"
            hint="PDF, DOCX, TXT, MD · maximum 10 MiB"
          >
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md"
              disabled={!eligible || busy}
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </Field>
          {busy && (
            <p role="status">
              Extracting text on this device… Keep this dialog open.
            </p>
          )}
          {error && (
            <p role="alert" className="workspace-error">
              {error}
            </p>
          )}
          {preview && (
            <>
              <div className="row">
                <strong>{preview.name}</strong>
                <StatusBadge status={preview.status} />
              </div>
              <pre className="workspace-extract">
                {preview.text.slice(0, 12000) || "No readable text found."}
                {preview.text.length > 12000
                  ? "\n[Preview limited to first 12,000 characters]"
                  : ""}
              </pre>
              {preview.status === "needs_ocr" && (
                <p className="notice notice-warning small">
                  This document needs OCR or a readable replacement. No analysis
                  can use it yet.
                </p>
              )}
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={complete}
                  onChange={(e) => setComplete(e.target.checked)}
                />
                {preview.status === "ready"
                  ? "I checked the extracted text against the original and accept it for this local trial."
                  : "Save this file record as Needs OCR. I understand it is blocked for drafting."}
              </label>
              <Button
                variant="primary"
                disabled={!complete || !eligible}
                onClick={acceptDocument}
              >
                Save document record
              </Button>
            </>
          )}
        </div>
      </Modal>
      <Modal
        open={!!viewDocument}
        onClose={() => setViewDocument(null)}
        title={viewDocument?.name || "Document"}
      >
        {viewDocument && (
          <>
            <p className="muted small">
              SHA-256: {viewDocument.hash.slice(0, 32)}… · {viewDocument.status}
            </p>
            <pre className="workspace-extract workspace-extract-tall">
              {viewDocument.text ||
                "No readable text is available. Add an OCR-processed replacement."}
            </pre>
          </>
        )}
      </Modal>
      <Modal
        open={!!requirement}
        onClose={() => setRequirement(null)}
        title="Requirement and response"
      >
        {requirement && (
          <div className="stack">
            <Field label="Requirement text">
              <textarea
                className="textarea"
                rows={4}
                value={requirement.text}
                onChange={(e) =>
                  setRequirement({ ...requirement, text: e.target.value })
                }
              />
            </Field>
            <Field
              label="Source reference"
              hint="Document name and page, section, or extracted line"
            >
              <input
                className="input"
                value={requirement.source}
                onChange={(e) =>
                  setRequirement({ ...requirement, source: e.target.value })
                }
              />
            </Field>
            <label className="workspace-check">
              <input
                type="checkbox"
                checked={requirement.mandatory}
                onChange={(e) =>
                  setRequirement({
                    ...requirement,
                    mandatory: e.target.checked,
                  })
                }
              />
              Mandatory requirement
            </label>
            <Field label="Response or disposition rationale">
              <textarea
                className="textarea"
                rows={4}
                value={requirement.response}
                onChange={(e) =>
                  setRequirement({ ...requirement, response: e.target.value })
                }
              />
            </Field>
            <Field label="Response status">
              <select
                className="input"
                value={requirement.status}
                onChange={(e) =>
                  setRequirement({
                    ...requirement,
                    status: e.target.value as Requirement["status"],
                  })
                }
              >
                <option value="open">Open / needs review</option>
                <option value="addressed">Addressed</option>
                <option value="not_applicable" disabled={!isOwner}>
                  Not applicable (Owner only)
                </option>
              </select>
            </Field>
            <Button variant="primary" onClick={saveRequirement}>
              Save requirement
            </Button>
          </div>
        )}
      </Modal>
      <Modal
        open={submissionOpen}
        onClose={() => setSubmissionOpen(false)}
        title="Record a completed manual submission"
      >
        <div className="stack">
          <div className="notice notice-warning">
            <AlertTriangle size={18} />
            <p>
              This records something you already submitted outside the app. It
              sends nothing.
            </p>
          </div>
          <Field label="Approved proposal version">
            <select
              className="input"
              value={submitVersion}
              onChange={(e) => setSubmitVersion(e.target.value)}
            >
              {exported.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · v{p.version}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Submission date">
            <input
              type="date"
              className="input"
              value={submitDate}
              onChange={(e) => setSubmitDate(e.target.value)}
            />
          </Field>
          <Field label="Portal / channel and receipt reference">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Portal name · receipt/reference number"
            />
          </Field>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={submissionAcknowledged}
              onChange={(e) => setSubmissionAcknowledged(e.target.checked)}
            />
            I reviewed the final file submitted externally. I understand this
            demo records its approved content version but does not verify the
            final artifact hash.
          </label>
          <Button
            variant="primary"
            disabled={
              !reference.trim() ||
              !submitDate ||
              !submitVersion ||
              !submissionAcknowledged
            }
            onClick={recordSubmission}
          >
            <CheckCircle2 size={16} /> Record manual submission
          </Button>
        </div>
      </Modal>
    </div>
  );
}
function GapField({
  question,
  answer,
  required,
  disabled,
  onSave,
}: {
  question: string;
  answer: string;
  required: boolean;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(answer);
  return (
    <div className="workspace-gap">
      <Field label={`${question}${required ? " *" : ""}`}>
        <textarea
          className="textarea"
          value={value}
          disabled={disabled}
          rows={2}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Provide an evidence-based answer…"
        />
      </Field>
      <Button
        size="sm"
        disabled={disabled || value === answer}
        onClick={() => onSave(value)}
      >
        Save answer
      </Button>
    </div>
  );
}

function DeadlineField({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(
    value
      ? new Date(Date.parse(value) + 3 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 16)
      : "",
  );
  return (
    <div className="workspace-gap">
      <Field
        label="Confirmed deadline"
        hint="Asia/Riyadh · UTC+03:00. Confirm this time against the source."
      >
        <input
          type="datetime-local"
          className="input"
          disabled={disabled}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Field>
      <Button
        size="sm"
        disabled={disabled || !draft}
        onClick={() => {
          const date = new Date(`${draft}:00+03:00`);
          if (!Number.isNaN(date.getTime())) onSave(date.toISOString());
        }}
      >
        Confirm deadline
      </Button>
    </div>
  );
}
