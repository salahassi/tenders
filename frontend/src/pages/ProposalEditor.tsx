import ExportPanel from "../components/ExportPanel";
import { createConnectedExport } from "../lib/connectedExport";
import ReviewHistory from "../components/ReviewHistory";
import GenerationPanel from "../components/GenerationPanel";
import PendingProposal from "../components/PendingProposal";
import ApprovalPanel from "../components/ApprovalPanel";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileText,
  MessageSquare,
  Save,
  Sparkles,
} from "lucide-react";
import { useApp } from "../lib/store";
import { exportProposal, proposalFileName } from "../lib/export";
import { downloadAgentInput } from "../lib/agentInput";
import {
  getProposalReviewQuestions,
  getReviewSourceSignature,
  isReviewStale,
} from "../lib/proposalReview";
import { Badge, Button, EmptyState, Modal, PageHeader } from "../components/ui";
import PricingReview from "../components/PricingReview";
import ReviewInput from "../components/ReviewInput";
import type {
  DocumentRecord,
  Opportunity,
  Proposal,
  ProposalReview,
  ProposalSectionChange,
} from "../types";
import "./workspace.css";
import "./proposal-review.css";

type ReviewDraft = {
  answers: Record<string, string>;
  answerAttachments: Record<string, DocumentRecord[]>;
  sectionChanges: Record<string, ProposalSectionChange>;
  instructions: string;
  attachments: DocumentRecord[];
};
type ReviewContext = {
  baseVersion: number | null;
  sourceSignature: string | null;
};
const draftOf = (proposal: Proposal): ReviewDraft => ({
  answers: Object.fromEntries(
    (proposal.review?.answers || []).map(({ questionId, answer }) => [
      questionId,
      answer,
    ]),
  ),
  answerAttachments: Object.fromEntries(
    (proposal.review?.answers || [])
      .filter((answer) => answer.attachments?.length)
      .map(({ questionId, attachments }) => [questionId, attachments!]),
  ),
  sectionChanges: Object.fromEntries(
    (proposal.review?.sectionChanges || []).map((change) => [
      change.sectionId,
      { ...change, attachments: change.attachments || [] },
    ]),
  ),
  instructions: proposal.review?.instructions || "",
  attachments: proposal.review?.attachments || [],
});

function restoredDraft(cached: unknown): ReviewDraft | null {
  if (!cached || typeof cached !== "object") return null;
  const value = cached as Record<string, unknown>;
  if (
    typeof value.instructions !== "string" ||
    !value.answers ||
    typeof value.answers !== "object" ||
    Array.isArray(value.answers) ||
    !Object.values(value.answers).every((answer) => typeof answer === "string")
  )
    return null;
  const validFiles = (files: unknown): files is DocumentRecord[] =>
    Array.isArray(files) &&
    files.every(
      (file) =>
        file &&
        typeof file.id === "string" &&
        typeof file.name === "string" &&
        typeof file.text === "string" &&
        typeof file.hash === "string" &&
        typeof file.size === "number" &&
        typeof file.uploadedAt === "string" &&
        ["ready", "needs_ocr", "needs_processing", "error"].includes(
          file.status,
        ) &&
        ["synthetic", "public", "sanitized", "unspecified"].includes(
          file.classification,
        ),
    );
  const answerAttachments = value.answerAttachments || {};
  const sectionChanges = value.sectionChanges || {};
  const attachments = value.attachments || [];
  if (
    typeof answerAttachments !== "object" ||
    Array.isArray(answerAttachments) ||
    !Object.values(answerAttachments).every(validFiles) ||
    typeof sectionChanges !== "object" ||
    Array.isArray(sectionChanges) ||
    !Object.values(sectionChanges).every(
      (change) =>
        change &&
        typeof change.sectionId === "string" &&
        typeof change.sectionTitle === "string" &&
        typeof change.comment === "string" &&
        (change.attachments === undefined || validFiles(change.attachments)),
    ) ||
    !validFiles(attachments)
  )
    return null;
  return {
    answers: value.answers as Record<string, string>,
    answerAttachments: answerAttachments as Record<string, DocumentRecord[]>,
    sectionChanges: Object.fromEntries(
      Object.entries(sectionChanges).map(([id, change]) => [
        id,
        { ...change, attachments: change.attachments || [] },
      ]),
    ),
    instructions: value.instructions,
    attachments,
  };
}

/** Preserve old local edits for explicit recovery; never apply them to a file. */
function recoverPreviousEdits(proposal: Proposal): string {
  try {
    const notes: string[] = [];
    const cached = JSON.parse(
      sessionStorage.getItem(`proposal-document-${proposal.id}`) || "null",
    );
    if (cached?.content && typeof cached.content === "object") {
      notes.push(
        `Unsaved document edits from version ${cached.version ?? "unknown"}:\n${JSON.stringify(cached.content, null, 2)}`,
      );
    }
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(`proposal-section-${proposal.id}-`)) continue;
      const previous = JSON.parse(sessionStorage.getItem(key) || "null");
      if (previous && typeof previous.body === "string")
        notes.push(
          `Previous section edit (${key}):\n${previous.title || "Untitled"}\n${previous.body}`,
        );
    }
    return notes.join("\n\n");
  } catch {
    return "";
  }
}

export default function ProposalEditor() {
  const { id } = useParams();
  const { state, backend } = useApp();
  const proposal = state.proposals.find((item) => item.id === id);
  const opportunity = state.opportunities.find(
    (item) => item.id === proposal?.opportunityId,
  );
  if (!proposal && backend && id) return <PendingProposal key={id} id={id} />;
  if (!proposal || !opportunity)
    return (
      <EmptyState
        title="Proposal not found"
        description="Choose a proposal linked to an opportunity."
        action={<Link to="/proposals">All proposals</Link>}
      />
    );
  return (
    <ProposalReviewPage
      key={proposal.id}
      proposal={proposal}
      opportunity={opportunity}
    />
  );
}

function ProposalReviewPage({
  proposal,
  opportunity,
}: {
  proposal: Proposal;
  opportunity: Opportunity;
}) {
  const { state, update, notify, mode, backend } = useApp();
  const canEdit =
    mode === "CONNECTED_FREE" || state.settings.role !== "Reviewer";
  const canRegenerate = state.settings.role !== "Reviewer";
  const storageKey = `proposal-review-${proposal.id}`;
  const currentSignature = getReviewSourceSignature(
    state,
    proposal,
    opportunity,
  );
  const [initialReview] = useState(() => {
    if (canEdit) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        const restored = restoredDraft(cached);
        if (restored) {
          const knownContext =
            Number.isInteger(cached.baseVersion) &&
            typeof cached.sourceSignature === "string";
          return {
            draft: restored,
            context: {
              baseVersion: knownContext ? cached.baseVersion : null,
              sourceSignature: knownContext ? cached.sourceSignature : null,
            } as ReviewContext,
            legacyCache: !knownContext,
          };
        }
      } catch {
        /* Saved review inputs remain available below. */
      }
    }
    return {
      draft: draftOf(proposal),
      context: {
        baseVersion: proposal.review?.baseVersion ?? proposal.version,
        sourceSignature: proposal.review?.sourceSignature ?? currentSignature,
      } as ReviewContext,
      legacyCache: false,
    };
  });
  const [draft, setDraft] = useState<ReviewDraft>(initialReview.draft);
  const [draftContext, setDraftContext] = useState<ReviewContext>(
    initialReview.context,
  );
  const [legacyCache, setLegacyCache] = useState(initialReview.legacyCache);
  const [recovered] = useState(() => recoverPreviousEdits(proposal));
  const [storageError, setStorageError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [busyInputs, setBusyInputs] = useState<Record<string, boolean>>({});
  const uploading = Object.values(busyInputs).some(Boolean);
  const setInputBusy = (id: string, busy: boolean) =>
    setBusyInputs((current) =>
      current[id] === busy ? current : { ...current, [id]: busy },
    );
  const questions = getProposalReviewQuestions(proposal, opportunity);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(proposal));
  const staleDraft =
    legacyCache ||
    (dirty &&
      (draftContext.baseVersion !== proposal.version ||
        draftContext.sourceSignature !== currentSignature));
  const stale = isReviewStale(state, proposal, opportunity) || staleDraft;
  const hasAnswer = (questionId: string) =>
    !!draft.answers[questionId]?.trim() ||
    !!draft.answerAttachments[questionId]?.length;
  const hasSectionChange = (sectionId: string) =>
    !!draft.sectionChanges[sectionId]?.comment.trim() ||
    !!draft.sectionChanges[sectionId]?.attachments?.length;
  const hasInputs =
    !!draft.instructions.trim() ||
    !!draft.attachments.length ||
    Object.keys(draft.answers).some(hasAnswer) ||
    Object.keys(draft.answerAttachments).some(hasAnswer) ||
    Object.keys(draft.sectionChanges).some(hasSectionChange);
  const readableRfp =
    opportunity.documents.length > 0 &&
    opportunity.documents.every(
      (document) => document.status === "ready" && document.text.trim(),
    );
  const answered = questions.filter((question) =>
    hasAnswer(question.id),
  ).length;
  const changedSections = Object.keys(draft.sectionChanges).filter(
    hasSectionChange,
  ).length;
  const orphanAnswerIds = [
    ...new Set([
      ...Object.keys(draft.answers),
      ...Object.keys(draft.answerAttachments),
    ]),
  ].filter(
    (questionId) =>
      hasAnswer(questionId) &&
      !questions.some((question) => question.id === questionId),
  );
  const orphanSectionChanges = Object.values(draft.sectionChanges).filter(
    (change) =>
      hasSectionChange(change.sectionId) &&
      !proposal.sections.some((section) => section.id === change.sectionId),
  );

  useEffect(() => {
    if (!canEdit) return;
    try {
      if (dirty || legacyCache)
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ ...draft, ...draftContext }),
        );
      else sessionStorage.removeItem(storageKey);
    } catch {
      setStorageError(
        "Unfinished review inputs cannot be preserved in this tab. Save your review inputs before leaving.",
      );
    }
  }, [draft, draftContext, dirty, legacyCache, canEdit, storageKey]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if ((dirty || uploading) && canEdit) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, uploading, canEdit]);

  function updateSection(
    sectionId: string,
    sectionTitle: string,
    change: Partial<ProposalSectionChange>,
  ) {
    if (!canEdit) return;
    setDraft((current) => ({
      ...current,
      sectionChanges: {
        ...current.sectionChanges,
        [sectionId]: {
          ...(current.sectionChanges[sectionId] || {
            sectionId,
            sectionTitle,
            comment: "",
            attachments: [],
          }),
          ...change,
        },
      },
    }));
  }
  function setAnswer(questionId: string, answer: string) {
    if (!canEdit) return;
    setDraft((current) => ({
      ...current,
      answers: { ...current.answers, [questionId]: answer },
    }));
  }
  function setAnswerFiles(questionId: string, attachments: DocumentRecord[]) {
    if (!canEdit) return;
    setDraft((current) => {
      const answerAttachments = { ...current.answerAttachments };
      if (attachments.length) answerAttachments[questionId] = attachments;
      else delete answerAttachments[questionId];
      return {
        ...current,
        answers: {
          ...current.answers,
          [questionId]: current.answers[questionId] || "",
        },
        answerAttachments,
      };
    });
  }
  async function saveReview(regenerate = false): Promise<Proposal | null> {
    if (!canEdit || uploading || (regenerate && !canRegenerate)) return null;
    const savedAt = new Date().toISOString();
    const sourceSignature = getReviewSourceSignature(
      state,
      proposal,
      opportunity,
    );
    const answers = [
      ...new Set([
        ...Object.keys(draft.answers),
        ...Object.keys(draft.answerAttachments),
      ]),
    ].map((questionId) => ({
      questionId,
      answer: draft.answers[questionId] || "",
      ...(draft.answerAttachments[questionId]?.length
        ? { attachments: draft.answerAttachments[questionId] }
        : {}),
    }));
    const sectionChanges = Object.values(draft.sectionChanges);
    const review: ProposalReview = {
      baseVersion: proposal.version,
      sourceSignature,
      answers,
      instructions: draft.instructions,
      sectionChanges,
      attachments: draft.attachments,
      savedAt,
      ...(regenerate
        ? {
            regeneration: {
              id: crypto.randomUUID(),
              requestedAt: savedAt,
              status: "awaiting_connection" as const,
              baseVersion: proposal.version,
              sourceSignature,
              answers,
              instructions: draft.instructions,
              sectionChanges,
              attachments: draft.attachments,
            },
          }
        : {}),
    };
    if (
      !(await update(
        (current) => ({
          ...current,
          proposals: current.proposals.map((item) =>
            item.id === proposal.id ? { ...item, review } : item,
          ),
        }),
        regenerate
          ? "Recorded proposal regeneration request"
          : "Saved proposal review inputs",
        proposal.id,
      ))
    ) {
      return null;
    }
    setDraftContext({ baseVersion: proposal.version, sourceSignature });
    setLegacyCache(false);
    if (!regenerate)
      notify(
        "Review inputs saved. They have not been applied to the proposal file.",
      );
    return { ...proposal, review };
  }
  async function download() {
    setExporting(true);
    try {
      if (backend && proposal.versionId)
        await createConnectedExport(backend, proposal.versionId, "draft");
      else
        await exportProposal(proposal, opportunity, state.settings.companyName);
      notify(
        "Current Word content downloaded. Review inputs are not included. In Word, update all fields and the entire table of contents, then review the pages.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "The Word file could not be downloaded.",
      );
    } finally {
      setExporting(false);
    }
  }
  function downloadAgent() {
    try {
      downloadAgentInput(state, opportunity, proposal);
      notify(
        "Saved agent input downloaded. Nothing was sent to an AI service. Unsaved review inputs are not included.",
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
    <div className="workspace-page proposal-review-page">
      <Link className="workspace-back" to="/proposals">
        <ArrowLeft size={15} /> Proposal files
      </Link>
      <Link className="text-link" to={`/jobs?proposal=${proposal.id}`}>
        Model activity for this proposal →
      </Link>
      <PageHeader
        eyebrow="REVIEW & REGENERATE"
        title={proposal.title || opportunity.title}
        description={`${opportunity.buyer} · ${opportunity.reference}`}
      />
      <section
        className="panel review-current-file"
        aria-label="Current proposal file"
      >
        <span className="review-file-icon">
          <FileText size={28} />
        </span>
        <div className="review-file-info">
          <span className="workspace-kicker">
            CURRENT SAVED CONTENT · VERSION {proposal.version}
          </span>
          <h2>{proposalFileName(proposal, opportunity)}</h2>
          <p>
            Download the Word document to review its actual pages, tables, and
            formatting.
          </p>
          <Link
            className="workspace-text-link"
            to={`/opportunities/${opportunity.id}`}
          >
            Source RFP & opportunity <ArrowUpRight size={14} />
          </Link>
        </div>
        <Button
          disabled={
            exporting || (!proposal.sections.length && !proposal.includePricing)
          }
          onClick={() => void download()}
        >
          <Download size={16} />
          {exporting ? "Preparing Word…" : "Download complete draft Word"}
        </Button>
      </section>
      {backend && (
        <GenerationPanel opportunity={opportunity} showOpenLink={false} />
      )}
      <p className="review-demo-note">
        {mode === "CONNECTED_FREE"
          ? "Generation runs through your configured backend. Existing proposal"
          : "AI generation and regeneration are not connected yet. Existing proposal"}
        content is preserved; new answers and requests remain pending until the
        agent creates a new version.
      </p>
      {(hasInputs || proposal.review?.regeneration) && (
        <div className="notice notice-warning review-pending" role="status">
          <MessageSquare size={18} />
          <div>
            <strong>Review inputs have not been applied to the file.</strong>
            <p>
              {dirty
                ? "You have unsaved review inputs."
                : "Your review inputs are saved in your workspace."}{" "}
              The current document is still version {proposal.version}.
              {proposal.review?.regeneration &&
                " The regeneration request is saved locally, awaiting the AI connection."}
            </p>
          </div>
        </div>
      )}
      {stale && (
        <div className="notice notice-warning" role="alert">
          {legacyCache
            ? "Recovered review inputs do not record which proposal version and sources they used."
            : "The proposal or its source material changed after these review inputs were prepared."}{" "}
          Check your answers against the current RFP and save them again before
          regeneration.
        </div>
      )}
      {storageError && (
        <p role="alert" className="workspace-error">
          {storageError}
        </p>
      )}
      {!canEdit && (
        <p className="notice">
          Reviewer mode is read-only. You can read the proposal, saved review
          inputs, and download the current Word document.
        </p>
      )}

      <details className="panel review-content" open>
        <summary>
          <span>Content for review</span>
          <span className="review-summary-meta">
            {proposal.sections.length} sections · {changedSections} with review
            inputs
          </span>
        </summary>
        <div className="review-content-body">
          <p>
            Review the saved proposal text and leave comments or attach files
            under each section. All your section comments and answers will be
            used together when you regenerate.
          </p>
          <p className="small muted">
            The saved text below is not a preview of the Word file’s page
            layout. Download the current Word to review its formatting.
          </p>
          {proposal.sections.map((section) => {
            const title = section.title || "Untitled section";
            const change = draft.sectionChanges[section.id];
            const inputId = `section-review-${section.id}`;
            return (
              <article
                className="review-text-section"
                key={section.id}
                aria-labelledby={`review-section-title-${section.id}`}
              >
                <div className="review-section-heading">
                  <h3 id={`review-section-title-${section.id}`} dir="auto">
                    {title}
                  </h3>
                  {hasSectionChange(section.id) && (
                    <Badge tone="blue">Review inputs added</Badge>
                  )}
                </div>
                <details className="review-saved-section" open>
                  <summary>Saved content</summary>
                  <p dir="auto">
                    {section.body || "No content saved for this section."}
                  </p>
                </details>
                <ReviewInput
                  id={inputId}
                  label={`Comments on ${title}`}
                  value={change?.comment || ""}
                  onChange={(comment) =>
                    updateSection(section.id, title, { comment })
                  }
                  attachments={change?.attachments || []}
                  onAttachmentsChange={(attachments) =>
                    updateSection(section.id, title, { attachments })
                  }
                  readOnly={!canEdit}
                  placeholder="Describe what should change in this section, attach supporting files, or do both."
                  rows={3}
                  onBusyChange={(busy) => setInputBusy(inputId, busy)}
                />
              </article>
            );
          })}
          {!proposal.sections.length && (
            <p className="small muted">No saved proposal text is available.</p>
          )}
          {proposal.lines.length > 0 && (
            <PricingReview proposal={proposal} opportunity={opportunity} />
          )}
          {orphanSectionChanges.length > 0 && (
            <details className="review-retained-inputs">
              <summary>
                Comments retained from earlier sections (
                {orphanSectionChanges.length})
              </summary>
              <p>
                These sections are no longer in the current proposal. Their
                comments and files are preserved for you to review before
                regeneration.
              </p>
              {orphanSectionChanges.map((change) => {
                const inputId = `retained-section-${change.sectionId}`;
                return (
                  <ReviewInput
                    key={change.sectionId}
                    id={inputId}
                    label={`Comments on ${change.sectionTitle || "Earlier section"}`}
                    value={change.comment}
                    onChange={(comment) =>
                      updateSection(change.sectionId, change.sectionTitle, {
                        comment,
                      })
                    }
                    attachments={change.attachments || []}
                    onAttachmentsChange={(attachments) =>
                      updateSection(change.sectionId, change.sectionTitle, {
                        attachments,
                      })
                    }
                    readOnly={!canEdit}
                    onBusyChange={(busy) => setInputBusy(inputId, busy)}
                  />
                );
              })}
            </details>
          )}
        </div>
      </details>

      <section
        className="panel review-questions"
        aria-labelledby="review-questions-title"
      >
        <div className="review-panel-heading">
          <div>
            <span className="workspace-kicker">REVIEW QUESTIONS</span>
            <h2 id="review-questions-title">Supply the missing information</h2>
            <p>
              For each question, enter an answer, attach supporting files, or do
              both. There is no need to save each answer separately.
            </p>
          </div>
          <Badge
            tone={
              answered === questions.length && answered > 0
                ? "green"
                : "neutral"
            }
          >
            {answered}/{questions.length} responses added
          </Badge>
        </div>
        <p className="review-question-origin">
          These questions come from saved gaps, open requirements, pricing
          inputs, and explicit placeholders. Automatic analysis of new RFPs will
          be available with the AI connection.
        </p>
        <div className="review-question-list">
          {questions.map((question) => {
            const inputId = `question-review-${question.id}`;
            return (
              <article className="review-question" key={question.id}>
                <h3 dir="auto">{question.question}</h3>
                <p dir="auto">{question.reason}</p>
                <dl>
                  <div>
                    <dt>Source</dt>
                    <dd dir="auto">{question.source}</dd>
                  </div>
                  <div>
                    <dt>Affects</dt>
                    <dd dir="auto">{question.target}</dd>
                  </div>
                </dl>
                {question.existingAnswer && (
                  <p className="review-existing-answer" dir="auto">
                    <strong>Previously recorded: </strong>
                    {question.existingAnswer}
                  </p>
                )}
                <ReviewInput
                  id={inputId}
                  label="Your answer"
                  value={draft.answers[question.id] || ""}
                  onChange={(answer) => setAnswer(question.id, answer)}
                  attachments={draft.answerAttachments[question.id] || []}
                  onAttachmentsChange={(attachments) =>
                    setAnswerFiles(question.id, attachments)
                  }
                  readOnly={!canEdit}
                  placeholder="Add the facts, decision, or approved value the agent should use, or attach a file."
                  rows={3}
                  onBusyChange={(busy) => setInputBusy(inputId, busy)}
                />
              </article>
            );
          })}
          {!questions.length && (
            <div className="review-empty">
              <MessageSquare size={24} />
              <h3>No recorded review questions</h3>
              <p>
                Automatic completeness review is not connected yet. This does
                not confirm that the proposal is complete. Add any corrections
                under the relevant section.
              </p>
            </div>
          )}
          {orphanAnswerIds.length > 0 && (
            <details className="review-retained-inputs">
              <summary>
                Answers retained from earlier questions (
                {orphanAnswerIds.length})
              </summary>
              <p>
                These questions are no longer listed above. Their answers and
                files remain attached to the earlier question.
              </p>
              {orphanAnswerIds.map((questionId) => {
                const inputId = `retained-question-${questionId}`;
                return (
                  <ReviewInput
                    key={questionId}
                    id={inputId}
                    label={`Earlier answer · ${questionId}`}
                    value={draft.answers[questionId] || ""}
                    onChange={(answer) => setAnswer(questionId, answer)}
                    attachments={draft.answerAttachments[questionId] || []}
                    onAttachmentsChange={(attachments) =>
                      setAnswerFiles(questionId, attachments)
                    }
                    readOnly={!canEdit}
                    onBusyChange={(busy) => setInputBusy(inputId, busy)}
                  />
                );
              })}
            </details>
          )}
        </div>
      </section>
      <details
        className="panel review-additional"
        open={!!draft.instructions || !!draft.attachments.length}
      >
        <summary>
          Additional comments{" "}
          <span className="review-summary-meta">
            Optional · applies to the whole proposal
          </span>
        </summary>
        <div className="review-content-body">
          <p>
            Use this only for changes that apply across the proposal. Existing
            general change requests are preserved here.
          </p>
          <ReviewInput
            id="proposal-additional-comments"
            label="Additional comments"
            value={draft.instructions}
            onChange={(instructions) =>
              setDraft((current) => ({ ...current, instructions }))
            }
            attachments={draft.attachments}
            onAttachmentsChange={(attachments) =>
              setDraft((current) => ({ ...current, attachments }))
            }
            readOnly={!canEdit}
            placeholder="Add a proposal-wide instruction or supporting file."
            rows={4}
            onBusyChange={(busy) => setInputBusy("additional", busy)}
          />
        </div>
      </details>
      {recovered && (
        <details className="panel review-recovered">
          <summary>Unsaved edits recovered from the previous editor</summary>
          <div className="review-content-body">
            <p>
              Your previous edits are still preserved in this tab. They have not
              been applied to the current file. Review them before asking the
              agent to incorporate them.
            </p>
            <textarea
              aria-label="Recovered previous edits"
              rows={8}
              readOnly
              dir="auto"
              value={recovered}
            />
            <Button
              disabled={!canEdit}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  instructions: [
                    current.instructions.trim(),
                    `Please review and incorporate these recovered edits where applicable. Preserve any newer approved facts:\n\n${recovered}`,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                }))
              }
            >
              Add recovered edits to additional comments
            </Button>
          </div>
        </details>
      )}
      <details className="panel review-advanced">
        <summary>Advanced details</summary>
        <div className="review-content-body">
          <h3>Agent input package</h3>
          <p>
            This downloads the saved source text, company context, proposal
            content, and saved review inputs for inspection. Pending review
            inputs have not been applied to the Word file. Save unfinished
            answers first; downloading does not contact an AI service.
          </p>
          <Button onClick={downloadAgent}>
            <Download size={15} /> Download agent input
          </Button>
        </div>
      </details>
      <section
        className="panel review-actions"
        aria-label="Save or regenerate all review inputs"
      >
        <div className="review-actions-status">
          <strong>
            {uploading
              ? "Attaching files…"
              : dirty
                ? "Unsaved review inputs"
                : stale
                  ? "Review inputs need reconfirmation"
                  : hasInputs
                    ? "All review inputs saved"
                    : "Ready for your review"}
          </strong>
          <p>
            {changedSections} section{changedSections === 1 ? "" : "s"} with
            comments or files · {answered}/{questions.length} responses added
          </p>
          <p>
            Save to continue later, or regenerate once to include all section
            comments, answers, and attachments.
          </p>
        </div>
        <div className="review-action-buttons">
          <Button
            disabled={!canEdit || uploading || (!dirty && !stale)}
            onClick={() => saveReview()}
          >
            <Save size={15} /> Save review inputs
          </Button>
          <Button
            variant="primary"
            disabled={
              !canEdit || !canRegenerate || uploading || !readableRfp || stale
            }
            onClick={async () => {
              if (!(await saveReview(true))) return;
              setRegenerateOpen(true);
            }}
          >
            <Sparkles size={16} /> Regenerate proposal
          </Button>
        </div>
        {!readableRfp && (
          <p className="review-missing-rfp">
            Upload a readable RFP in the{" "}
            <Link to={`/opportunities/${opportunity.id}`}>
              linked opportunity
            </Link>{" "}
            before requesting regeneration.
          </p>
        )}
        <p className="review-action-help">
          Regenerate saves all your review inputs together. Applying them and
          creating a new file requires the AI connection; the current file stays
          unchanged until then.
        </p>
      </section>
      <ReviewHistory proposalId={proposal.id} />
      <details className="panel simple-section">
        <summary>Final approval and submission files</summary>
        <p>
          You can download the complete draft above at any time. Use these
          controls when the content, prices and delivery commitments are ready
          for final approval.
        </p>
        <ApprovalPanel proposal={proposal} />
        <ExportPanel proposal={proposal} />
      </details>
      <Modal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        title={
          mode === "CONNECTED_FREE"
            ? "Regeneration request recorded"
            : "Regeneration is awaiting the AI connection"
        }
      >
        <p>
          {mode === "CONNECTED_FREE"
            ? "Your review inputs are saved in your workspace. Follow processing progress on the linked opportunity. The current version remains available until the new version completes."
            : "Your answers, section comments, and attachments have been saved together in this browser. No AI request has been sent and no new file or version has been created."}
        </p>
        <p>
          The agent uses the confirmed RFP and saved review inputs to prepare a
          new version. Missing model configuration, data authorization or quota
          appears as a blocker in processing progress.
        </p>
        <div className="modal-footer">
          <Button variant="primary" onClick={() => setRegenerateOpen(false)}>
            Back to review
          </Button>
        </div>
      </Modal>
    </div>
  );
}
