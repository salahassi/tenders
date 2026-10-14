import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  ArrowRight,
  Check,
  ExternalLink,
  Search,
  Undo2,
} from "lucide-react";
import { useApp } from "../lib/store";
import { can } from "../lib/domain";
import { date } from "../lib/format";
import { deadlineSourceLabel } from "../lib/workflow";
import type { Opportunity } from "../types";
import { Badge, Button, EmptyState, PageHeader, Tabs } from "../components/ui";
import FitAssessment from "../components/FitAssessment";
import "./simplified.css";
export default function Review() {
  const { state, update, notify } = useApp();
  const [tab, setTab] = useState("pending");
  const [search, setSearch] = useState("");
  const pending = state.opportunities.filter(
    (o) => o.status === "new" || o.status === "deferred",
  );
  const archived = state.opportunities.filter((o) => o.status === "declined");
  const items = (tab === "pending" ? pending : archived).filter((o) =>
    `${o.title} ${o.description} ${o.buyer}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const edit = can(state.settings.role, "edit");
  async function decide(o: Opportunity, status: Opportunity["status"]) {
    if (
      !(await update(
        (s) => ({
          ...s,
          opportunities: s.opportunities.map((x) =>
            x.id === o.id ? { ...x, status } : x,
          ),
        }),
        status === "shortlisted"
          ? "Selected opportunity"
          : status === "declined"
            ? "Archived discovery"
            : "Returned discovery to inbox",
        o.title,
      ))
    ) {
      return;
    }
    notify(
      status === "shortlisted"
        ? "Added to Opportunities. Open it there to upload the RFP."
        : status === "declined"
          ? "Moved to archive. You can restore it at any time."
          : "Restored to the Review inbox.",
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="1 · CHOOSE WHAT TO PURSUE"
        title="Review inbox"
        description="Review each discovery’s scope, company fit, and open questions. Add the ones you want to pursue to Opportunities, or archive them."
        actions={
          <>
            <Link className="btn btn-secondary" to="/opportunities">
              Selected opportunities <ArrowRight size={16} />
            </Link>
          </>
        }
      />
      <div className="simple-flow">
        <strong>Discoveries</strong>
        <ArrowRight size={15} />
        <span>Your selection</span>
        <ArrowRight size={15} />
        <span>Upload RFP</span>
        <ArrowRight size={15} />
        <span>Proposal file</span>
      </div>
      <section className="panel">
        <Tabs
          active={tab}
          onChange={setTab}
          items={[
            {
              id: "pending",
              label: "Awaiting your decision",
              count: pending.length,
            },
            { id: "archived", label: "Archived", count: archived.length },
          ]}
        />
        <div className="filter-bar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Search discoveries"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search discoveries…"
            />
          </div>
        </div>
      </section>
      <div className="review-grid simple-review-grid">
        {items.map((o) => (
          <article className="panel review-card" key={o.id}>
            <div className="row between">
              <Badge>{o.category}</Badge>
              <span className="muted small">
                {state.sources.find((s) => s.id === o.sourceId)?.name ||
                  "Added by you"}
              </span>
            </div>
            <Link to={`/opportunities/${o.id}`}>
              <h2 dir="auto">{o.title}</h2>
            </Link>
            <p className="muted small">
              {o.buyer} · {o.reference}
            </p>
            <p dir="auto" className="review-description">
              {o.description ||
                "No description supplied. Open the source for details."}
            </p>
            <FitAssessment state={state} opportunity={o} compact />
            <p className="small">
              Closing date: <strong>{date(o.deadline)}</strong>
              <br />
              <span className="muted">{deadlineSourceLabel(o)}</span>
            </p>
            {o.sourceUrl && (
              <a
                href={o.sourceUrl}
                className="text-link"
                target="_blank"
                rel="noreferrer"
              >
                Original notice <ExternalLink size={13} />
              </a>
            )}
            <div className="review-actions">
              <Button
                variant="primary"
                disabled={!edit}
                onClick={() => decide(o, "shortlisted")}
              >
                <Check size={15} />
                Add to opportunities
              </Button>
              {tab === "pending" ? (
                <Button disabled={!edit} onClick={() => decide(o, "declined")}>
                  <Archive size={15} />
                  Archive
                </Button>
              ) : (
                <Button disabled={!edit} onClick={() => decide(o, "new")}>
                  <Undo2 size={15} />
                  Return to inbox
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!items.length && (
        <section className="panel">
          <EmptyState
            title={
              tab === "pending"
                ? "No discoveries waiting for a decision"
                : "No archived discoveries"
            }
            description={
              search
                ? "Try a different search."
                : "Selected items appear in Opportunities. Automated collection will populate this inbox after collection is activated."
            }
          />
        </section>
      )}
      <p className="help-caption">
        AI assessment and automatic source collection are not activated.
        Opportunities remain unassessed until those services are available.
      </p>
    </>
  );
}
