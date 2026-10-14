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
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  PageHeader,
} from "../components/ui";
import PricingReview from "../components/PricingReview";
import type { Opportunity, Proposal, ProposalReview } from "../types";
import "./workspace.css";
import "./proposal-review.css";

type ReviewDraft = { answers: Record<string, string>; instructions: string };
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
  instructions: proposal.review?.instructions || "",
});

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
  const { state } = useApp();
  const proposal = state.proposals.find((item) => item.id === id);
  const opportunity = state.opportunities.find(
    (item) => item.id === proposal?.opportunityId,
  );
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
  const { state, update, notify } = useApp();
  const canEdit = state.settings.role !== "Reviewer";
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
        if (
          cached &&
          typeof cached.instructions === "string" &&
          cached.answers &&
          typeof cached.answers === "object" &&
          !Array.isArray(cached.answers) &&
          Object.values(cached.answers).every(
            (value) => typeof value === "string",
          )
        ) {
          const knownContext =
            Number.isInteger(cached.baseVersion) &&
            typeof cached.sourceSignature === "string";
          return {
            draft: {
              answers: cached.answers,
              instructions: cached.instructions,
            } as ReviewDraft,
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
  const questions = getProposalReviewQuestions(proposal, opportunity);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(proposal));
  const staleDraft =
    legacyCache ||
    (dirty &&
      (draftContext.baseVersion !== proposal.version ||
        draftContext.sourceSignature !== currentSignature));
  const stale = isReviewStale(state, proposal, opportunity) || staleDraft;
  const hasInputs =
    !!draft.instructions.trim() ||
    Object.values(draft.answers).some((answer) => answer.trim());
  const readableRfp =
    opportunity.documents.length > 0 &&
    opportunity.documents.every(
      (document) => document.status === "ready" && document.text.trim(),
    );
  const answered = questions.filter((question) =>
    draft.answers[question.id]?.trim(),
  ).length;
  const orphanAnswers = Object.entries(draft.answers).filter(
    ([questionId, answer]) =>
      answer.trim() &&
      !questions.some((question) => question.id === questionId),
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
      if (dirty && canEdit) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, canEdit]);

  function requestChange(text: string) {
    if (canEdit) {
      setDraft((current) => ({
        ...current,
        instructions: [current.instructions.trim(), text]
          .filter(Boolean)
          .join("\n\n"),
      }));
      document.getElementById("proposal-change-request")?.focus();
    }
  }
  function saveReview(regenerate = false): Proposal {
    if (!canEdit) return proposal;
    const savedAt = new Date().toISOString();
    const sourceSignature = getReviewSourceSignature(
      state,
      proposal,
      opportunity,
    );
    const answers = Object.entries(draft.answers).map(
      ([questionId, answer]) => ({ questionId, answer }),
    );
    const review: ProposalReview = {
      baseVersion: proposal.version,
      sourceSignature,
      answers,
      instructions: draft.instructions,
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
            },
          }
        : {}),
    };
    update(
      (current) => ({
        ...current,
        proposals: current.proposals.map((item) =>
          item.id === proposal.id ? { ...item, review } : item,
        ),
      }),
      regenerate
        ? "Saved regeneration request awaiting AI connection"
        : "Saved proposal review inputs",
      proposal.id,
    );
    setDraftContext({ baseVersion: proposal.version, sourceSignature });
    setLegacyCache(false);
    if (!regenerate)
      notify(
        "Review inputs saved in this browser. They have not been applied to the proposal file.",
      );
    return { ...proposal, review };
  }
  async function download() {
    setExporting(true);
    try {
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
          {exporting ? "Preparing Word…" : "Download current Word"}
        </Button>
      </section>
      <p className="review-demo-note">
        AI generation and regeneration are not connected yet. Existing proposal
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
                : "Your review inputs are saved in this browser."}{" "}
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

      <details className="panel review-content">
        <summary>
          <span>Content for review</span>
          <span className="review-summary-meta">
            Saved text · {proposal.sections.length} sections
          </span>
        </summary>
        <div className="review-content-body">
          <p className="small muted">
            This is the saved proposal text, not a preview of the Word file’s
            page layout. Review the downloaded file for final formatting.
          </p>
          {proposal.sections.map((section) => (
            <details className="review-text-section" key={section.id}>
              <summary dir="auto">
                {section.title || "Untitled section"}
              </summary>
              <p dir="auto">
                {section.body || "No content saved for this section."}
              </p>
              <Button
                size="sm"
                disabled={!canEdit}
                onClick={() =>
                  requestChange(
                    `Requested change to “${section.title || "Untitled section"}”: `,
                  )
                }
              >
                Request a change to this section
              </Button>
            </details>
          ))}
          {!proposal.sections.length && (
            <p className="small muted">No saved proposal text is available.</p>
          )}
        </div>
      </details>

      <div className="review-main-grid">
        <section
          className="panel review-questions"
          aria-labelledby="review-questions-title"
        >
          <div className="review-panel-heading">
            <div>
              <span className="workspace-kicker">REVIEW QUESTIONS</span>
              <h2 id="review-questions-title">
                Supply the missing information
              </h2>
              <p>
                Answer the recorded questions. The agent will use these answers
                when regenerating the proposal.
              </p>
            </div>
            <Badge
              tone={
                answered === questions.length && answered > 0
                  ? "green"
                  : "neutral"
              }
            >
              {answered}/{questions.length} answered
            </Badge>
          </div>
          <p className="review-question-origin">
            These questions come from saved gaps, open requirements, pricing
            inputs, and explicit placeholders. Automatic analysis of new RFPs
            will be available with the AI connection.
          </p>
          <div className="review-question-list">
            {questions.map((question) => (
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
                <Field
                  label="Your answer"
                  hint="Add the facts, decision, or approved value the agent should use."
                >
                  <textarea
                    rows={3}
                    dir="auto"
                    readOnly={!canEdit}
                    value={draft.answers[question.id] || ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        answers: {
                          ...current.answers,
                          [question.id]: event.target.value,
                        },
                      }))
                    }
                  />
                </Field>
              </article>
            ))}
            {!questions.length && (
              <div className="review-empty">
                <MessageSquare size={24} />
                <h3>No recorded review questions</h3>
                <p>
                  Automatic completeness review is not connected yet. This does
                  not confirm that the proposal is complete. Add any corrections
                  or missing information in the change request.
                </p>
              </div>
            )}
            {orphanAnswers.length > 0 && (
              <details className="review-retained-answers">
                <summary>
                  Answers retained from earlier questions (
                  {orphanAnswers.length})
                </summary>
                {orphanAnswers.map(([questionId, answer]) => (
                  <div key={questionId}>
                    <strong>{questionId}</strong>
                    <p dir="auto">{answer}</p>
                  </div>
                ))}
              </details>
            )}
          </div>
        </section>
        <aside className="review-request-column">
          <section
            className="panel review-request"
            aria-labelledby="review-request-title"
          >
            <span className="workspace-kicker">YOUR CHANGES</span>
            <h2 id="review-request-title">Tell the agent what to update</h2>
            <p>
              Refer to a heading, table, or requirement. Include any replacement
              wording or decisions the agent needs.
            </p>
            <Field label="Change request">
              <textarea
                id="proposal-change-request"
                rows={9}
                dir="auto"
                readOnly={!canEdit}
                value={draft.instructions}
                placeholder="For example: revise the implementation timeline to 12 weeks, explain the integration assumptions, and update the pricing justification to match the revised effort."
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    instructions: event.target.value,
                  }))
                }
              />
            </Field>
            <Button
              disabled={!canEdit || (!dirty && !stale)}
              onClick={() => saveReview()}
            >
              <Save size={15} /> Save review inputs
            </Button>
            <Button
              variant="primary"
              disabled={!canEdit || !readableRfp || stale}
              onClick={() => {
                saveReview(true);
                setRegenerateOpen(true);
              }}
            >
              <Sparkles size={16} /> Regenerate proposal
            </Button>
            <p className="review-action-help">
              Regeneration will create an updated file version using the RFP,
              company knowledge, your answers, and your change request. It
              requires the AI connection.
            </p>
            {!readableRfp && (
              <p className="review-missing-rfp">
                Upload a readable RFP in the{" "}
                <Link to={`/opportunities/${opportunity.id}`}>
                  linked opportunity
                </Link>{" "}
                before requesting regeneration.
              </p>
            )}
          </section>
        </aside>
      </div>

      <PricingReview
        proposal={proposal}
        opportunity={opportunity}
        onRequestChange={requestChange}
        readOnly={!canEdit}
      />
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
                requestChange(
                  `Please review and incorporate these recovered edits where applicable. Preserve any newer approved facts:\n\n${recovered}`,
                )
              }
            >
              Add recovered edits to change request
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
      <Modal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        title="Regeneration is awaiting the AI connection"
      >
        <p>
          Your answers and change request have been saved in this browser. No AI
          request has been sent and no new file or version has been created.
        </p>
        <p>
          Once connected, the agent will update the complete proposal and its
          pricing from the RFP and your review inputs, then return a new file
          version for review.
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
