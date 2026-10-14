import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Download, FileText, Search } from "lucide-react";
import { useApp } from "../lib/store";
import { exportProposal, proposalFileName } from "../lib/export";
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
        description="Open a draft, add the information your RFP needs, and download one Word file."
        actions={
          <Link className="btn btn-primary" to="/opportunities">
            Upload an RFP <ArrowRight size={16} />
          </Link>
        }
      />
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
                  <th>Content</th>
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
                        <Badge tone="neutral">
                          {proposal.sections.length} sections · v
                          {proposal.version}
                        </Badge>
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
                            Open file <ArrowRight size={14} />
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
                : "Open an opportunity, upload its RFP, and create a local document draft. AI generation becomes available after the backend is connected."
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
        <FileText size={14} /> Files are generated from saved content on
        download. AI drafting is not connected.
      </p>
    </div>
  );
}
