import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Clock3,
  FileText,
  Inbox,
  Plus,
  Radio,
  Target,
} from "lucide-react";
import { useApp } from "../lib/store";
import { date, daysLeft } from "../lib/format";
import { EmptyState, Metric, PageHeader } from "../components/ui";
import OpportunityTable from "../components/OpportunityTable";

export default function Dashboard() {
  const { state } = useApp();
  const inbox = state.opportunities.filter(
    (o) => o.status === "new" || o.status === "deferred",
  );
  const selected = state.opportunities.filter((o) =>
    ["shortlisted", "in_progress", "submitted"].includes(o.status),
  );
  const active = selected.filter((o) => o.status !== "submitted");
  const due = active.filter(
    (o) => daysLeft(o.deadline) >= 0 && daysLeft(o.deadline) <= 7,
  );
  const recent = [...selected]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const deadlines = [...active]
    .filter(
      (o) => Number.isFinite(daysLeft(o.deadline)) && daysLeft(o.deadline) >= 0,
    )
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 3);

  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKSPACE, AT A GLANCE"
        title="From opportunity to proposal."
        description="Review incoming opportunities, upload an RFP, and prepare your proposal file."
        actions={
          <Link to="/opportunities?new=1" className="btn btn-primary">
            <Plus size={16} /> Add opportunity
          </Link>
        }
      />
      <div className="dashboard-date">
        <CalendarDays size={14} />
        {date(new Date().toISOString())}
        <span>·</span>Demo workspace snapshot
      </div>
      <section className="focus-banner">
        <div className="focus-icon">
          <Inbox size={25} />
        </div>
        <div className="focus-copy">
          <span className="overline">START WITH YOUR INBOX</span>
          <h2>
            {inbox.length
              ? `${inbox.length} incoming opportunities to review.`
              : "Your review inbox is clear."}
          </h2>
          <p>
            Approve the ones you want to pursue. They will move into
            Opportunities, ready for an RFP.
          </p>
        </div>
        <Link to="/review" className="btn btn-light">
          Open review inbox <ArrowRight size={17} />
        </Link>
        <div className="focus-orbit" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </section>
      <div className="metrics-grid">
        <Metric
          label="In review inbox"
          value={inbox.length.toString().padStart(2, "0")}
          detail="Waiting for your decision"
          icon={<Inbox size={18} />}
        />
        <Metric
          label="Your opportunities"
          value={selected.length.toString().padStart(2, "0")}
          detail="Approved by you to pursue"
          icon={<Target size={18} />}
        />
        <Metric
          label="Proposal drafts"
          value={state.proposals.length.toString().padStart(2, "0")}
          detail="Open a draft to edit or export a file"
          icon={<FileText size={18} />}
        />
        <Metric
          label="Closing this week"
          value={due.length.toString().padStart(2, "0")}
          detail="Recorded submission deadlines, next 7 days"
          icon={<Clock3 size={18} />}
        />
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-primary">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Your opportunities</h2>
                <p>Opportunities you have approved, newest first.</p>
              </div>
              <Link className="text-link" to="/opportunities">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            {recent.length ? (
              <OpportunityTable items={recent} compact />
            ) : (
              <EmptyState
                title="Choose an opportunity to begin"
                description="Approve an item in the Review inbox, then upload its RFP."
                action={
                  <Link className="btn btn-primary" to="/review">
                    Open review inbox
                  </Link>
                }
              />
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>A simple path to your proposal</h2>
                <p>Keep the work focused on the documents you need.</p>
              </div>
            </div>
            <ol className="guide-list" style={{ padding: "0 24px 20px 44px" }}>
              <li>
                <strong>Approve an opportunity</strong>
                <p>
                  Choose the items you want to pursue from your Review inbox.
                </p>
              </li>
              <li>
                <strong>Upload the RFP</strong>
                <p>
                  Add the tender document and choose the company reference files
                  to use.
                </p>
              </li>
              <li>
                <strong>Prepare and generate the proposal</strong>
                <p>
                  Add any requested details, review the draft, and generate a
                  Word file.
                </p>
              </li>
            </ol>
          </section>
        </div>
        <aside className="dashboard-secondary">
          <section className="panel deadline-panel">
            <div className="panel-header">
              <div className="row">
                <CalendarDays size={18} />
                <h2>Submission deadlines</h2>
              </div>
              <span className="count-bubble">{deadlines.length}</span>
            </div>
            {deadlines.map((o) => (
              <Link
                key={o.id}
                className="deadline-item"
                to={`/opportunities/${o.id}`}
              >
                <div
                  className={`date-tile ${daysLeft(o.deadline) <= 3 ? "date-urgent" : ""}`}
                >
                  <strong>
                    {new Intl.DateTimeFormat("en-US", {
                      day: "2-digit",
                      timeZone: "Asia/Riyadh",
                    }).format(new Date(o.deadline))}
                  </strong>
                  <span>
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      timeZone: "Asia/Riyadh",
                    }).format(new Date(o.deadline))}
                  </span>
                </div>
                <div>
                  <h3>{o.title}</h3>
                  <span>
                    {daysLeft(o.deadline)} days left <ArrowUpRight size={12} />
                  </span>
                </div>
              </Link>
            ))}
            {!deadlines.length && (
              <p className="panel-note">
                No upcoming submission deadlines recorded.
              </p>
            )}
            <p className="panel-note">
              These are the dates recorded for your selected opportunities. Demo
              records use illustrative dates.
            </p>
          </section>
          <section className="panel needs-attention">
            <div className="panel-header">
              <h2>Prepare your workspace</h2>
            </div>
            <Link to="/knowledge" className="attention-item">
              <span className="attention-icon green">
                <BookOpen size={17} />
              </span>
              <div>
                <strong>Add company reference files</strong>
                <p>
                  Previous proposals, team profiles, and company information.
                </p>
              </div>
              <ArrowUpRight size={15} />
            </Link>
            <Link to="/sources" className="attention-item">
              <span className="attention-icon amber">
                <Radio size={17} />
              </span>
              <div>
                <strong>Manage discovery sources</strong>
                <p>Websites, RSS feeds, and JSON feeds.</p>
              </div>
              <ArrowUpRight size={15} />
            </Link>
          </section>
          <section className="source-health">
            <div className="row">
              <strong>Frontend demo</strong>
            </div>
            <p>
              Editing, uploads, and Word export work in this browser. Live
              source collection and AI drafting require a backend connection.
            </p>
            <Link to="/setup">
              Connection details <ArrowUpRight size={14} />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
