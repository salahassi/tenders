import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Check,
  FileText,
  HelpCircle,
  Radio,
  Target,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { can } from "../lib/domain";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Score,
  Tabs,
} from "../components/ui";
export default function Review() {
  const { state, update, notify } = useApp();
  const [tab, setTab] = useState("opportunities");
  const pending = state.opportunities.filter((o) => o.status === "new");
  const gaps = state.opportunities.flatMap((o) =>
    o.gaps
      .filter((g) => !g.answer.trim())
      .map((g) => ({ opportunity: o, gap: g })),
  );
  const sources = state.sources.filter((s) => s.status === "proposed");
  const proposals = state.proposals.filter((p) => p.status === "in_review");
  const edit = can(state.settings.role, "edit");
  return (
    <>
      <PageHeader
        eyebrow="HUMAN DECISIONS, CLEARLY RECORDED"
        title="A little attention goes a long way."
        description="Review the evidence and move the right opportunities forward. Every decision stays in your audit trail."
      />
      <div className="review-intro">
        <div>
          <Target size={21} />
          <strong>{pending.length}</strong>
          <span>Opportunities</span>
        </div>
        <div>
          <HelpCircle size={21} />
          <strong>{gaps.length}</strong>
          <span>Missing answers</span>
        </div>
        <div>
          <Radio size={21} />
          <strong>{sources.length}</strong>
          <span>Source decisions</span>
        </div>
        <div>
          <FileText size={21} />
          <strong>{proposals.length}</strong>
          <span>Proposal reviews</span>
        </div>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          {
            id: "opportunities",
            label: "Opportunity fit",
            count: pending.length,
          },
          { id: "gaps", label: "Missing information", count: gaps.length },
          { id: "sources", label: "Source approvals", count: sources.length },
          {
            id: "proposals",
            label: "Proposal reviews",
            count: proposals.length,
          },
        ]}
      />
      {tab === "opportunities" && (
        <div className="review-grid">
          {pending.map((o) => (
            <article className="panel review-card" key={o.id}>
              <div className="row between">
                <Badge tone={o.coverage < 60 ? "amber" : "blue"}>
                  {o.coverage < 60
                    ? "Evidence needs a closer look"
                    : "Decision needed"}
                </Badge>
                <Score value={o.score} />
              </div>
              <Link to={`/opportunities/${o.id}`}>
                <h2>{o.title}</h2>
              </Link>
              <p className="muted small">
                {o.buyer} · {o.reference}
              </p>
              <p className="review-description">{o.description}</p>
              <div className="evidence-progress">
                <span>
                  Evidence coverage <strong>{o.coverage}%</strong>
                </span>
                <div>
                  <i style={{ width: `${o.coverage}%` }} />
                </div>
              </div>
              <div className="review-actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!edit}
                  onClick={() => {
                    update(
                      (s) => ({
                        ...s,
                        opportunities: s.opportunities.map((x) =>
                          x.id === o.id ? { ...x, status: "shortlisted" } : x,
                        ),
                      }),
                      "Opportunity shortlisted",
                      o.title,
                    );
                    notify("Added to your shortlist");
                  }}
                >
                  <Check size={15} />
                  Shortlist
                </Button>
                <Button
                  size="sm"
                  disabled={!edit}
                  onClick={() => {
                    update(
                      (s) => ({
                        ...s,
                        opportunities: s.opportunities.map((x) =>
                          x.id === o.id ? { ...x, status: "deferred" } : x,
                        ),
                      }),
                      "Opportunity deferred",
                      o.title,
                    );
                    notify("Opportunity deferred");
                  }}
                >
                  Defer
                </Button>
                <Link to={`/opportunities/${o.id}`} className="text-link">
                  Review evidence <ArrowRight size={14} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      {tab === "gaps" && (
        <div className="stack">
          {gaps.map(({ opportunity: o, gap: g }) => (
            <div className="panel task-row" key={g.id}>
              <div className="attention-icon amber">
                <HelpCircle size={20} />
              </div>
              <div>
                <Badge tone={g.required ? "amber" : "neutral"}>
                  {g.required ? "Required answer" : "Optional clarification"}
                </Badge>
                <h3>{g.question}</h3>
                <p>{o.title}</p>
              </div>
              <Link
                className="btn btn-secondary btn-sm"
                to={`/opportunities/${o.id}?tab=requirements`}
              >
                Provide input <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      )}
      {tab === "sources" && (
        <div className="stack">
          {sources.map((s) => (
            <div className="panel task-row" key={s.id}>
              <div className="attention-icon green">
                <Radio size={20} />
              </div>
              <div>
                <h3>{s.name}</h3>
                <p>
                  {s.policy ||
                    "Access policy must be reviewed before approval."}
                </p>
                <small>{s.url}</small>
              </div>
              <Link
                className="btn btn-secondary btn-sm"
                to={`/sources/${s.id}`}
              >
                Review source <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      )}
      {tab === "proposals" && (
        <div className="stack">
          {proposals.map((p) => (
            <div className="panel task-row" key={p.id}>
              <div className="attention-icon green">
                <FileText size={20} />
              </div>
              <div>
                <Badge tone="blue">Version {p.version} · In review</Badge>
                <h3>{p.title}</h3>
                <p>
                  Check the scope, supporting evidence, and financial
                  assumptions.
                </p>
              </div>
              <Link
                className="btn btn-secondary btn-sm"
                to={`/proposals/${p.id}`}
              >
                Open proposal <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      )}
      {({
        opportunities: pending.length,
        gaps: gaps.length,
        sources: sources.length,
        proposals: proposals.length,
      }[tab] ?? 0) === 0 && (
        <div className="panel">
          <EmptyState
            title="You're all caught up here"
            description="New items that need your attention will appear in this queue."
          />
        </div>
      )}
      <p className="help-caption">
        <X size={13} /> A fit score never approves a tender, a source, or a
        final proposal automatically.
      </p>
    </>
  );
}
