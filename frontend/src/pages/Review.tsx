import {
  inReviewInbox,
  needsDecision,
  outOfScope,
  assessmentActive,
  isExpired,
} from "../lib/discovery";
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
  const pending = state.opportunities.filter(inReviewInbox);
  const excluded = state.opportunities.filter(outOfScope);
  const processing = state.opportunities.filter(
    (o) =>
      needsDecision(o) &&
      !isExpired(o) &&
      !inReviewInbox(o) &&
      !outOfScope(o) &&
      assessmentActive(o),
  );
  const attention = state.opportunities.filter(
    (o) =>
      needsDecision(o) &&
      !isExpired(o) &&
      !inReviewInbox(o) &&
      !outOfScope(o) &&
      !assessmentActive(o),
  );
  const archived = state.opportunities.filter((o) => o.status === "declined");
  const expired = state.opportunities.filter(
    (o) => needsDecision(o) && isExpired(o),
  );
  const items = (
    tab === "pending"
      ? pending
      : tab === "processing"
        ? processing
        : tab === "attention"
          ? attention
          : tab === "excluded"
            ? excluded
            : tab === "expired"
              ? expired
              : archived
  ).filter((o) =>
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
      {state.settings.discoveryScope === "software_services" && (
        <p className="notice">
          Software, digital transformation and AI services. Hardware and
          unrelated procurement are filtered out. Mixed or unclear scope
          requires review.
        </p>
      )}
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
            { id: "processing", label: "Assessing", count: processing.length },
            {
              id: "attention",
              label: "Needs attention",
              count: attention.length,
            },
            { id: "excluded", label: "Outside scope", count: excluded.length },
            { id: "expired", label: "Closed", count: expired.length },
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
              {isExpired(o) && (
                <Badge tone="red">Submission deadline passed</Badge>
              )}
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
              {tab !== "archived" ? (
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
                : tab === "processing"
                  ? "No assessments in progress"
                  : tab === "attention"
                    ? "No assessment blockers"
                    : tab === "excluded"
                      ? "No excluded discoveries"
                      : tab === "expired"
                        ? "No closed discoveries"
                        : "No archived discoveries"
            }
            description={
              search
                ? "Try a different search."
                : "Collected notices enter this inbox after assessment. Track queued work under Assessing and blockers under Needs attention."
            }
          />
        </section>
      )}
      <p className="help-caption">
        Approved sources collect on their saved schedule. Assessments use the
        notice and authorized company evidence; your bid decision remains yours.
      </p>
    </>
  );
}
