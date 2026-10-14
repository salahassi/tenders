import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  FileText,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { can } from "../lib/domain";
import { createTemplateProposal, extractLocalDocument } from "../lib/documents";
import {
  downloadLocalFile,
  saveLocalFile,
  removeLocalFile,
} from "../lib/knowledgeFiles";
import { downloadAgentInput } from "../lib/agentInput";
import {
  isSelected,
  deadlineSourceLabel,
  getOpportunityStage,
  opportunityStageLabel,
  opportunityStageHelp,
} from "../lib/workflow";
import { date } from "../lib/format";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageHeader,
} from "../components/ui";
import type { DocumentRecord, Opportunity } from "../types";
import FitAssessment from "../components/FitAssessment";
import "./workspace.css";
import "./simplified.css";
export default function OpportunityDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, update, notify } = useApp();
  const o = state.opportunities.find((item) => item.id === id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<DocumentRecord | null>(null);
  const [classification, setClassification] = useState<
    "public" | "synthetic" | "sanitized"
  >("synthetic");
  const [editDetails, setEditDetails] = useState(false);
  const [aiInfo, setAiInfo] = useState(false);
  if (!o)
    return (
      <EmptyState
        title="Opportunity not found"
        description="Choose an opportunity from your workspace."
        action={
          <Link to="/opportunities" className="btn btn-primary">
            Opportunities
          </Link>
        }
      />
    );
  const editable = can(state.settings.role, "edit");
  const selected = isSelected(o);
  const proposals = state.proposals.filter((p) => p.opportunityId === o.id);
  const stage = getOpportunityStage(o, state.proposals);
  const ready =
    o.documents.length > 0 && o.documents.every((d) => d.status === "ready");
  const knowledge = state.knowledgeDocuments.filter(
    (d) => d.enabled && d.status === "ready",
  );
  function change(patch: Partial<Opportunity>, action: string) {
    update(
      (s) => ({
        ...s,
        opportunities: s.opportunities.map((x) =>
          x.id === id ? { ...x, ...patch } : x,
        ),
      }),
      action,
      o!.title,
    );
  }
  async function upload(files: File[]) {
    if (!editable || !files.length || busy) return;
    setBusy(true);
    setError("");
    const added: DocumentRecord[] = [];
    const failures: string[] = [];
    let restored = 0;
    for (const file of files) {
      try {
        const document = await extractLocalDocument(file, classification);
        const duplicate = [...o!.documents, ...added].find(
          (d) => d.hash === document.hash,
        );
        if (duplicate) {
          await saveLocalFile(duplicate.id, file);
          restored++;
          continue;
        }
        if (o!.documents.length + added.length >= 10) {
          failures.push(
            `${file.name}: attach up to 10 RFP files per opportunity.`,
          );
          continue;
        }
        await saveLocalFile(document.id, file);
        added.push(document);
      } catch (err) {
        failures.push(
          `${file.name}: ${err instanceof Error ? err.message : "Could not read the file."}`,
        );
      }
    }
    if (added.length) {
      update(
        (s) => ({
          ...s,
          opportunities: s.opportunities.map((x) =>
            x.id === id
              ? {
                  ...x,
                  documents: [...x.documents, ...added],
                  acquisition: "document_available",
                }
              : x,
          ),
        }),
        "RFP files attached",
        o!.title,
      );
      notify(
        `${added.length} RFP file${added.length === 1 ? "" : "s"} saved locally. No AI request was made.`,
      );
    }
    if (restored)
      notify(
        `${restored} original file(s) restored without duplicate records.`,
      );
    setError(failures.join("\n"));
    setBusy(false);
  }
  function createDraft() {
    if (!editable || !ready) return;
    if (proposals.length) {
      navigate(`/proposals/${proposals[0].id}`);
      return;
    }
    const proposal = createTemplateProposal(o!);
    update(
      (s) => ({
        ...s,
        proposals: [proposal, ...s.proposals],
        opportunities: s.opportunities.map((x) =>
          x.id === id ? { ...x, status: "in_progress" } : x,
        ),
      }),
      "Created editable draft",
      o!.title,
    );
    notify("Editable starter created. AI has not written this draft.");
    navigate(`/proposals/${proposal.id}`);
  }
  return (
    <div className="workspace-page">
      <Link className="text-link" to={selected ? "/opportunities" : "/review"}>
        <ArrowLeft size={14} /> {selected ? "Opportunities" : "Review inbox"}
      </Link>
      <PageHeader
        eyebrow={`${o.reference} · ${o.buyer}`}
        title={o.title}
        description={
          o.description || "Upload the RFP to start preparing a proposal."
        }
      />
      <FitAssessment state={state} opportunity={o} compact={selected} />
      {!selected ? (
        <section className="panel simple-section">
          <h2>Your decision</h2>
          <p>
            This discovery is not in Opportunities yet. Add it when you want to
            prepare a proposal.
          </p>
          <div className="simple-inline-actions">
            <Button
              variant="primary"
              disabled={!editable}
              onClick={() =>
                change({ status: "shortlisted" }, "Selected opportunity")
              }
            >
              Add to opportunities <ArrowRight size={16} />
            </Button>
            <Link className="btn btn-secondary" to="/review">
              Back to inbox
            </Link>
          </div>
        </section>
      ) : (
        <>
          <div className="simple-flow">
            <strong>1 · Upload RFP</strong>
            <ArrowRight size={15} />
            <span>2 · Generate linked proposal</span>
            <ArrowRight size={15} />
            <span>3 · Review and download Word</span>
          </div>
          <div className="simple-detail-grid">
            <div className="stack">
              <section className="panel simple-section">
                <span className="simple-step">STEP 1</span>
                <h2>RFP files</h2>
                <p className="muted">
                  Attach the tender document and any addenda. Files and
                  extracted text stay in this browser.
                </p>
                <div className="simple-upload">
                  <Upload size={25} />
                  <Field label="File content">
                    <select
                      className="input"
                      value={classification}
                      disabled={!editable || busy}
                      onChange={(e) =>
                        setClassification(
                          e.target.value as typeof classification,
                        )
                      }
                    >
                      <option value="synthetic">Synthetic test files</option>
                      <option value="public">Public documents</option>
                      <option value="sanitized">Sanitized documents</option>
                    </select>
                  </Field>
                  <Field
                    label="Upload RFP files"
                    hint="PDF, DOCX, TXT, MD · 10 MiB per file · up to 10 files"
                  >
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.docx,.txt,.md"
                      disabled={!editable || busy}
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = "";
                        void upload(files);
                      }}
                    />
                  </Field>
                  <span className="small muted">
                    Use public, synthetic, or sanitized files for this trial.
                  </span>
                </div>
                {busy && (
                  <p role="status">Reading and saving files on this device…</p>
                )}
                {error && (
                  <p
                    role="alert"
                    className="workspace-error"
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {error}
                  </p>
                )}
                {o.documents.map((d) => (
                  <div className="simple-file" key={d.id}>
                    <FileText size={21} />
                    <div className="simple-file-info">
                      <strong>{d.name}</strong>
                      <p className="muted small">
                        {Math.ceil(d.size / 1024)} KB · {date(d.uploadedAt)}
                      </p>
                      <Badge tone={d.status === "ready" ? "green" : "amber"}>
                        {d.status === "ready"
                          ? "Text extracted"
                          : d.status === "needs_ocr"
                            ? "Needs readable text / OCR"
                            : "Could not extract text"}
                      </Badge>
                    </div>
                    <div className="simple-file-actions">
                      <Button size="sm" onClick={() => setView(d)}>
                        View text
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Download ${d.name}`}
                        onClick={() =>
                          void downloadLocalFile(d.id, d.name).catch((err) =>
                            notify(
                              err instanceof Error
                                ? err.message
                                : "Original file unavailable. Please attach it again.",
                            ),
                          )
                        }
                      >
                        <Download size={15} />
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Remove ${d.name}`}
                        disabled={!editable || busy}
                        onClick={async () => {
                          try {
                            await removeLocalFile(d.id);
                            update(
                              (s) => ({
                                ...s,
                                opportunities: s.opportunities.map((x) =>
                                  x.id === id
                                    ? {
                                        ...x,
                                        documents: x.documents.filter(
                                          (item) => item.id !== d.id,
                                        ),
                                      }
                                    : x,
                                ),
                              }),
                              "Removed RFP file",
                              o.title,
                            );
                          } catch (err) {
                            notify(
                              err instanceof Error
                                ? err.message
                                : "Could not remove file.",
                            );
                          }
                        }}
                      >
                        <X size={15} />
                      </Button>
                    </div>
                  </div>
                ))}
                {!o.documents.length && (
                  <p className="simple-note">No RFP files attached yet.</p>
                )}
              </section>
              <section className="panel simple-section">
                <span className="simple-step">STEP 2</span>
                <h2>
                  {proposals.length
                    ? "Your linked proposal"
                    : "Generate a proposal from the RFP"}
                </h2>
                <p>
                  The RFP describes what the buyer needs. Your proposal is the
                  response you will send back. This opportunity has one linked
                  proposal, created after you attach the RFP.
                </p>
                <Field label="Proposal language">
                  <select
                    className="input"
                    value={o.language}
                    disabled={!editable}
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
                <p className="simple-note">
                  {knowledge.length} readable company file
                  {knowledge.length === 1 ? "" : "s"} enabled.{" "}
                  <Link className="text-link" to="/knowledge">
                    Manage company knowledge
                  </Link>
                </p>
                <div className="notice">
                  <Sparkles size={18} />
                  <p className="small">
                    The agent will use this RFP and enabled company files to
                    write your proposal. AI generation is not connected in this
                    frontend; no generated response is claimed.
                  </p>
                </div>
                <div className="simple-inline-actions">
                  {proposals.length ? (
                    <Link
                      className="btn btn-primary"
                      to={`/proposals/${proposals[0].id}`}
                    >
                      Open proposal <ArrowRight size={16} />
                    </Link>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={!editable || !ready || busy}
                      onClick={() => setAiInfo(true)}
                    >
                      <Sparkles size={16} /> Generate proposal
                    </Button>
                  )}
                  <Button
                    disabled={!ready || busy}
                    onClick={() => downloadAgentInput(state, o)}
                  >
                    <Download size={16} />
                    Download agent input
                  </Button>
                </div>
                {!ready && (
                  <p className="simple-note">
                    {o.documents.length
                      ? "Attach readable replacements for files that need OCR before preparing the draft."
                      : "Attach a readable RFP to start. A deadline and a separate requirements checklist are not required."}
                  </p>
                )}
                {!proposals.length && (
                  <details className="simple-note">
                    <summary>Write the proposal manually</summary>
                    <p>
                      Optional: after attaching the RFP, open an editor for this
                      opportunity’s proposal. It starts with the notice
                      description and an empty response section. You write the
                      content, add the sections the RFP requires, and download
                      it as Word. This does not generate an AI response.
                    </p>
                    <Button
                      disabled={!editable || !ready || busy}
                      onClick={createDraft}
                    >
                      Start writing from this RFP <ArrowRight size={16} />
                    </Button>
                  </details>
                )}
                {proposals.length > 0 && (
                  <div className="stack" style={{ marginTop: 18 }}>
                    {proposals.map((p) => (
                      <Link
                        className="workspace-document workspace-linked"
                        to={`/proposals/${p.id}`}
                        key={p.id}
                      >
                        <FileText size={21} />
                        <span className="simple-file-info">
                          <strong>{p.title}</strong>
                          <small className="muted"> · v{p.version}</small>
                        </span>
                        <ArrowRight size={16} />
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            </div>
            <aside className="panel simple-section">
              <h2>Opportunity details</h2>
              <Badge tone={stage === "proposal_created" ? "green" : "blue"}>
                {opportunityStageLabel(stage)}
              </Badge>
              <p className="simple-note">{opportunityStageHelp[stage]}</p>
              <p className="simple-note">
                This stage follows the attached RFP and linked proposal
                automatically.
              </p>
              {proposals.length > 0 && (
                <div className="simple-submission">
                  <h3>External submission</h3>
                  <p className="simple-note">
                    {o.status === "submitted"
                      ? "You recorded this opportunity as submitted. The proposal remains available in Proposals."
                      : "After you send the Word file to the buyer outside this app, you can record that here."}
                  </p>
                  <Button
                    size="sm"
                    disabled={
                      !can(state.settings.role, "record_submission") || busy
                    }
                    onClick={() => {
                      change(
                        {
                          status:
                            o.status === "submitted"
                              ? "in_progress"
                              : "submitted",
                        },
                        o.status === "submitted"
                          ? "Cleared external submission record"
                          : "Recorded external submission",
                      );
                      notify("Submission record updated. No file was sent.");
                    }}
                  >
                    {o.status === "submitted"
                      ? "Clear submission record"
                      : "Mark as submitted externally"}
                  </Button>
                </div>
              )}
              <dl className="simple-meta">
                <dt>Closing date</dt>
                <dd>
                  {date(o.deadline)}
                  {o.deadline && (
                    <>
                      {" "}
                      ·{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "Asia/Riyadh",
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(o.deadline))}{" "}
                      Riyadh
                    </>
                  )}
                  <br />
                  <span className="muted small">{deadlineSourceLabel(o)}</span>
                </dd>
                <dt>What is this date?</dt>
                <dd className="small muted">
                  The buyer’s deadline for submitting the bid, as stated in the
                  notice or RFP. It is optional here and does not block
                  drafting.
                </dd>
                <dt>Source</dt>
                <dd>
                  {state.sources.find((s) => s.id === o.sourceId)?.name ||
                    "Added by you"}
                </dd>
              </dl>
              {o.sourceUrl && (
                <p>
                  <a
                    className="text-link"
                    href={o.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Original notice <ExternalLink size={13} />
                  </a>
                </p>
              )}
              <Button
                size="sm"
                disabled={!editable || busy}
                onClick={() => setEditDetails(true)}
              >
                Edit closing date
              </Button>
              <p className="simple-note">
                Selecting a discovery does not create a proposal. Uploading an
                RFP prepares it for generation. Downloading Word does not submit
                it to the buyer.
              </p>
              <div className="simple-inline-actions">
                <Button
                  size="sm"
                  disabled={!editable || busy}
                  onClick={() =>
                    change({ status: "new" }, "Returned opportunity to Review")
                  }
                >
                  Return to Review
                </Button>
                <Button
                  size="sm"
                  disabled={!editable || busy}
                  onClick={() =>
                    change({ status: "declined" }, "Archived opportunity")
                  }
                >
                  Archive opportunity
                </Button>
              </div>
            </aside>
          </div>
        </>
      )}
      <Modal
        open={!!view}
        title={view?.name || "Extracted text"}
        onClose={() => setView(null)}
      >
        <p className="muted small">
          Extracted text for the agent. Check complex tables and scanned pages
          against the original.
        </p>
        <pre dir="auto" className="simple-extract">
          {view?.text ||
            "No readable text extracted. Attach an OCR-processed copy."}
        </pre>
      </Modal>
      <Modal
        open={editDetails}
        title="Closing date from the source"
        onClose={() => setEditDetails(false)}
      >
        <DeadlineEditor
          opportunity={o}
          onSave={(deadline, deadlineSource) => {
            change({ deadline, deadlineSource }, "Updated closing date");
            setEditDetails(false);
          }}
        />
      </Modal>
      <Modal
        open={aiInfo}
        title="Proposal generation is not connected"
        onClose={() => setAiInfo(false)}
      >
        <div className="stack">
          <p>
            Your RFP is attached to this opportunity. Once the agent is
            connected, this action will read the RFP and enabled Company
            Knowledge, write a proposal, and open it for your review. No
            proposal has been created by this action. You can use the optional
            manual editor meanwhile.
          </p>
          <p>
            Download the agent input to get the readable RFP text and enabled
            company files together. Downloading does not send anything to an AI
            provider.
          </p>
          <Button
            disabled={!ready}
            onClick={() => downloadAgentInput(state, o)}
          >
            Download agent input
          </Button>
          <Link to="/setup" className="text-link">
            View connection requirements
          </Link>
        </div>
      </Modal>
      {!selected && (
        <p className="simple-note">
          Current stage:{" "}
          {selected ? opportunityStageLabel(stage) : "Awaiting your decision"}
        </p>
      )}
    </div>
  );
}
function DeadlineEditor({
  opportunity,
  onSave,
}: {
  opportunity: Opportunity;
  onSave: (deadline: string, source: string) => void;
}) {
  const [value, setValue] = useState(
    opportunity.deadline
      ? new Date(Date.parse(opportunity.deadline) + 3 * 3600000)
          .toISOString()
          .slice(0, 16)
      : "",
  );
  const [source, setSource] = useState(opportunity.deadlineSource || "");
  const [error, setError] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = value ? new Date(`${value}:00+03:00`) : null;
        if (parsed && !Number.isFinite(parsed.getTime())) {
          setError("Enter a valid date and time.");
          return;
        }
        onSave(
          parsed?.toISOString() || "",
          value ? source.trim() || "Entered by you" : "",
        );
      }}
    >
      <Field
        label="Closing date and time"
        hint="Optional · Asia/Riyadh (UTC+3). Leave blank if unknown."
      >
        <input
          className="input"
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Field
        label="Where is this date stated?"
        hint="For example: RFP page 2, addendum 1, or the original notice."
      >
        <input
          className="input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source reference (optional)"
        />
      </Field>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" variant="primary">
        Save closing date
      </Button>
    </form>
  );
}
