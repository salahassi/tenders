import ProcurementHistory from "../components/ProcurementHistory";
import AddendumOrder from "../components/AddendumOrder";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { extractLocalDocument } from "../lib/documents";
import { saveLocalFile, removeLocalFile } from "../lib/knowledgeFiles";
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
import { downloadOriginal } from "../lib/remoteFiles";
import type { DocumentRecord, Opportunity } from "../types";
import FitAssessment from "../components/FitAssessment";
import GenerationPanel from "../components/GenerationPanel";
import "./workspace.css";
import "./simplified.css";
export default function OpportunityDetail() {
  const { id } = useParams();
  const { state, update, notify, mode, backend } = useApp();
  const o = state.opportunities.find((item) => item.id === id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<DocumentRecord | null>(null);
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
  const hasAttachedFiles = o.documents.length > 0;
  const knowledge = state.knowledgeDocuments.filter(
    (d) => d.enabled && d.status === "ready",
  );
  async function change(patch: Partial<Opportunity>, action: string) {
    if (
      !(await update(
        (s) => ({
          ...s,
          opportunities: s.opportunities.map((x) =>
            x.id === id ? { ...x, ...patch } : x,
          ),
        }),
        action,
        o!.title,
      ))
    ) {
      return;
    }
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
        const document = await extractLocalDocument(file);
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
            `${file.name}: attach up to 10 reference files per opportunity.`,
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
      if (
        !(await update(
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
          "Reference files attached",
          o!.title,
        ))
      ) {
        setBusy(false);
        return;
      }
      notify(
        `${added.length} reference file${added.length === 1 ? "" : "s"} saved. You can create a draft now; checking extracted text is optional.`,
      );
    }
    if (restored)
      notify(
        `${restored} original file(s) restored without duplicate records.`,
      );
    setError(failures.join("\n"));
    setBusy(false);
  }
  return (
    <div className="workspace-page">
      <Link className="text-link" to={selected ? "/opportunities" : "/review"}>
        <ArrowLeft size={14} /> {selected ? "Opportunities" : "Review inbox"}
      </Link>
      <Link className="text-link" to={`/jobs?opportunity=${id}`}>
        Model activity for this opportunity →
      </Link>
      <PageHeader
        eyebrow={`${o.reference} · ${o.buyer}`}
        title={o.title}
        description={
          o.description ||
          "Attach reference documents to start a proposal draft."
        }
      />
      <FitAssessment state={state} opportunity={o} compact={selected} />
      {!selected && <GenerationPanel opportunity={o} />}
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
            <strong>1 · Attach reference files</strong>
            <ArrowRight size={15} />
            <span>2 · Generate linked proposal</span>
            <ArrowRight size={15} />
            <span>3 · Review, answer, and regenerate</span>
          </div>
          <div className="simple-detail-grid">
            <div className="stack">
              <section className="panel simple-section">
                <span className="simple-step">STEP 1</span>
                <h2>Reference documents</h2>
                <p className="muted">
                  Attach an RFP, brief, existing proposal or other reference.
                  The file does not need to be an RFP or match this opportunity
                  to create a draft. Available text is used, and missing or
                  conflicting information is flagged for review.
                </p>
                <div className="simple-upload">
                  <Upload size={25} />
                  <Field
                    label="Upload reference files"
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
                </div>
                {busy && (
                  <p role="status">
                    Reading the files and saving them to your workspace…
                  </p>
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
                          : d.status === "partial"
                            ? "Partial text extracted · unread pages retained"
                            : d.status === "needs_ocr"
                              ? "Image or scan · no text extracted"
                              : "Text unavailable"}
                      </Badge>
                      {d.extractionCoverage && (
                        <p className="muted small">
                          {
                            d.extractionCoverage.pages.filter(
                              (page) => page.status === "readable",
                            ).length
                          }{" "}
                          of {d.extractionCoverage.pages.length} pages contain
                          extracted text.
                          {d.extractionCoverage.pages.some(
                            (page) =>
                              page.status === "needs_ocr" ||
                              page.status === "extraction_failed",
                          ) &&
                            ` Pages needing processing: ${d.extractionCoverage.pages
                              .filter(
                                (page) =>
                                  page.status === "needs_ocr" ||
                                  page.status === "extraction_failed",
                              )
                              .map((page) => page.page)
                              .join(
                                ", ",
                              )}. Readable pages remain available for the draft.`}
                        </p>
                      )}
                    </div>
                    <div className="simple-file-actions">
                      {backend &&
                        d.status === "ready" &&
                        !d.extractionConfirmed && (
                          <Button size="sm" onClick={() => setView(d)}>
                            Review extraction
                          </Button>
                        )}
                      {d.extractionConfirmed && (
                        <Badge tone="green">Extraction confirmed</Badge>
                      )}
                      <Button size="sm" onClick={() => setView(d)}>
                        View text
                      </Button>
                      <Button
                        size="sm"
                        aria-label={`Download ${d.name}`}
                        onClick={() =>
                          void downloadOriginal(backend, d.id, d.name).catch(
                            (err) =>
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
                            if (!backend) await removeLocalFile(d.id);
                            if (
                              !(await update(
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
                                "Removed reference file",
                                o.title,
                              ))
                            ) {
                              return;
                            }
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
                <AddendumOrder files={o.documents} />
                {!o.documents.length && (
                  <p className="simple-note">
                    No reference files attached yet.
                  </p>
                )}
              </section>
              <ProcurementHistory opportunityId={o.id} />
              <section className="panel simple-section">
                <span className="simple-step">STEP 2</span>
                <h2>
                  {proposals.length
                    ? "Your linked proposal"
                    : "Create a proposal draft"}
                </h2>
                <p>
                  Create a draft from the available documents and opportunity
                  details. A non-RFP, unrelated or incomplete document does not
                  stop draft creation. Review the proposed content and any
                  unresolved questions, then use your answers and change
                  requests to regenerate the same linked proposal.
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
                  Company knowledge is optional. {knowledge.length} readable
                  company file
                  {knowledge.length === 1 ? "" : "s"} enabled.{" "}
                  <Link className="text-link" to="/knowledge">
                    Manage company knowledge
                  </Link>
                </p>
                <div className="notice">
                  <Sparkles size={18} />
                  <p className="small">
                    Use the references you have. A custom template and company
                    files are optional. The draft uses available information and
                    flags missing scope, company facts or prices for review.
                  </p>
                </div>
                {backend && (
                  <GenerationPanel
                    opportunity={o}
                    embedded
                    onReviewFile={setView}
                    inputBusy={busy}
                  />
                )}
                <div className="simple-inline-actions">
                  {!proposals.length && !backend ? (
                    <Button
                      variant="primary"
                      disabled={!editable || !hasAttachedFiles || busy}
                      onClick={() => setAiInfo(true)}
                    >
                      <Sparkles size={16} /> Generate proposal
                    </Button>
                  ) : null}
                </div>
                {!hasAttachedFiles && (
                  <p className="simple-note">
                    Attach a reference file to begin. It does not need to be an
                    RFP.
                  </p>
                )}
                <details className="simple-note">
                  <summary>Advanced</summary>
                  <p>
                    Download available reference text and enabled company
                    references as agent input. Unread files are identified in
                    its limitations. This is supporting data, and downloading it
                    does not contact an AI service.
                  </p>
                  <Button
                    disabled={!hasAttachedFiles || busy}
                    onClick={() => downloadAgentInput(state, o)}
                  >
                    <Download size={16} /> Download agent input
                  </Button>
                </details>
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
                This stage follows the reference files and linked proposal
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
                Selecting a discovery does not create a proposal. Attach your
                reference files, then request a draft. Downloading Word does not
                submit it to the buyer.
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
          Checking extraction is optional for draft creation. Compare complex
          tables and scanned pages with the original when reviewing the draft.
        </p>
        <pre dir="auto" className="simple-extract">
          {view?.text ||
            "No readable text was extracted. Draft creation can continue with the other available text; this file will be identified as unread."}
        </pre>
        {backend &&
          view?.status === "ready" &&
          !view.extractionConfirmed &&
          editable && (
            <Button
              variant="primary"
              onClick={async () => {
                if (
                  await update(
                    (s) => ({
                      ...s,
                      opportunities: s.opportunities.map((x) =>
                        x.id === o.id
                          ? {
                              ...x,
                              documents: x.documents.map((d) =>
                                d.id === view.id
                                  ? { ...d, extractionConfirmed: true }
                                  : d,
                              ),
                            }
                          : x,
                      ),
                    }),
                    "Confirmed extraction",
                    view.id,
                  )
                )
                  setView(null);
              }}
            >
              I checked this text against the original; extraction is complete
            </Button>
          )}
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
            Your reference documents are attached to this opportunity. Once the
            agent is connected, this action will use their readable text,
            opportunity details and enabled Company Knowledge to prepare a
            proposal draft. Missing or conflicting context becomes specific
            review questions.
          </p>
          <p>
            The cost plan will connect each price to available scope and
            proposed deliverables, with quantity, effort, rate sources, and
            assumptions. Missing rates or quantities will become questions for
            you instead of invented prices. After you respond, regeneration will
            create a new version of the same proposal.
          </p>
          <p className="simple-note">
            No proposal has been created by this action. Your uploaded files
            remain attached and available.
          </p>
          <details className="simple-note">
            <summary>Advanced</summary>
            <p>Export the supporting data prepared for the agent.</p>
            <Button
              disabled={!hasAttachedFiles}
              onClick={() => downloadAgentInput(state, o)}
            >
              Download agent input
            </Button>
          </details>
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
