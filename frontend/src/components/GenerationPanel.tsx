import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store";
import { Button } from "./ui";
import type { Opportunity } from "../types";
type Plan = {
  id: string;
  kind: string;
  stage: string;
  status: string;
  revision: number;
  error_code: string | null;
  created_at: string;
};
export default function GenerationPanel({
  opportunity,
}: {
  opportunity: Opportunity;
}) {
  const { backend, runCommand, state, saving, notify } = useApp(),
    [plans, setPlans] = useState<Plan[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const editable = state.settings.role !== "Reviewer";
  async function load() {
    if (!backend) return;
    try {
      const records = await backend.list<Plan>("generation-plans", {
        opportunity: opportunity.id,
      });
      setPlans(
        records.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot load progress.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [backend, opportunity.id]);
  async function action(operation: string, input: Record<string, unknown>) {
    try {
      await runCommand!(operation, input);
      await load();
      notify("Request recorded. Follow its actual status below.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    }
  }
  if (!backend || !runCommand) return null;
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
    <section className="panel simple-section">
      <h2>Processing progress</h2>
      <p>
        Each completed step is saved. Your active proposal stays available while
        a new version is prepared. A blocked task needs the reason below to be
        resolved.
      </p>
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
            <Button
              disabled={!editable || saving || !!assessment}
              onClick={() =>
                action("opportunity.assess", {
                  id: opportunity.id,
                  expected_revision: opportunity.revision,
                })
              }
            >
              Assess current evidence
            </Button>
            {!state.proposals.some(
              (p) => p.opportunityId === opportunity.id,
            ) && (
              <Button
                variant="primary"
                disabled={
                  !editable ||
                  saving ||
                  !!active ||
                  opportunity.status !== "shortlisted" ||
                  !opportunity.documents.length ||
                  opportunity.documents.some(
                    (d) => d.status !== "ready" || !d.extractionConfirmed,
                  )
                }
                onClick={() =>
                  action("proposal.generate", {
                    id: opportunity.id,
                    expected_revision: opportunity.revision,
                  })
                }
              >
                Generate complete proposal
              </Button>
            )}
          </div>
          <p>
            Confirm the extracted text of every RFP file. Review model and
            content permissions in{" "}
            <Link to="/settings">Workspace settings</Link>.
          </p>
          {plans.slice(0, 10).map((p) => (
            <div className="admin-muted-surface" key={p.id}>
              <strong>
                {p.kind === "proposal" ? "Proposal" : "Fit assessment"} ·{" "}
                {p.stage}
              </strong>
              <p>
                {p.status}
                {p.error_code
                  ? ` · ${p.error_code.replaceAll("_", " ").toLowerCase()}`
                  : ""}
              </p>
              {["blocked", "failed", "canceled"].includes(p.status) &&
                ![
                  "STALE_INPUT",
                  "REASSESSMENT_SUPERSEDED",
                  "NOTICE_DETAILS_REFRESHED",
                  "NOTICE_DETAILS_REQUIRED",
                ].includes(p.error_code || "") && (
                  <Button
                    disabled={!editable || saving}
                    onClick={() =>
                      action("generation.retry", {
                        id: p.id,
                        expected_revision: p.revision,
                        reason:
                          "User reviewed the blocker and requested resume.",
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
                  Evidence changed. Use a current assessment or request a new
                  proposal version.
                </p>
              )}
              {["queued", "running", "blocked"].includes(p.status) && (
                <Button
                  disabled={!editable || saving}
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
          {!plans.length && <p>No processing plan has been requested.</p>}
        </>
      )}
    </section>
  );
}
