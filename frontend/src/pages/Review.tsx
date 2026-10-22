import { groupDiscoveries, isExpired } from "../lib/discovery";
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
  const groups = groupDiscoveries(state.opportunities);
  const items = (groups[tab as keyof typeof groups] || []).filter((o) =>
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
      <p className="notice">
        Service scope:{" "}
        {state.settings.discoveryScope === "keywords"
          ? "keywords"
          : state.settings.discoveryScope === "combined"
            ? "Company Knowledge + keywords"
            : "Company Knowledge"}
        .
        {state.settings.discoveryScope !== "company_knowledge" && (
          <>
            {!!state.settings.discoveryIncludeKeywords?.length && (
              <>
                {" "}
                Interests: {state.settings.discoveryIncludeKeywords.join(", ")}.
              </>
            )}
            {!!state.settings.discoveryExcludeKeywords?.length && (
              <>
                {" "}
                Exclusions: {state.settings.discoveryExcludeKeywords.join(", ")}
                .
              </>
            )}
          </>
        )}{" "}
        Unclear scope requires review.{" "}
        <Link to="/settings?section=data">Manage scope</Link>
      </p>
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
              count: groups.pending?.length || 0,
            },
            {
              id: "scope",
              label: "Scope to review",
              count: groups.scope?.length || 0,
            },
            {
              id: "processing",
              label: "Assessing",
              count: groups.processing?.length || 0,
            },
            {
              id: "attention",
              label: "Needs attention",
              count: groups.attention?.length || 0,
            },
            {
              id: "excluded",
              label: "Outside scope",
              count: groups.excluded?.length || 0,
            },
            {
              id: "expired",
              label: "Closed",
              count: groups.expired?.length || 0,
            },
            {
              id: "archived",
              label: "Archived",
              count: groups.archived?.length || 0,
            },
          ]}
        />
        {tab === "scope" && (
          <p className="muted small">
            These assessments completed, but the published information did not
            establish whether the tender matches your service scope. Review the
            evidence and open questions before deciding.
          </p>
        )}
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
                : tab === "scope"
                  ? "No completed assessments with unclear scope"
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
                : "Track scheduled work under Assessing, completed assessments with unclear scope under Scope to review, and processing blockers under Needs attention."
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
