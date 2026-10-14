import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  FileText,
  Search,
  PenLine,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import { useApp } from "../lib/store";
import {
  EmptyState,
  PageHeader,
  Metric,
  Tabs,
  StatusBadge,
} from "../components/ui";
import "./workspace.css";
export default function Proposals() {
  const { state } = useApp();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const visible = state.proposals.filter(
    (p) =>
      (filter === "all" || p.status === filter) &&
      p.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="workspace-page">
      <PageHeader
        eyebrow="FROM BRIEF TO BID"
        title="Your proposal workspace"
        description="A consistent voice. Traceable requirements. Every decision in your hands."
        actions={
          <Link className="btn btn-primary" to="/opportunities">
            Find an opportunity <ArrowRight size={16} />
          </Link>
        }
      />
      <div className="workspace-metrics">
        <Metric
          label="In preparation"
          value={state.proposals.filter((p) => p.status === "draft").length}
          detail="Working drafts"
          icon={<PenLine size={18} />}
        />
        <Metric
          label="Awaiting review"
          value={state.proposals.filter((p) => p.status === "in_review").length}
          detail="Ready for a human decision"
          icon={<Clock3 size={18} />}
        />
        <Metric
          label="Approved"
          value={state.proposals.filter((p) => p.status === "approved").length}
          detail="Exact content version approved"
          icon={<CheckCircle2 size={18} />}
        />
      </div>
      <section className="panel">
        <div className="workspace-proposal-toolbar">
          <Tabs
            active={filter}
            onChange={setFilter}
            items={[
              {
                id: "all",
                label: "All proposals",
                count: state.proposals.length,
              },
              { id: "draft", label: "Drafts" },
              { id: "in_review", label: "In review" },
              { id: "approved", label: "Approved" },
            ]}
          />
          <div className="workspace-search">
            <Search size={16} />
            <input
              aria-label="Search proposals"
              placeholder="Search proposals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table className="data-table workspace-proposals-table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Buyer</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Last updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const opportunity = state.opportunities.find(
                    (o) => o.id === p.opportunityId,
                  );
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link
                          className="workspace-proposal-title"
                          to={`/proposals/${p.id}`}
                        >
                          <span className="workspace-file-icon">
                            <FileText size={19} />
                          </span>
                          <span>
                            <strong>{opportunity?.title || p.title}</strong>
                            <small>
                              {opportunity?.reference || "Local proposal"} ·{" "}
                              {p.sections.length} sections
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td>{opportunity?.buyer || "Not provided"}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td>
                        <span className="workspace-version-pill">
                          v{p.version}
                        </span>
                      </td>
                      <td className="muted">
                        {new Date(p.updatedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td>
                        <Link
                          className="workspace-open"
                          aria-label={`Open ${p.title}`}
                          to={`/proposals/${p.id}`}
                        >
                          <ArrowRight size={18} />
                        </Link>
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
              search || filter !== "all"
                ? "No matching proposals"
                : "Give your next proposal a head start"
            }
            description={
              search || filter !== "all"
                ? "Try another filter or search term."
                : "Choose an opportunity, add its RFP, and review the requirements to start an editable draft."
            }
            action={
              !search && filter === "all" ? (
                <Link className="btn btn-primary" to="/opportunities">
                  Browse opportunities
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
      <p className="workspace-bottom-note">
        <FileText size={14} />
        Local frontend trial · template drafts and browser exports · no live AI
        or external submission
      </p>
    </div>
  );
}
