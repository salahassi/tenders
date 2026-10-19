import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Download, FileText, Search } from "lucide-react";
import { useApp } from "../lib/store";
import { exportProposal, proposalFileName } from "../lib/export";
import { getOpportunityStage, opportunityStageLabel } from "../lib/workflow";
import { Badge, Button, EmptyState, PageHeader } from "../components/ui";
import type { Proposal } from "../types";
import "./workspace.css";
import "./proposal-files.css";

export default function Proposals() {
  const { state, notify } = useApp();
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);
  const visible = state.proposals.filter((proposal) => {
    const opportunity = state.opportunities.find(
      (item) => item.id === proposal.opportunityId,
    );
    return [
      proposal.title,
      opportunity?.title,
      opportunity?.buyer,
      opportunity?.reference,
    ]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  async function download(proposal: Proposal) {
    const opportunity = state.opportunities.find(
      (item) => item.id === proposal.opportunityId,
    );
    if (!opportunity) return;
    setExporting(proposal.id);
    try {
      await exportProposal(proposal, opportunity, state.settings.companyName);
      notify(
        "Word file downloaded from the saved content. Update all fields and the entire table of contents in Word, then review the file.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "The Word file could not be generated.",
      );
    } finally {
      setExporting(null);
    }
  }
  return (
    <div className="workspace-page proposal-file-page">
      <PageHeader
        eyebrow="YOUR DOCUMENTS"
        title="Proposal files"
        description="Review each proposal document and version, answer questions about missing information, and request a regenerated file using your feedback."
        actions={
          <Link className="btn btn-primary" to="/opportunities">
            Choose an opportunity <ArrowRight size={16} />
          </Link>
        }
      />
      <div className="notice">
        <FileText size={18} />
        <p className="small">
          <strong>Each proposal belongs to one opportunity and its RFP.</strong>{" "}
          Start inside a selected opportunity after uploading the buyer’s RFP.
          Submission through the buyer’s portal or email is recorded separately;
          the proposal stays available here.
        </p>
      </div>
      <section className="panel">
        <div className="workspace-proposal-toolbar">
          <p className="small muted">
            {state.proposals.length} proposal{" "}
            {state.proposals.length === 1 ? "document" : "documents"}
          </p>
          <div className="workspace-search">
            <Search size={16} />
            <input
              aria-label="Search proposals"
              placeholder="Search proposal files…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table className="data-table workspace-proposals-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Buyer</th>
                  <th>Linked opportunity</th>
                  <th>Version</th>
                  <th>Updated</th>
                  <th>File actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((proposal) => {
                  const opportunity = state.opportunities.find(
                    (item) => item.id === proposal.opportunityId,
                  );
                  return (
                    <tr key={proposal.id}>
                      <td>
                        <Link
                          className="workspace-proposal-title"
                          to={`/proposals/${proposal.id}`}
                        >
                          <span className="workspace-file-icon">
                            <FileText size={21} />
                          </span>
                          <span>
                            <strong>{proposal.title}</strong>
                            <small>
                              {opportunity
                                ? proposalFileName(proposal, opportunity)
                                : "Proposal.docx"}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>{opportunity?.buyer || "Not provided"}</td>
                      <td>
                        {opportunity ? (
                          <div className="stack" style={{ gap: 6 }}>
                            <Link
                              className="text-link"
                              to={`/opportunities/${opportunity.id}`}
                              aria-label={`View opportunity: ${opportunity.title}`}
                            >
                              {opportunity.title}
                            </Link>
                            <span className="small muted">
                              {opportunityStageLabel(
                                getOpportunityStage(
                                  opportunity,
                                  state.proposals,
                                ),
                              )}
                            </span>
                            {opportunity.status === "submitted" && (
                              <Badge tone="neutral">Submission recorded</Badge>
                            )}
                          </div>
                        ) : (
                          "Opportunity unavailable"
                        )}
                      </td>
                      <td>
                        <Badge tone="neutral">v{proposal.version}</Badge>
                      </td>
                      <td className="muted">
                        {new Date(proposal.updatedAt).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" },
                        )}
                      </td>
                      <td>
                        <div className="proposal-list-actions">
                          <Link
                            className="btn btn-secondary btn-sm"
                            to={`/proposals/${proposal.id}`}
                            aria-label={`Open ${proposal.title}`}
                          >
                            Review proposal <ArrowRight size={14} />
                          </Link>
                          <Button
                            size="sm"
                            aria-label={`Download ${proposal.title} as Word`}
                            disabled={
                              !!exporting ||
                              (!proposal.sections.length &&
                                !proposal.includePricing)
                            }
                            onClick={() => void download(proposal)}
                          >
                            <Download size={14} />
                            {exporting === proposal.id ? "Generating…" : "Word"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              search
                ? "No matching proposal files"
                : "Your next proposal starts with an RFP"
            }
            description={
              search
                ? "Try another title, buyer, or reference."
                : "Choose an opportunity, upload and review the buyer’s RFP, then generate its complete proposal. You can start without a saved template or Company Knowledge; missing information will appear as review questions."
            }
            action={
              !search ? (
                <Link className="btn btn-primary" to="/opportunities">
                  Go to opportunities
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
      <p className="workspace-bottom-note">
        <FileText size={14} /> Word downloads contain the saved document
        version. Saved answers and feedback will be applied when AI regeneration
        is connected; they do not change the current file yet.
      </p>
    </div>
  );
}
