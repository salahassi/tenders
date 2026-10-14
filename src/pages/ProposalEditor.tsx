import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Download,
  Eye,
  FileText,
  PenLine,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useApp } from "../lib/store";
import { calculateFinance } from "../lib/finance";
import { exportProposal, proposalFileName } from "../lib/export";
import { downloadAgentInput } from "../lib/agentInput";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageHeader,
} from "../components/ui";
import type { Opportunity, Proposal, ProposalSection } from "../types";
import "./workspace.css";
import "./proposal-files.css";

type EditableContent = Pick<
  Proposal,
  | "title"
  | "sections"
  | "lines"
  | "pricingMode"
  | "percentage"
  | "contingency"
  | "tax"
  | "includePricing"
>;
const contentOf = (proposal: Proposal): EditableContent => ({
  title: proposal.title,
  sections: proposal.sections,
  lines: proposal.lines,
  pricingMode: proposal.pricingMode,
  percentage: proposal.percentage,
  contingency: proposal.contingency,
  tax: proposal.tax,
  includePricing: !!proposal.includePricing,
});
const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function ProposalEditor() {
  const { id } = useParams();
  const { state } = useApp();
  const proposal = state.proposals.find((item) => item.id === id);
  const opportunity = state.opportunities.find(
    (item) => item.id === proposal?.opportunityId,
  );
  if (!proposal || !opportunity)
    return (
      <EmptyState
        title="Proposal not found"
        description="Choose a proposal file from your workspace."
        action={<Link to="/proposals">All proposal files</Link>}
      />
    );
  return (
    <DocumentEditor
      key={proposal.id}
      proposal={proposal}
      opportunity={opportunity}
    />
  );
}

function DocumentEditor({
  proposal,
  opportunity,
}: {
  proposal: Proposal;
  opportunity: Opportunity;
}) {
  const { state, update, notify } = useApp();
  const canEdit = state.settings.role !== "Reviewer";
  const draftKey = `proposal-document-${proposal.id}`;
  const [storageError, setStorageError] = useState("");
  const [draft, setDraft] = useState<EditableContent>(() => {
    if (!canEdit) return contentOf(proposal);
    try {
      const cached = JSON.parse(sessionStorage.getItem(draftKey) || "null") as {
        version: number;
        content: EditableContent;
      } | null;
      if (
        cached?.version === proposal.version &&
        Array.isArray(cached.content?.sections)
      )
        return cached.content;
      // Recover text left in the original section editor before this interface update.
      const sections = proposal.sections.map((section) => {
        const previous = JSON.parse(
          sessionStorage.getItem(
            `proposal-section-${proposal.id}-${section.id}-${proposal.version}`,
          ) || "null",
        );
        return previous &&
          typeof previous.title === "string" &&
          typeof previous.body === "string"
          ? { ...section, title: previous.title, body: previous.body }
          : section;
      });
      return { ...contentOf(proposal), sections };
    } catch {
      return contentOf(proposal);
    }
  });
  const [selected, setSelected] = useState(draft.sections[0]?.id || "");
  const [preview, setPreview] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [sectionTitle, setSectionTitle] = useState("");
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteInstruction, setRewriteInstruction] = useState(
    "Improve the wording and structure while preserving the supplied facts and commitments.",
  );
  const [exporting, setExporting] = useState(false);
  const [removed, setRemoved] = useState<{
    section: ProposalSection;
    index: number;
  } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(contentOf(proposal));
  const currentSection =
    draft.sections.find((section) => section.id === selected) ||
    draft.sections[0];
  const currentIndex = draft.sections.findIndex(
    (section) => section.id === currentSection?.id,
  );
  const workingProposal = { ...proposal, ...draft };
  const pricing = calculateFinance(workingProposal);

  useEffect(() => {
    try {
      if (dirty && canEdit)
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ version: proposal.version, content: draft }),
        );
      else sessionStorage.removeItem(draftKey);
    } catch {
      setStorageError(
        "Your browser cannot preserve unfinished edits in this tab. Save the proposal before leaving this page.",
      );
    }
  }, [draft, dirty, canEdit, draftKey, proposal.version]);
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

  function patch(patch: Partial<EditableContent>) {
    if (canEdit) setDraft((current) => ({ ...current, ...patch }));
  }
  function patchSection(patch: Partial<ProposalSection>) {
    if (!currentSection || !canEdit) return;
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === currentSection.id ? { ...section, ...patch } : section,
      ),
    }));
  }
  function saveDraft(showNotice = true): Proposal {
    if (!dirty || !canEdit) return proposal;
    const saved: Proposal = {
      ...proposal,
      ...draft,
      version: proposal.version + 1,
      status: "draft",
      approvalVersion: null,
      updatedAt: new Date().toISOString(),
    };
    update(
      (current) => ({
        ...current,
        proposals: current.proposals.map((item) =>
          item.id === proposal.id
            ? {
                ...item,
                ...draft,
                version: item.version + 1,
                status: "draft",
                approvalVersion: null,
                updatedAt: saved.updatedAt,
              }
            : item,
        ),
      }),
      "Saved proposal document content",
      proposal.id,
    );
    if (showNotice)
      notify(
        "Proposal saved in this browser. Any previous approval no longer applies to the edited version.",
      );
    return saved;
  }
  async function download() {
    setExporting(true);
    try {
      const latest = saveDraft(false);
      await exportProposal(latest, opportunity, state.settings.companyName);
      notify(
        "Word file downloaded. In Word, update the entire table of contents and all fields, save, and review each page.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "The Word file could not be generated.",
      );
    } finally {
      setExporting(false);
    }
  }
  function addSection() {
    if (!canEdit || !sectionTitle.trim() || draft.sections.length >= 100)
      return;
    const section: ProposalSection = {
      id: crypto.randomUUID(),
      title: sectionTitle.trim(),
      body: "",
      evidence: [],
    };
    patch({ sections: [...draft.sections, section] });
    setSelected(section.id);
    setSectionTitle("");
    setAddOpen(false);
    setPreview(false);
  }
  function moveSection(direction: -1 | 1) {
    if (!canEdit || currentIndex < 0) return;
    const target = currentIndex + direction;
    if (target < 0 || target >= draft.sections.length) return;
    const sections = [...draft.sections];
    [sections[currentIndex], sections[target]] = [
      sections[target],
      sections[currentIndex],
    ];
    patch({ sections });
  }
  function removeSection() {
    if (!canEdit || !currentSection) return;
    setRemoved({ section: currentSection, index: currentIndex });
    patch({
      sections: draft.sections.filter(
        (section) => section.id !== currentSection.id,
      ),
    });
    setSelected(
      draft.sections[currentIndex + 1]?.id ||
        draft.sections[currentIndex - 1]?.id ||
        "",
    );
  }
  function downloadAgent(rewrite = false) {
    try {
      const latest = saveDraft(false);
      downloadAgentInput(
        state,
        opportunity,
        latest,
        rewrite && currentSection
          ? { sectionId: currentSection.id, instruction: rewriteInstruction }
          : undefined,
      );
      notify(
        "Agent input downloaded. It contains extracted RFP text, enabled company files, notes, and this draft. Nothing was sent to an AI service.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Agent input could not be downloaded.",
      );
    }
  }

  return (
    <div className="workspace-page proposal-file-page">
      <Link className="workspace-back" to="/proposals">
        <ArrowLeft size={15} /> Proposal files
      </Link>
      <PageHeader
        eyebrow="PROPOSAL DOCUMENT"
        title={proposal.title || opportunity.title}
        description={`${opportunity.buyer} · ${opportunity.reference} · ${opportunity.language === "ar" ? "Arabic" : "English"}`}
        actions={
          <>
            <Button disabled={!canEdit || !dirty} onClick={() => saveDraft()}>
              <Save size={15} /> Save proposal
            </Button>
            <Button
              variant="primary"
              disabled={
                exporting || (!draft.sections.length && !draft.includePricing)
              }
              onClick={() => void download()}
            >
              <Download size={16} />{" "}
              {exporting ? "Generating Word…" : "Generate Word file"}
            </Button>
          </>
        }
      />
      <div className="proposal-file-summary panel">
        <span className="workspace-file-icon">
          <FileText size={24} />
        </span>
        <div>
          <strong>{proposalFileName(workingProposal, opportunity)}</strong>
          <p>
            One editable Word document · {draft.sections.length} sections ·
            dynamic table of contents
          </p>
        </div>
        <Badge tone={dirty ? "amber" : "green"}>
          {dirty ? "Unsaved changes" : "Saved in browser"}
        </Badge>
      </div>
      <p className="proposal-local-note">
        This is a local document draft. AI drafting and rewriting are not
        connected yet. Edit your text below, then generate the file.
      </p>
      {storageError && (
        <p role="alert" className="workspace-error">
          {storageError}
        </p>
      )}
      {!canEdit && (
        <p className="notice">
          Reviewer mode is read-only. You can preview and download the saved
          document.
        </p>
      )}
      <div className="proposal-tools">
        <div className="proposal-view-switch" aria-label="Document view">
          <Button
            variant={!preview ? "primary" : "ghost"}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            <PenLine size={15} /> Edit content
          </Button>
          <Button
            variant={preview ? "primary" : "ghost"}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            <Eye size={15} /> Preview document
          </Button>
        </div>
        <Link
          className="workspace-text-link"
          to={`/opportunities/${opportunity.id}`}
        >
          RFP & opportunity <ArrowUp size={14} />
        </Link>
      </div>
      {preview ? (
        <DocumentPreview
          proposal={workingProposal}
          opportunity={opportunity}
          companyName={state.settings.companyName}
        />
      ) : (
        <div className="proposal-edit-layout">
          <aside className="panel workspace-outline">
            <div className="workspace-outline-header">
              <span className="workspace-kicker">DOCUMENT SECTIONS</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Add section"
                disabled={!canEdit || draft.sections.length >= 100}
                onClick={() => setAddOpen(true)}
              >
                <Plus size={16} />
              </Button>
            </div>
            <nav aria-label="Proposal sections">
              {draft.sections.map((section, index) => (
                <button
                  type="button"
                  key={section.id}
                  className={currentSection?.id === section.id ? "active" : ""}
                  aria-current={
                    currentSection?.id === section.id ? "true" : undefined
                  }
                  onClick={() => setSelected(section.id)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span dir="auto">{section.title || "Untitled section"}</span>
                </button>
              ))}
            </nav>
            <div className="workspace-outline-footer">
              <p className="small muted">
                Keep only the sections your RFP needs. Rename, reorder, or
                remove any section. Commercial details can be plain text too.
              </p>
              <Button
                size="sm"
                disabled={!canEdit || draft.sections.length >= 100}
                onClick={() => setAddOpen(true)}
              >
                <Plus size={14} /> Add a section
              </Button>
            </div>
          </aside>
          <section
            className="panel proposal-editor-panel"
            aria-label="Proposal section editor"
          >
            <div className="proposal-title-field">
              <Field label="Proposal title">
                <input
                  className="input"
                  dir="auto"
                  value={draft.title}
                  disabled={!canEdit}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </Field>
            </div>
            {currentSection ? (
              <>
                <div className="proposal-section-toolbar">
                  <span className="small muted">
                    Section {currentIndex + 1} of {draft.sections.length}
                  </span>
                  <div className="row">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Move section up"
                      disabled={!canEdit || currentIndex === 0}
                      onClick={() => moveSection(-1)}
                    >
                      <ArrowUp size={16} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Move section down"
                      disabled={
                        !canEdit || currentIndex === draft.sections.length - 1
                      }
                      onClick={() => moveSection(1)}
                    >
                      <ArrowDown size={16} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove section"
                      disabled={!canEdit}
                      onClick={removeSection}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
                <div className="workspace-paper-inner">
                  <Field label="Section title">
                    <input
                      className="workspace-title-input"
                      aria-label="Section title"
                      dir="auto"
                      value={currentSection.title}
                      disabled={!canEdit}
                      onChange={(event) =>
                        patchSection({ title: event.target.value })
                      }
                    />
                  </Field>
                  <div className="workspace-paper-divider" />
                  <textarea
                    className="workspace-body-input"
                    aria-label="Section content"
                    dir={opportunity.language === "ar" ? "rtl" : "auto"}
                    value={currentSection.body}
                    disabled={!canEdit}
                    placeholder="Write or paste what this section needs. Add commercial details here only when requested by the RFP."
                    onChange={(event) =>
                      patchSection({ body: event.target.value })
                    }
                  />
                  <div className="workspace-paper-foot">
                    <span>
                      {currentSection.body.trim()
                        ? currentSection.body.trim().split(/\s+/).length
                        : 0}{" "}
                      words
                    </span>
                    <Button
                      size="sm"
                      disabled={!canEdit || !currentSection.body.trim()}
                      onClick={() => setRewriteOpen(true)}
                    >
                      <Sparkles size={14} /> Rewrite with AI
                    </Button>
                  </div>
                  <p className="small muted proposal-ai-caption">
                    AI is not connected. You can download this section and its
                    context for an agent.
                  </p>
                </div>
              </>
            ) : (
              <EmptyState
                title="Add the sections your RFP needs"
                description="Start with one section, or use the RFP's required response headings. No predefined sections are mandatory."
                action={
                  <Button disabled={!canEdit} onClick={() => setAddOpen(true)}>
                    <Plus size={15} /> Add section
                  </Button>
                }
              />
            )}
          </section>
        </div>
      )}
      {removed && (
        <div className="proposal-undo notice">
          <span>Removed “{removed.section.title}”.</span>
          <Button
            size="sm"
            disabled={!canEdit}
            onClick={() => {
              const sections = [...draft.sections];
              sections.splice(
                Math.min(removed.index, sections.length),
                0,
                removed.section,
              );
              patch({ sections });
              setSelected(removed.section.id);
              setRemoved(null);
            }}
          >
            Undo removal
          </Button>
        </div>
      )}
      <details className="panel proposal-pricing-details">
        <summary>
          Optional pricing table{" "}
          <span>Use only if you need calculated amounts in the file</span>
        </summary>
        <div className="workspace-pad">
          <label className="workspace-check">
            <input
              type="checkbox"
              checked={!!draft.includePricing}
              disabled={!canEdit}
              onChange={(event) =>
                patch({ includePricing: event.target.checked })
              }
            />
            Include a pricing table
          </label>
          <p className="small muted">
            You can also write all financial information in an ordinary section.
            Turning this off keeps the saved values and excludes the calculator
            from the Word file.
          </p>
          {draft.includePricing && (
            <PricingInputs
              proposal={workingProposal}
              disabled={!canEdit}
              onChange={patch}
            />
          )}
        </div>
      </details>
      <div className="proposal-footer-grid">
        <section className="panel workspace-pad">
          <h2 className="section-title">Bring the draft into one file</h2>
          <p className="small muted">
            Generate Word includes every section in the order shown. It saves
            your latest edits automatically. Empty sections stay visible as
            input placeholders.
          </p>
          {draft.includePricing && !pricing.isValid && (
            <p className="small muted">
              Pricing inputs are incomplete. The file will include entered lines
              and a placeholder; incomplete totals are omitted.
            </p>
          )}
          <Button
            variant="primary"
            disabled={
              exporting || (!draft.sections.length && !draft.includePricing)
            }
            onClick={() => void download()}
          >
            <Download size={16} /> Download proposal.docx
          </Button>
          <p className="small muted">
            In Word: select all and update fields, then right-click the table of
            contents → Update Field → Update entire table. Save and check every
            page.
          </p>
        </section>
        <section className="panel workspace-pad">
          <h2 className="section-title">AI agent handoff</h2>
          <p className="small muted">
            Download the RFP text, enabled company files, company notes, and
            this proposal as one JSON package. Extracted text is included;
            original files, images, and page layout are not.
          </p>
          <Button onClick={() => downloadAgent()}>
            <Download size={15} /> Download agent input
          </Button>
          <p className="small muted">
            This only downloads a file. No AI request is sent and no rewrite is
            applied.
          </p>
        </section>
      </div>
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add section"
      >
        <div className="stack">
          <Field label="New section title">
            <input
              autoFocus
              className="input"
              dir="auto"
              value={sectionTitle}
              onChange={(event) => setSectionTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addSection();
              }}
              placeholder="For example: Implementation plan or Commercial terms"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!sectionTitle.trim()}
            onClick={addSection}
          >
            Add to document
          </Button>
        </div>
      </Modal>
      <Modal
        open={rewriteOpen}
        onClose={() => setRewriteOpen(false)}
        title="Rewrite with AI"
      >
        <div className="stack">
          <div className="notice">
            <Sparkles size={19} />
            <p>
              <strong>AI is not connected.</strong> No rewrite will run from
              this frontend. Download the selected section with its RFP and
              company context to use with your agent.
            </p>
          </div>
          <Field label="Rewrite instructions">
            <textarea
              rows={4}
              className="textarea"
              value={rewriteInstruction}
              onChange={(event) => setRewriteInstruction(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!rewriteInstruction.trim()}
            onClick={() => downloadAgent(true)}
          >
            <Download size={15} /> Download agent input
          </Button>
          <p className="small muted">
            The package includes enabled, readable company files and notes.
            Source material must be reviewed for relevance and extraction
            accuracy.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function DocumentPreview({
  proposal,
  opportunity,
  companyName,
}: {
  proposal: Proposal;
  opportunity: Opportunity;
  companyName: string;
}) {
  const pricing = calculateFinance(proposal);
  return (
    <section
      className="proposal-preview-wrap"
      aria-label="Proposal document preview"
    >
      <p className="small muted">
        Content preview — Word determines page breaks and table-of-contents page
        numbers.
      </p>
      <article
        className="proposal-document-preview"
        dir={opportunity.language === "ar" ? "rtl" : "ltr"}
      >
        <header>
          <p className="workspace-kicker" dir="auto">
            {companyName}
          </p>
          <h2 dir="auto">{proposal.title || opportunity.title}</h2>
          <p dir="auto">{opportunity.buyer}</p>
          <p className="small muted">
            {opportunity.reference} · Version {proposal.version} · Working
            document
          </p>
        </header>
        <div className="proposal-preview-contents">
          <h3>{opportunity.language === "ar" ? "المحتويات" : "Contents"}</h3>
          <ol>
            {proposal.sections.map((section) => (
              <li key={section.id} dir="auto">
                {section.title || "Untitled section"}
              </li>
            ))}
            {proposal.includePricing && <li>Pricing schedule</li>}
          </ol>
        </div>
        {proposal.sections.map((section) => (
          <section className="proposal-preview-section" key={section.id}>
            <h3 dir="auto">{section.title || "Untitled section"}</h3>
            <p dir="auto">
              {section.body || "[INPUT REQUIRED: section content]"}
            </p>
          </section>
        ))}
        {proposal.includePricing && (
          <section className="proposal-preview-section">
            <h3>Pricing schedule · SAR</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Quantity</th>
                    <th>Unit cost</th>
                    <th>Included</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.description || "Not entered"}</td>
                      <td>
                        {line.quantity || "—"} {line.unit}
                      </td>
                      <td>{line.rate || "—"}</td>
                      <td>{line.optional ? "Optional" : "Base"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pricing.isValid ? (
              <>
                <p>Base offer excluding tax: SAR {money(pricing.net)}</p>
                <p>
                  Tax: SAR {money(pricing.tax)} · Total: SAR{" "}
                  {money(pricing.total)}
                </p>
              </>
            ) : (
              <p>
                [INPUT REQUIRED: Pricing is incomplete. Totals are omitted.]
              </p>
            )}
          </section>
        )}
      </article>
    </section>
  );
}

function PricingInputs({
  proposal,
  disabled,
  onChange,
}: {
  proposal: Proposal;
  disabled: boolean;
  onChange: (patch: Partial<EditableContent>) => void;
}) {
  const totals = calculateFinance(proposal);
  function line(id: string, key: string, value: string | boolean) {
    onChange({
      lines: proposal.lines.map((item) =>
        item.id === id ? { ...item, [key]: value } : item,
      ),
    });
  }
  return (
    <div className="proposal-pricing-inputs">
      <div className="table-wrap">
        <table className="data-table workspace-finance-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit</th>
              <th>Unit cost · SAR</th>
              <th>Optional</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {proposal.lines.map((item) => (
              <tr key={item.id}>
                <td>
                  <input
                    className="input"
                    aria-label="Line description"
                    value={item.description}
                    disabled={disabled}
                    onChange={(event) =>
                      line(item.id, "description", event.target.value)
                    }
                  />
                </td>
                <td>
                  <input
                    className="input"
                    inputMode="decimal"
                    aria-label="Quantity"
                    value={item.quantity}
                    disabled={disabled}
                    onChange={(event) =>
                      line(item.id, "quantity", event.target.value)
                    }
                  />
                </td>
                <td>
                  <input
                    className="input"
                    aria-label="Pricing unit"
                    value={item.unit}
                    disabled={disabled}
                    onChange={(event) =>
                      line(item.id, "unit", event.target.value)
                    }
                  />
                </td>
                <td>
                  <input
                    className="input"
                    inputMode="decimal"
                    aria-label="Unit rate"
                    value={item.rate}
                    disabled={disabled}
                    onChange={(event) =>
                      line(item.id, "rate", event.target.value)
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Optional line"
                    checked={item.optional}
                    disabled={disabled}
                    onChange={(event) =>
                      line(item.id, "optional", event.target.checked)
                    }
                  />
                </td>
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${item.description || "pricing line"}`}
                    disabled={disabled}
                    onClick={() =>
                      onChange({
                        lines: proposal.lines.filter(
                          (entry) => entry.id !== item.id,
                        ),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        disabled={disabled}
        onClick={() =>
          onChange({
            lines: [
              ...proposal.lines,
              {
                id: crypto.randomUUID(),
                description: "",
                quantity: "1",
                unit: "item",
                rate: "",
                optional: false,
              },
            ],
          })
        }
      >
        <Plus size={15} /> Add line item
      </Button>
      <div className="form-grid proposal-pricing-assumptions">
        <Field label="Pricing method">
          <select
            className="input"
            disabled={disabled}
            value={proposal.pricingMode}
            onChange={(event) =>
              onChange({
                pricingMode: event.target.value as "markup" | "margin",
              })
            }
          >
            <option value="markup">Markup on cost</option>
            <option value="margin">Margin on selling price</option>
          </select>
        </Field>
        {(
          [
            {
              key: "percentage",
              label: `${proposal.pricingMode === "markup" ? "Markup" : "Margin"} percentage`,
            },
            { key: "contingency", label: "Contingency percentage" },
            { key: "tax", label: "Tax percentage" },
          ] as const
        ).map(({ key, label }) => (
          <Field key={key} label={label}>
            <input
              className="input"
              inputMode="decimal"
              value={proposal[key]}
              disabled={disabled}
              placeholder="Enter 0 only when confirmed"
              onChange={(event) => onChange({ [key]: event.target.value })}
            />
          </Field>
        ))}
      </div>
      <p className="small muted">
        The pricing table and assumptions are included in the Word file when
        enabled. Use a free-text commercial section instead if you do not want
        to disclose this cost breakdown.
      </p>
      {totals.isValid ? (
        <p className="proposal-calculated-total">
          Base offer: SAR {money(totals.net)} + tax {money(totals.tax)} ={" "}
          <strong>SAR {money(totals.total)}</strong>
        </p>
      ) : (
        <div className="notice notice-warning">
          <div>
            <strong>Complete these inputs for a calculated total</strong>
            <ul>
              {totals.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
            <p>
              These inputs are optional for the document. Disable the pricing
              table to exclude it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
