import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Download,
  FileText,
  MessageSquare,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  AlertTriangle,
  Send,
  Clock3,
} from "lucide-react";
import { useApp } from "../lib/store";
import { getApprovalBlockers } from "../lib/domain";
import { calculateFinance } from "../lib/finance";
import { exportProposal } from "../lib/export";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Modal,
  Field,
  Tabs,
  StatusBadge,
} from "../components/ui";
import type { Proposal, ProposalSection } from "../types";
import "./workspace.css";
const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
export default function ProposalEditor() {
  const { id } = useParams();
  const { state, update, notify } = useApp();
  const proposal = state.proposals.find((p) => p.id === id);
  const opportunity = state.opportunities.find(
    (o) => o.id === proposal?.opportunityId,
  );
  const [tab, setTab] = useState("write");
  const [selected, setSelected] = useState("");
  const [comment, setComment] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [sectionTitle, setSectionTitle] = useState("");
  const [exporting, setExporting] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const canEdit = state.settings.role !== "Reviewer",
    isOwner = state.settings.role === "Owner";
  if (!proposal || !opportunity)
    return (
      <EmptyState
        title="Proposal not found"
        description="Choose a proposal from your workspace."
        action={<Link to="/proposals">All proposals</Link>}
      />
    );
  const p = proposal,
    o = opportunity;
  const blockers = getApprovalBlockers(state, p);
  const currentSection =
    p.sections.find((s) => s.id === selected) || p.sections[0];
  const totals = calculateFinance(p);
  const approved = p.status === "approved" && p.approvalVersion === p.version;
  function patchProposal(
    patch: Partial<Proposal>,
    action: string,
    contentChange = false,
  ) {
    if (contentChange && !canEdit) return;
    update(
      (s) => ({
        ...s,
        proposals: s.proposals.map((item) =>
          item.id === p.id
            ? {
                ...item,
                ...patch,
                ...(contentChange
                  ? {
                      status: "draft" as const,
                      approvalVersion: null,
                      version: item.version + 1,
                    }
                  : {}),
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      }),
      action,
      p.id,
    );
  }
  function saveSection(section: ProposalSection) {
    patchProposal(
      { sections: p.sections.map((s) => (s.id === section.id ? section : s)) },
      `Saved section ${section.title}`,
      true,
    );
    notify("Section saved. The current content version was updated.");
  }
  function addSection() {
    if (!canEdit || !sectionTitle.trim()) return;
    const section = {
      id: crypto.randomUUID(),
      title: sectionTitle.trim(),
      body: "",
      evidence: [],
    };
    patchProposal(
      { sections: [...p.sections, section] },
      `Added section ${section.title}`,
      true,
    );
    setSelected(section.id);
    setAddOpen(false);
    setSectionTitle("");
  }
  function addComment() {
    if (!comment.trim()) return;
    patchProposal(
      {
        comments: [
          ...p.comments,
          {
            id: crypto.randomUUID(),
            body: comment.trim(),
            at: new Date().toISOString(),
            author: state.settings.role,
          },
        ],
      },
      "Added proposal review comment",
    );
    setComment("");
    notify("Review comment saved.");
  }
  function submitReview() {
    if (!canEdit) return;
    patchProposal(
      { status: "in_review" },
      "Submitted current proposal version for local review",
    );
    setTab("review");
    notify("Ready for human review. Approval remains a separate action.");
  }
  function approve() {
    if (!isOwner || blockers.length || !attested) return;
    patchProposal(
      { status: "approved", approvalVersion: p.version },
      `Owner approved exact proposal version ${p.version}`,
    );
    setApprovalOpen(false);
    setAttested(false);
    notify(
      `Version ${p.version} approved. Any content change will invalidate approval.`,
    );
  }
  async function download(volume: "technical" | "financial", final: boolean) {
    if (final && (!isOwner || !approved || blockers.length)) return;
    setExporting(true);
    try {
      await exportProposal(p, o, volume, final, state.settings.companyName);
      update(
        (s) => ({ ...s }),
        `Exported ${final ? "approved" : "draft"} ${volume} DOCX · proposal version ${p.version}`,
        p.id,
      );
      notify(
        "DOCX downloaded. Update all fields and the full TOC in Word, then review the final file.",
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : "Document export failed.");
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="workspace-page">
      <Link className="workspace-back" to={`/opportunities/${o.id}`}>
        <ArrowLeft size={15} /> {o.reference} · Opportunity workspace
      </Link>
      <PageHeader
        eyebrow="PROPOSAL STUDIO"
        title={o.title}
        description={`${o.buyer} · ${o.language === "ar" ? "Arabic" : "English"} proposal`}
        actions={
          <>
            <Badge tone="neutral">Version {p.version}</Badge>
            <StatusBadge status={p.status} />
            {p.status === "draft" && (
              <Button
                variant="primary"
                disabled={!canEdit}
                onClick={submitReview}
              >
                <Send size={15} /> Send for review
              </Button>
            )}
          </>
        }
      />
      <div className="workspace-studio-note">
        <FileText size={15} />
        <span>
          Local template workspace. No AI provider is connected. Your edits are
          saved in this browser.
        </span>
        <span className="workspace-autosave">
          <Check size={13} /> Saved{" "}
          {new Date(p.updatedAt).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: "write", label: "Write proposal", count: p.sections.length },
          { id: "finance", label: "Commercials" },
          { id: "review", label: "Review & export", count: blockers.length },
        ]}
      />
      {tab === "write" && (
        <div className="workspace-studio">
          <aside className="panel workspace-outline">
            <div className="workspace-outline-header">
              <span className="workspace-kicker">DOCUMENT OUTLINE</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Add section"
                disabled={!canEdit}
                onClick={() => setAddOpen(true)}
              >
                <Plus size={16} />
              </Button>
            </div>
            <nav aria-label="Proposal sections">
              {p.sections.map((section, index) => (
                <button
                  key={section.id}
                  className={currentSection?.id === section.id ? "active" : ""}
                  onClick={() => setSelected(section.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>{section.title}</span>
                  {section.body.trim() &&
                  !/\[INPUT REQUIRED/i.test(section.body) ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <span className="workspace-unfilled" />
                  )}
                </button>
              ))}
            </nav>
            <div className="workspace-outline-footer">
              <p className="small muted">
                Structure and prose are editable. Claims and assumptions still
                need evidence.
              </p>
              <Link
                className="workspace-text-link"
                to={`/opportunities/${o.id}`}
              >
                View RFP evidence <ArrowUpRight size={14} />
              </Link>
            </div>
          </aside>
          <section
            aria-label="Proposal section editor"
            className="panel workspace-paper"
          >
            {currentSection ? (
              <SectionEditor
                key={`${currentSection.id}-${p.version}`}
                section={currentSection}
                draftKey={`${p.id}-${currentSection.id}-${p.version}`}
                disabled={!canEdit}
                language={o.language}
                onSave={saveSection}
              />
            ) : (
              <EmptyState
                title="Add your first section"
                description="Build the outline from the RFP's required response structure."
              />
            )}
          </section>
          <aside className="workspace-writing-aside">
            <div className="workspace-kicker">WRITING ASSIST</div>
            <h3>Make every claim count.</h3>
            <p className="muted small">
              Use the RFP as the source of truth. Keep estimates separate from
              confirmed commitments.
            </p>
            <div className="workspace-guidance">
              <ShieldCheck size={19} />
              <strong>Evidence first</strong>
              <p>
                Reference a requirement, verified company fact, or explicit
                approved assumption.
              </p>
            </div>
            <div className="workspace-guidance">
              <AlertTriangle size={19} />
              <strong>Keep gaps visible</strong>
              <p>
                Use [INPUT REQUIRED: detail] when information is missing. Final
                approval will stay blocked.
              </p>
            </div>
            <div className="workspace-guidance">
              <FileText size={19} />
              <strong>Separate pricing</strong>
              <p>
                Put offer validity and payment terms in a section titled
                “Commercial terms.” It is exported only in the financial volume.
              </p>
            </div>
            <div className="workspace-small-stat">
              <strong>
                {o.requirements.filter((r) => r.status === "addressed").length}/
                {o.requirements.length}
              </strong>
              <span>requirements addressed</span>
            </div>
          </aside>
        </div>
      )}
      {tab === "finance" && (
        <FinanceEditor
          key={`${p.id}-${p.version}`}
          proposal={p}
          disabled={!canEdit}
          onSave={(patch) => {
            patchProposal(
              patch,
              "Saved financial inputs; totals recalculated",
              true,
            );
            notify("Financial inputs saved. Prior approval is invalidated.");
          }}
        />
      )}
      {tab === "review" && (
        <div className="workspace-columns">
          <div className="stack">
            <section className="panel workspace-pad">
              <div className="panel-header">
                <div>
                  <div className="workspace-kicker">FINALIZATION CHECK</div>
                  <h2 className="section-title">
                    {blockers.length
                      ? "A few things need attention"
                      : "Ready for your decision"}
                  </h2>
                </div>
                <Badge tone={blockers.length ? "amber" : "green"}>
                  {blockers.length} blockers
                </Badge>
              </div>
              {blockers.length ? (
                <ul className="workspace-blockers">
                  {blockers.map((blocker, index) => (
                    <li key={index}>
                      <AlertTriangle size={15} />
                      <span>{blocker}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="notice">
                  <CheckCircle2 size={20} />
                  <p>
                    Recorded inputs pass the local completeness checks. A person
                    must still verify technical correctness, evidence, pricing,
                    and the full RFP.
                  </p>
                </div>
              )}
              <div className="row workspace-review-actions">
                <Button
                  variant="primary"
                  disabled={!isOwner || !!blockers.length || approved}
                  onClick={() => setApprovalOpen(true)}
                >
                  <ShieldCheck size={16} /> Approve version {p.version}
                </Button>
                <Button
                  disabled={approved}
                  onClick={() =>
                    patchProposal(
                      { status: "draft" },
                      "Requested changes to proposal",
                    )
                  }
                >
                  Request changes
                </Button>
              </div>
              {!isOwner && (
                <p className="small muted">
                  Only the Owner can approve. You can leave a review
                  recommendation below.
                </p>
              )}
            </section>
            <section className="panel workspace-pad">
              <div className="panel-header">
                <h2 className="section-title">Review conversation</h2>
                <MessageSquare size={18} />
              </div>
              {p.comments.length ? (
                <div className="workspace-comments">
                  {p.comments.map((c) => (
                    <article key={c.id}>
                      <div className="row">
                        <strong>{c.author}</strong>
                        <span className="small muted">
                          {new Date(c.at).toLocaleString("en-US")}
                        </span>
                      </div>
                      <p>{c.body}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  No comments yet. Record decisions, concerns, and approval
                  recommendations here.
                </p>
              )}
              <Field label="Add a comment">
                <textarea
                  className="textarea"
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="What should the author change or verify?"
                />
              </Field>
              <div className="workspace-comment-button">
                <Button disabled={!comment.trim()} onClick={addComment}>
                  <MessageSquare size={15} /> Post comment
                </Button>
              </div>
            </section>
            <section className="panel workspace-pad">
              <h2 className="section-title">Version record</h2>
              <div className="row">
                <Badge>Current version {p.version}</Badge>
                {approved && (
                  <Badge tone="green">
                    Approved version {p.approvalVersion}
                  </Badge>
                )}
              </div>
              <p className="small muted">
                Content and pricing edits create a new current version and
                invalidate approval. This frontend stores the current snapshot
                and action trail; immutable historical document snapshots are a
                backend integration step.
              </p>
              {state.audit
                .filter((a) => a.target === p.id)
                .slice(0, 6)
                .map((a) => (
                  <div className="workspace-version-event" key={a.id}>
                    <Clock3 size={13} />
                    <span>{a.action}</span>
                    <time>{new Date(a.at).toLocaleDateString("en-US")}</time>
                  </div>
                ))}
            </section>
          </div>
          <aside className="stack">
            <section className="panel workspace-pad workspace-export-card">
              <div className="workspace-file-icon">
                <Download size={24} />
              </div>
              <h2>From workspace to Word.</h2>
              <p className="muted">
                Separate, editable documents with native headings, tables, and a
                dynamic table of contents.
              </p>
              <div className="workspace-kicker">DRAFT DOWNLOADS</div>
              <Button
                disabled={exporting}
                onClick={() => void download("technical", false)}
              >
                <FileText size={16} /> Technical DOCX <Download size={14} />
              </Button>
              <Button
                disabled={exporting}
                onClick={() => void download("financial", false)}
              >
                <FileText size={16} /> Financial DOCX <Download size={14} />
              </Button>
              <div className="workspace-kicker workspace-export-label">
                APPROVED CONTENT
              </div>
              <Button
                variant="primary"
                disabled={
                  !approved || !isOwner || !!blockers.length || exporting
                }
                onClick={() => void download("technical", true)}
              >
                Approved technical DOCX
              </Button>
              <Button
                disabled={
                  !approved || !isOwner || !!blockers.length || exporting
                }
                onClick={() => void download("financial", true)}
              >
                Approved financial DOCX
              </Button>
              <p className="small muted">
                Approval is bound to version {p.version}. Downloading does not
                submit a bid.
              </p>
            </section>
            <div className="notice notice-warning">
              <AlertTriangle size={18} />
              <div>
                <strong>One final check in Word</strong>
                <p className="small">
                  Update the entire TOC and all fields, save the document, and
                  inspect each page. Pagination is not calculated in the
                  browser.
                </p>
              </div>
            </div>
            <section className="panel workspace-pad">
              <div className="workspace-kicker">PROPOSED COMMERCIAL TOTAL</div>
              <strong className="workspace-total">
                SAR {money(totals.total)}
              </strong>
              <p className="muted small">
                {totals.errors.length
                  ? "Incomplete financial inputs — not an approved price."
                  : "Includes entered tax. Optional lines excluded."}
              </p>
            </section>
          </aside>
        </div>
      )}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a proposal section"
      >
        <div className="stack">
          <Field label="Section title">
            <input
              autoFocus
              className="input"
              value={sectionTitle}
              onChange={(e) => setSectionTitle(e.target.value)}
              placeholder="For example: Commercial terms"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!sectionTitle.trim()}
            onClick={addSection}
          >
            Add section
          </Button>
        </div>
      </Modal>
      <Modal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        title={`Approve version ${p.version}`}
      >
        <div className="stack">
          <p>
            This records Owner approval of the current proposal content and
            financial inputs. Subsequent edits invalidate this approval.
          </p>
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            I reviewed the RFP coverage, claims, assumptions, pricing,
            commercial terms, and source references for this version.
          </label>
          <Button
            variant="primary"
            disabled={!attested || !!blockers.length}
            onClick={approve}
          >
            Approve this exact version
          </Button>
        </div>
      </Modal>
    </div>
  );
}
function SectionEditor({
  section,
  draftKey,
  disabled,
  language,
  onSave,
}: {
  section: ProposalSection;
  draftKey: string;
  disabled: boolean;
  language: "en" | "ar";
  onSave: (section: ProposalSection) => void;
}) {
  const [storageError, setStorageError] = useState("");
  const loadDraft = () => {
    try {
      return JSON.parse(
        sessionStorage.getItem(`proposal-section-${draftKey}`) || "null",
      ) as { body: string; title: string } | null;
    } catch {
      return null;
    }
  };
  const [body, setBody] = useState(() => loadDraft()?.body ?? section.body);
  const [title, setTitle] = useState(() => loadDraft()?.title ?? section.title);
  const dirty = body !== section.body || title !== section.title;
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(
          `proposal-section-${draftKey}`,
          JSON.stringify({ body, title }),
        );
      else sessionStorage.removeItem(`proposal-section-${draftKey}`);
    } catch {
      setStorageError(
        "Your browser cannot preserve unsaved section edits. Save this section before leaving.",
      );
    }
  }, [body, title, dirty, draftKey]);
  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      const target = event.target as Element;
      if (
        dirty &&
        target.closest("a,.tabs button,.workspace-outline nav button") &&
        !window.confirm(
          "You have unsaved section edits. Leave this editor? Your local draft is preserved on this device.",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <>
      <div className="workspace-paper-toolbar">
        <Badge tone={dirty ? "amber" : "neutral"}>
          {dirty ? "Unsaved changes" : "Current content"}
        </Badge>
        <Button
          size="sm"
          variant="primary"
          disabled={disabled || !dirty || !title.trim()}
          onClick={() => {
            try {
              sessionStorage.removeItem(`proposal-section-${draftKey}`);
            } catch {
              setStorageError(
                "Browser draft storage is unavailable; saving to the workspace instead.",
              );
            }
            onSave({ ...section, title, body });
          }}
        >
          <Save size={14} /> Save section
        </Button>
      </div>
      <div className="workspace-paper-inner">
        {storageError && (
          <p role="alert" className="workspace-error">
            {storageError}
          </p>
        )}
        <input
          aria-label="Section title"
          className="workspace-title-input"
          value={title}
          disabled={disabled}
          onChange={(e) => setTitle(e.target.value)}
          dir={language === "ar" ? "rtl" : "ltr"}
        />
        <div className="workspace-paper-divider" />
        <textarea
          aria-label="Section content"
          className="workspace-body-input"
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          dir={language === "ar" ? "rtl" : "ltr"}
          placeholder="Write the response to this part of the RFP…"
        />
        <div className="workspace-paper-foot">
          <span>{body.trim() ? body.trim().split(/\s+/).length : 0} words</span>
          <span>{section.evidence.length} linked requirement references</span>
        </div>
      </div>
    </>
  );
}
function FinanceEditor({
  proposal,
  disabled,
  onSave,
}: {
  proposal: Proposal;
  disabled: boolean;
  onSave: (patch: Partial<Proposal>) => void;
}) {
  const cacheKey = `proposal-finance-${proposal.id}-${proposal.version}`;
  const [storageError, setStorageError] = useState("");
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      return saved ? ({ ...proposal, ...saved } as Proposal) : proposal;
    } catch {
      return proposal;
    }
  });
  const total = calculateFinance(draft);
  const dirty =
    JSON.stringify([
      draft.lines,
      draft.percentage,
      draft.tax,
      draft.contingency,
      draft.pricingMode,
    ]) !==
    JSON.stringify([
      proposal.lines,
      proposal.percentage,
      proposal.tax,
      proposal.contingency,
      proposal.pricingMode,
    ]);
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(
          cacheKey,
          JSON.stringify({
            lines: draft.lines,
            pricingMode: draft.pricingMode,
            percentage: draft.percentage,
            contingency: draft.contingency,
            tax: draft.tax,
          }),
        );
      else sessionStorage.removeItem(cacheKey);
    } catch {
      setStorageError(
        "Your browser cannot preserve unsaved financial inputs. Save them before leaving.",
      );
    }
  }, [draft, dirty, cacheKey]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const intercept = (event: MouseEvent) => {
      const target = event.target as Element;
      if (
        dirty &&
        target.closest("a,.tabs button") &&
        !window.confirm(
          "You have unsaved financial inputs. Leave this editor? Your local draft is preserved when browser storage is available.",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", intercept, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", intercept, true);
    };
  }, [dirty]);
  function saveFinance() {
    try {
      sessionStorage.removeItem(cacheKey);
    } catch {
      setStorageError(
        "Browser draft storage is unavailable; saving to the workspace instead.",
      );
    }
    onSave({
      lines: draft.lines,
      pricingMode: draft.pricingMode,
      percentage: draft.percentage,
      contingency: draft.contingency,
      tax: draft.tax,
    });
  }
  function line(id: string, key: string, value: string | boolean) {
    setDraft({
      ...draft,
      lines: draft.lines.map((l) => (l.id === id ? { ...l, [key]: value } : l)),
    });
  }
  return (
    <div className="stack">
      <section className="panel workspace-pad">
        <div className="panel-header">
          <div>
            <div className="workspace-kicker">DETERMINISTIC PRICING</div>
            <h2 className="section-title">
              Build the estimate, one input at a time.
            </h2>
            <p className="muted small">
              SAR · decimal arithmetic · an empty field is unknown, not zero
            </p>
          </div>
          <Button
            variant="primary"
            disabled={disabled || !dirty}
            onClick={saveFinance}
          >
            <Save size={15} /> Save financial inputs
          </Button>
        </div>
        {storageError && (
          <p role="alert" className="workspace-error">
            {storageError}
          </p>
        )}
        <div className="table-wrap">
          <table className="data-table workspace-finance-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Quantity</th>
                <th>Unit</th>
                <th>Rate · SAR</th>
                <th>Optional</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <input
                      aria-label="Line description"
                      className="input"
                      value={l.description}
                      disabled={disabled}
                      onChange={(e) =>
                        line(l.id, "description", e.target.value)
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Quantity"
                      className="input"
                      inputMode="decimal"
                      value={l.quantity}
                      disabled={disabled}
                      onChange={(e) => line(l.id, "quantity", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Pricing unit"
                      className="input"
                      value={l.unit}
                      disabled={disabled}
                      onChange={(e) => line(l.id, "unit", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Unit rate"
                      className="input"
                      inputMode="decimal"
                      value={l.rate}
                      disabled={disabled}
                      onChange={(e) => line(l.id, "rate", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Optional line"
                      type="checkbox"
                      checked={l.optional}
                      disabled={disabled}
                      onChange={(e) => line(l.id, "optional", e.target.checked)}
                    />
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${l.description || "pricing line"}`}
                      disabled={disabled}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          lines: draft.lines.filter((item) => item.id !== l.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!draft.lines.length && (
          <p className="muted workspace-pad">
            No pricing lines yet. Add labor, licensing, infrastructure, or other
            costs.
          </p>
        )}
        <Button
          disabled={disabled}
          onClick={() =>
            setDraft({
              ...draft,
              lines: [
                ...draft.lines,
                {
                  id: crypto.randomUUID(),
                  description: "",
                  quantity: "1",
                  unit: "person-day",
                  rate: "",
                  optional: false,
                },
              ],
            })
          }
        >
          <Plus size={15} /> Add line item
        </Button>
      </section>
      <div className="workspace-columns">
        <section className="panel workspace-pad">
          <h2 className="section-title">Commercial assumptions</h2>
          <div className="form-grid">
            <Field label="Pricing method">
              <select
                className="input"
                disabled={disabled}
                value={draft.pricingMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    pricingMode: e.target.value as "markup" | "margin",
                  })
                }
              >
                <option value="markup">Markup on cost</option>
                <option value="margin">Margin on selling price</option>
              </select>
            </Field>
            <Field
              label={`${draft.pricingMode === "markup" ? "Markup" : "Margin"} percentage`}
            >
              <input
                className="input"
                inputMode="decimal"
                value={draft.percentage}
                disabled={disabled}
                onChange={(e) =>
                  setDraft({ ...draft, percentage: e.target.value })
                }
                placeholder="Unconfirmed"
              />
            </Field>
            <Field label="Contingency percentage">
              <input
                className="input"
                inputMode="decimal"
                value={draft.contingency}
                disabled={disabled}
                onChange={(e) =>
                  setDraft({ ...draft, contingency: e.target.value })
                }
                placeholder="Unconfirmed"
              />
            </Field>
            <Field
              label="Tax percentage"
              hint="Enter only a confirmed rate; no rate is assumed."
            >
              <input
                className="input"
                inputMode="decimal"
                value={draft.tax}
                disabled={disabled}
                onChange={(e) => setDraft({ ...draft, tax: e.target.value })}
                placeholder="Unconfirmed"
              />
            </Field>
          </div>
          <div className="notice small">
            This trial applies the entered tax to the complete base net price.
            Record exceptions, recurring duration, offer validity, and payment
            terms in a Commercial terms section. Optional direct costs are
            displayed separately.
          </div>
        </section>
        <section className="panel workspace-pad workspace-totals">
          <div className="workspace-kicker">ESTIMATE SUMMARY</div>
          {[
            ["Direct costs", total.subtotal],
            ["Contingency", total.contingency],
            ["Net selling price", total.net],
            ["Tax", total.tax],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <span>{label}</span>
              <strong>{money(Number(value))}</strong>
            </div>
          ))}
          <div className="workspace-total-row">
            <span>Total · SAR</span>
            <strong>{money(total.total)}</strong>
          </div>
          <div>
            <span>Optional direct cost</span>
            <span>{money(total.optionalTotal)}</span>
          </div>
          <p className="small muted">
            {dirty
              ? "Preview includes unsaved inputs. Save before review."
              : "Calculated from the saved inputs."}
          </p>
        </section>
      </div>
      {total.errors.length > 0 && (
        <section className="notice notice-warning workspace-finance-errors">
          <AlertTriangle size={18} />
          <div>
            <strong>Inputs to confirm before approval</strong>
            <ul>
              {total.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
