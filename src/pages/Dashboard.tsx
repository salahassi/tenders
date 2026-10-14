import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCheck,
  CircleAlert,
  Clock3,
  FileText,
  Plus,
  Radio,
  Sparkles,
  Target,
} from "lucide-react";
import { useApp } from "../lib/store";
import { date, daysLeft } from "../lib/format";
import { Metric, PageHeader, StatusBadge } from "../components/ui";
import OpportunityTable from "../components/OpportunityTable";
export default function Dashboard() {
  const { state } = useApp();
  const active = state.opportunities.filter(
    (o) => !["declined", "submitted"].includes(o.status),
  );
  const newItems = state.opportunities.filter((o) => o.status === "new");
  const due = active.filter(
    (o) => daysLeft(o.deadline) >= 0 && daysLeft(o.deadline) <= 7,
  );
  const shortlist = state.opportunities.filter(
    (o) => o.status === "shortlisted" || o.status === "in_progress",
  );
  const top = [...active]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 4);
  const deadlines = [...active]
    .filter((o) => daysLeft(o.deadline) >= 0)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 3);
  const stages = [
    {
      label: "Discovered",
      value: state.opportunities.filter((o) => o.status === "new").length,
      color: "#9cbcac",
    },
    { label: "Shortlisted", value: shortlist.length, color: "#347c67" },
    { label: "In proposal", value: state.proposals.length, color: "#183f37" },
    {
      label: "Submitted",
      value: state.opportunities.filter((o) => o.status === "submitted").length,
      color: "#c1d99b",
    },
  ];
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKSPACE, AT A GLANCE"
        title="Good work starts with the right opportunity."
        description="A clear view of what’s new, what needs you, and what’s next."
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
          <Sparkles size={25} />
        </div>
        <div className="focus-copy">
          <span className="overline">YOUR NEXT MOVE</span>
          <h2>
            {newItems.length
              ? `${newItems.length} opportunities are ready for a closer look.`
              : "Your review queue is in good shape."}
          </h2>
          <p>
            Review the evidence, spot the fit, and decide what deserves your
            time.
          </p>
        </div>
        <Link to="/review" className="btn btn-light">
          Open review queue <ArrowRight size={17} />
        </Link>
        <div className="focus-orbit" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </section>
      <div className="metrics-grid">
        <Metric
          label="Open opportunities"
          value={active.length.toString().padStart(2, "0")}
          detail="Across your connected demo sources"
          icon={<Target size={18} />}
        />
        <Metric
          label="On your shortlist"
          value={shortlist.length.toString().padStart(2, "0")}
          detail="Selected for the next stage"
          icon={<CheckCheck size={18} />}
        />
        <Metric
          label="Proposals in progress"
          value={state.proposals
            .filter((p) => p.status !== "approved")
            .length.toString()
            .padStart(2, "0")}
          detail={`${state.proposals.filter((p) => p.status === "approved").length} approved and ready to export`}
          icon={<FileText size={18} />}
        />
        <Metric
          label="Closing this week"
          value={due.length.toString().padStart(2, "0")}
          detail="Deadlines within the next 7 days"
          icon={<Clock3 size={18} />}
        />
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-primary">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Opportunities worth your attention</h2>
                <p>Ranked by fit. Every score comes with evidence.</p>
              </div>
              <Link className="text-link" to="/opportunities">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <OpportunityTable items={top} compact />
            <div className="panel-note">
              <span className="small-spark">
                <Sparkles size={13} />
              </span>
              Fit measures alignment with your capabilities, not the chance of
              winning.
            </div>
          </section>
          <section className="panel pipeline-panel">
            <div className="panel-header">
              <div>
                <h2>Your pipeline, in perspective</h2>
                <p>Current workspace counts across each stage.</p>
              </div>
              <span className="subtle-label">LIVE SNAPSHOT</span>
            </div>
            <div className="pipeline-bars">
              {stages.map((s, i) => (
                <div className="pipeline-stage" key={s.label}>
                  <div>
                    <span>
                      <b>0{i + 1}</b>
                      {s.label}
                    </span>
                    <strong>{s.value}</strong>
                  </div>
                  <div className="pipeline-track">
                    <span
                      style={{
                        width: `${Math.max((s.value / max) * 100, 2)}%`,
                        background: s.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="panel-note">
              Proposal counts are versions in preparation; one opportunity may
              have more than one proposal.
            </p>
          </section>
        </div>
        <aside className="dashboard-secondary">
          <section className="panel deadline-panel">
            <div className="panel-header">
              <div className="row">
                <CalendarDays size={18} />
                <h2>Coming up next</h2>
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
            {deadlines.length === 0 && (
              <p className="panel-note">No upcoming deadlines.</p>
            )}
            <Link
              className="panel-bottom-link"
              to="/opportunities?sort=deadline"
            >
              View all deadlines <ArrowRight size={15} />
            </Link>
          </section>
          <section className="panel needs-attention">
            <div className="panel-header">
              <div className="row">
                <CircleAlert size={18} />
                <h2>Needs your input</h2>
              </div>
            </div>
            <Link to="/review" className="attention-item">
              <span className="attention-icon amber">
                <FileText size={17} />
              </span>
              <div>
                <strong>Fill in the missing pieces</strong>
                <p>
                  {state.opportunities.reduce(
                    (n, o) =>
                      n +
                      o.gaps.filter((g) => g.required && !g.answer.trim())
                        .length,
                    0,
                  )}{" "}
                  required answers across your opportunities
                </p>
              </div>
              <ArrowUpRight size={15} />
            </Link>
            <Link to="/sources" className="attention-item">
              <span className="attention-icon green">
                <Radio size={17} />
              </span>
              <div>
                <strong>Review proposed sources</strong>
                <p>
                  {state.sources.filter((s) => s.status === "proposed").length}{" "}
                  waiting for an owner decision
                </p>
              </div>
              <ArrowUpRight size={15} />
            </Link>
          </section>
          <section className="source-health">
            <div className="row">
              <span className="status-dot" />
              <strong>Demo sources are ready</strong>
            </div>
            <p>
              Explore collection results with synthetic data. Live background
              monitoring is not connected.
            </p>
            <Link to="/sources">
              Manage sources <ArrowUpRight size={14} />
            </Link>
          </section>
        </aside>
      </div>
      <section className="panel recent-activity">
        <div className="panel-header">
          <h2>Latest activity</h2>
          <Link to="/jobs" className="text-link">
            Activity & jobs <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className="activity-grid">
          {state.jobs.slice(0, 3).map((j) => (
            <div key={j.id}>
              <span className="activity-icon">
                <CheckCheck size={17} />
              </span>
              <div>
                <strong>{j.type}</strong>
                <p>{j.target}</p>
                <StatusBadge status={j.status} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
