import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store";
import { Button } from "./ui";
import { isSelected } from "../lib/workflow";
import type { DocumentRecord, Opportunity } from "../types";
import { BackendRequestError } from "../lib/backendClient";
import {
  generationNeedsAttention,
  generationStageLabel,
  generationStatusMessage,
  type ProposalIssuanceStatus,
} from "../lib/generationStatus";
type Plan = {
  id: string;
  kind: string;
  stage: string;
  status: string;
  revision: number;
  error_code: string | null;
  created_at: string;
  issuance_request_id?: string | null;
  issuance?: ProposalIssuanceStatus | null;
};
export default function GenerationPanel({
  opportunity,
  embedded = false,
  onReviewFile,
  showOpenLink = true,
  inputBusy = false,
}: {
  opportunity: Opportunity;
  embedded?: boolean;
  onReviewFile?: (file: DocumentRecord) => void;
  showOpenLink?: boolean;
  inputBusy?: boolean;
}) {
  const { backend, runCommand, state, saving, notify, refresh } = useApp(),
    [plans, setPlans] = useState<Plan[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [requesting, setRequesting] = useState(false),
    loadScope = useRef({
      active: true,
      busy: false,
      completed: "",
      attention: "",
    });
  const editable = state.settings.role !== "Reviewer";
  const planKind = isSelected(opportunity) ? "proposal" : "assessment";
  async function load() {
    const scope = loadScope.current;
    if (!backend || !scope.active || scope.busy) return;
    scope.busy = true;
    try {
      const records = await backend.list<Plan>("generation-plans", {
        opportunity: opportunity.id,
      });
      if (!scope.active) return;
      const ordered = [...records].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      await Promise.all(
        ordered
          .filter((p) => p.kind === planKind)
          .slice(0, 3)
          .map(async (p) => {
            if (!p.issuance_request_id) return;
            const { data } =
              await backend.request<ProposalIssuanceStatus | null>(
                `/v1/proposal-issuance/${p.id}`,
              );
            if (
              !data ||
              data.id !== p.issuance_request_id ||
              data.plan_id !== p.id
            )
              throw new Error(
                "The current request changed. Refresh progress to load its file-package status.",
              );
            p.issuance = data;
          }),
      );
      if (!scope.active) return;
      setPlans(ordered);
      const latestVisible = ordered.find((p) => p.kind === planKind);
      const attention =
        latestVisible && generationNeedsAttention(latestVisible)
          ? `${latestVisible.id}:${latestVisible.status}:${latestVisible.issuance?.effective_error_code ?? latestVisible.error_code}`
          : "";
      if (attention && scope.attention !== attention)
        notify(generationStatusMessage(latestVisible!), "error");
      scope.attention = attention;
      const latest = ordered.find((p) => p.kind === "proposal");
      const completedKey = latest
        ? `${latest.id}:${latest.issuance?.effective_outcome ?? latest.status}`
        : "";
      if (
        (latest?.status === "completed" ||
          latest?.issuance?.effective_outcome === "issued") &&
        scope.completed !== completedKey
      ) {
        await refresh?.();
        if (!scope.active) return;
        scope.completed = completedKey;
      }
      setError("");
      return latestVisible;
    } catch (e) {
      if (scope.active)
        setError(e instanceof Error ? e.message : "Cannot load progress.");
    } finally {
      scope.busy = false;
      if (scope.active) setLoading(false);
    }
  }
  useEffect(() => {
    const scope = {
      active: true,
      busy: false,
      completed: "",
      attention: "",
    };
    loadScope.current = scope;
    setLoading(true);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      scope.active = false;
      clearInterval(timer);
    };
  }, [backend, opportunity.id, planKind]);
  async function action(operation: string, input: Record<string, unknown>) {
    setRequesting(true);
    try {
      await runCommand!(operation, input);
      const latest = await load();
      if (!latest || !generationNeedsAttention(latest))
        notify(
          operation === "generation.cancel"
            ? "Request canceled. Saved results are retained."
            : "Processing requested. You can leave this page; work continues automatically.",
        );
    } catch (e) {
      const message =
        e instanceof BackendRequestError && e.code === "STALE_INPUT"
          ? "The saved inputs changed. Your completed work is retained. Automatic resume is available only when writing and review are complete and the notice is the only changed input. Review the changed evidence before starting an updated version."
          : e instanceof BackendRequestError &&
              [
                "DATA_AUTHORIZATION_REQUIRED",
                "DATA_POLICY_BLOCKED",
                "MODEL_NOT_CONFIGURED",
                "AI_AGENTS_UNAVAILABLE",
                "PROPOSAL_ISSUANCE_TIMEOUT",
              ].includes(e.code)
            ? generationStatusMessage({
                kind: "proposal",
                status: "blocked",
                error_code: e.code,
              })
            : e instanceof Error
              ? e.message
              : "The request failed.";
      setError(message);
      notify(message, "error");
    } finally {
      setRequesting(false);
    }
  }
  if (!backend || !runCommand) return null;
  const selected = isSelected(opportunity),
    linked = state.proposals.find((p) => p.opportunityId === opportunity.id),
    pendingReview = opportunity.documents.find(
      (d) => d.status === "ready" && !d.extractionConfirmed,
    ),
    busy = saving || requesting || inputBusy,
    Panel = embedded ? "div" : "section";
  const active = plans.find(
      (p) =>
        p.kind === "proposal" &&
        ["queued", "running", "blocked"].includes(p.status),
    ),
    assessment = plans.find(
      (p) =>
        p.kind === "assessment" &&
        ["queued", "running", "blocked"].includes(p.status),
    );
  return (
    <Panel className={embedded ? "stack" : "panel simple-section"}>
      <h3>{selected ? "Proposal preparation" : "Assessment progress"}</h3>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading progress…</p>
      ) : (
        <>
          <div className="simple-inline-actions">
            {!selected && (
              <Button
                disabled={!editable || busy || !!assessment}
                onClick={() =>
                  action("opportunity.assess", {
                    id: opportunity.id,
                    expected_revision: opportunity.revision,
                  })
                }
              >
                Assess current evidence
              </Button>
            )}
            {selected && !linked?.versionId && (
              <Button
                variant="primary"
                disabled={
                  !editable ||
                  busy ||
                  !!active ||
                  opportunity.status !== "shortlisted" ||
                  !opportunity.documents.length
                }
                onClick={() =>
                  action("proposal.generate", {
                    id: opportunity.id,
                    expected_revision: opportunity.revision,
                  })
                }
              >
                {requesting
                  ? "Starting preparation…"
                  : "Generate proposal draft"}
              </Button>
            )}
            {selected && pendingReview && onReviewFile && (
              <Button
                disabled={!editable || busy}
                onClick={() => onReviewFile(pendingReview)}
              >
                Check extracted text: {pendingReview.name}
              </Button>
            )}
            {showOpenLink && linked?.versionId && (
              <Link className="btn btn-primary" to={`/proposals/${linked.id}`}>
                Open proposal and download Word
              </Link>
            )}
          </div>
          {selected && !linked?.versionId && (
            <p className="simple-note">
              {inputBusy
                ? "Files are still being saved. Draft creation will be available when the upload finishes."
                : active
                  ? active.status === "blocked"
                    ? "Preparation is paused. Review the reason below, then resume the saved work."
                    : "Your proposal is being prepared. Completed steps are saved, and temporary provider failures retry automatically."
                  : !opportunity.documents.length
                    ? "Attach a reference document to begin. It can be an RFP, brief, existing proposal or another useful file."
                    : opportunity.documents.some((d) => d.status !== "ready")
                      ? "You can create a draft now. Files without readable text will be listed as unread; the draft uses the available text and opportunity details."
                      : pendingReview
                        ? "You can create a draft now. Checking the extracted text is optional; incomplete or conflicting inputs will be flagged for review."
                        : "Ready to draft from your reference documents, even if they are not an RFP. No custom template or company knowledge is required. Missing information will be flagged for review."}
            </p>
          )}
          {plans
            .filter((p) => p.kind === (selected ? "proposal" : "assessment"))
            .slice(0, 3)
            .map((p) => (
              <div className="admin-muted-surface" key={p.id}>
                <strong>
                  {p.kind === "proposal" ? "Proposal" : "Fit assessment"} ·{" "}
                  {generationStageLabel(p.stage)}
                </strong>
                <p
                  role={
                    generationNeedsAttention(p) &&
                    !error &&
                    plans.find((plan) => plan.kind === p.kind)?.id === p.id
                      ? "alert"
                      : undefined
                  }
                  className={
                    generationNeedsAttention(p) ? "admin-error" : undefined
                  }
                >
                  {generationStatusMessage(p)}
                </p>
                {(p.issuance?.effective_error_code || p.error_code) && (
                  <details>
                    <summary>Technical details</summary>
                    <p>
                      Reference code:{" "}
                      <code>
                        {p.issuance?.effective_error_code || p.error_code}
                      </code>
                    </p>
                  </details>
                )}
                {["MODEL_NOT_CONFIGURED", "AI_AGENTS_UNAVAILABLE"].includes(
                  p.issuance?.effective_error_code || p.error_code || "",
                ) && (
                  <p>
                    <Link to="/settings?section=models">Set up a model</Link>
                  </p>
                )}
                {["blocked", "failed", "canceled"].includes(p.status) &&
                  !plans.some(
                    (newer) =>
                      newer.kind === p.kind &&
                      newer.created_at > p.created_at &&
                      ["queued", "running", "blocked", "completed"].includes(
                        newer.status,
                      ),
                  ) &&
                  !(
                    p.error_code === "STALE_INPUT" &&
                    !(
                      p.kind === "proposal" &&
                      ["review", "reconciliation"].includes(p.stage)
                    )
                  ) &&
                  ![
                    "REASSESSMENT_SUPERSEDED",
                    "NOTICE_DETAILS_REFRESHED",
                    "NOTICE_DETAILS_REQUIRED",
                  ].includes(p.error_code || "") && (
                    <Button
                      disabled={!editable || busy}
                      onClick={() =>
                        action("generation.retry", {
                          id: p.id,
                          expected_revision: p.revision,
                          reason:
                            "User requested continuation of the saved work.",
                        })
                      }
                    >
                      Resume saved work
                    </Button>
                  )}
                {[
                  "STALE_INPUT",
                  "REASSESSMENT_SUPERSEDED",
                  "NOTICE_DETAILS_REFRESHED",
                  "NOTICE_DETAILS_REQUIRED",
                ].includes(p.error_code || "") && (
                  <p>
                    {p.kind === "proposal"
                      ? "Evidence changed. Completed writing and review can be recovered as an earlier draft if only the notice changed. Other changes need an updated version; final approval requires current evidence."
                      : "Evidence changed. Use a current assessment."}
                  </p>
                )}
                {["queued", "running", "blocked"].includes(p.status) && (
                  <Button
                    disabled={!editable || busy}
                    onClick={() =>
                      action("generation.cancel", {
                        id: p.id,
                        expected_revision: p.revision,
                        reason: "User canceled this generation plan.",
                      })
                    }
                  >
                    Cancel plan
                  </Button>
                )}
              </div>
            ))}
          <p className="simple-note">
            Completed steps are saved. Temporary model failures retry
            automatically; requests that stop show their reason and recovery
            action here.{" "}
            <Link to={`/jobs?opportunity=${opportunity.id}`}>
              View attempts and details
            </Link>
            .
          </p>
        </>
      )}
    </Panel>
  );
}
