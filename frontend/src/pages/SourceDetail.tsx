import SourceConfiguration from "../components/SourceConfiguration";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Globe2, ExternalLink, ShieldCheck } from "lucide-react";
import { useApp } from "../lib/store";
import { Badge, Button, EmptyState, PageHeader } from "../components/ui";
import {
  isBuiltInSource,
  canCollectSource,
  sourceSetupGuidance,
} from "../lib/sources";
import { dateTime } from "../lib/format";
import "./admin.css";
export default function SourceDetail() {
  const { id } = useParams();
  const { state, update, notify, mode } = useApp();
  const source = state.sources.find((s) => s.id === id);
  if (!source)
    return (
      <EmptyState
        title="Source not found"
        description="This source may have been removed or the link is no longer valid."
        action={
          <Link to="/sources" className="admin-link">
            Return to sources
          </Link>
        }
      />
    );
  const owner = state.settings.role === "Owner";
  const isManual = isBuiltInSource(source);
  const manualPortal = source.type === "manual" && !isManual;
  const collectable = canCollectSource(source);
  const setupGuidance = sourceSetupGuidance(source);
  const sourceTypeLabel = {
    link_directory: "Website",
    rss: "RSS feed",
    json_feed: "JSON feed",
    manual: isManual ? "Added by you" : "Automatic website",
  }[source.type];
  const statusLabel = {
    approved: "Enabled",
    proposed: "Not enabled",
    paused: "Paused",
    rejected: "Rejected",
  }[source.status];
  const opportunityCount = state.opportunities.filter(
    (o) => o.sourceId === source.id,
  ).length;
  const audit = state.audit.filter((a) => a.target === id).slice(0, 8);
  const jobs = state.jobs
    .filter((j) => j.target === source.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const setStatus = async (status: typeof source.status) => {
    if (!owner || isManual || (status === "approved" && !collectable)) return;
    if (
      !(await update(
        (s) => ({
          ...s,
          sources: s.sources.map((x) =>
            x.id === id ? { ...x, status, nextRun: null } : x,
          ),
        }),
        `Source ${status}`,
        source.id,
      ))
    ) {
      return;
    }
    notify(
      status === "approved"
        ? "Source enabled. Collection runs on the backend when its access checks pass."
        : `Source ${status}${mode === "DEMO" ? " locally" : ""}.`,
    );
  };
  const safeUrl = source.url.startsWith("https://");
  return (
    <>
      <Link to="/sources" className="admin-back-link">
        <ArrowLeft size={15} /> All sources
      </Link>
      <PageHeader
        eyebrow="SOURCE DETAILS"
        title={isManual ? "Added by you" : source.name}
        description={
          isManual
            ? "The built-in origin for opportunities you enter or import yourself."
            : manualPortal
              ? "Enable automatic reading to collect notices from this public website."
              : "Automatic collection, schedule and source access details."
        }
        actions={
          <div className="row">
            <Badge
              tone={
                source.status === "approved"
                  ? "green"
                  : source.status === "proposed"
                    ? "amber"
                    : "neutral"
              }
            >
              {isManual
                ? "Built-in origin"
                : source.status === "proposed" && !collectable
                  ? "Setup required"
                  : statusLabel}
            </Badge>
            {owner && collectable && source.status !== "approved" && (
              <Button onClick={() => setStatus("approved")}>
                Enable source
              </Button>
            )}
            {owner && !isManual && source.status === "approved" && (
              <Button variant="secondary" onClick={() => setStatus("paused")}>
                Pause source
              </Button>
            )}
          </div>
        }
      />
      <div className="split-layout">
        <div className="stack">
          {setupGuidance && (
            <section
              className="panel admin-section"
              aria-labelledby="source-setup-heading"
            >
              <h2 id="source-setup-heading">Collection setup required</h2>
              <p>{setupGuidance}</p>
              <p className="admin-help">
                {owner
                  ? "Saving valid collection settings pauses this source. Then use Enable source to start its schedule."
                  : "Ask a workspace Owner to configure and enable this source."}
              </p>
            </section>
          )}
          {!isManual && <SourceConfiguration key={source.id} source={source} />}
          <div className="panel admin-section">
            <div className="admin-icon-title">
              <span className="admin-source-icon">
                <Globe2 size={21} />
              </span>
              <h2>Source configuration</h2>
            </div>
            <div className="admin-divider" />
            <dl className="admin-details">
              <dt>URL</dt>
              <dd>
                {safeUrl ? (
                  <a
                    className="admin-link"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.url} <ExternalLink size={12} />
                  </a>
                ) : (
                  source.url || "No URL — added directly by you"
                )}
              </dd>
              <dt>Source type</dt>
              <dd>{sourceTypeLabel}</dd>
              <dt>Polling preference</dt>
              <dd>
                {isManual
                  ? "Not applicable"
                  : `Every ${source.pollHours || state.settings.pollHours} hours`}
              </dd>
              <dt>Last collection</dt>
              <dd>{source.lastRun ? dateTime(source.lastRun) : "Not run"}</dd>
              <dt>Next collection</dt>
              <dd>
                {isManual
                  ? "Not applicable — you add these opportunities"
                  : manualPortal
                    ? "Enable to schedule automatic reading"
                    : source.nextRun
                      ? dateTime(source.nextRun)
                      : "Not scheduled"}
              </dd>
              <dt>Opportunities</dt>
              <dd>{opportunityCount} recorded in this workspace</dd>
              <dt>Sectors</dt>
              <dd>
                <div className="admin-tag-row">
                  {source.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t.startsWith("country:") ? t.slice(8) : t}
                    </span>
                  ))}
                </div>
              </dd>
            </dl>
          </div>
          <div className="panel admin-section">
            <div className="admin-icon-title">
              <ShieldCheck size={20} />
              <h2>
                {isManual
                  ? "How this origin works"
                  : "Access and collection notes"}
              </h2>
            </div>
            <p>
              {isManual
                ? "When you add an opportunity yourself, it is grouped under Added by you. This is not a crawler or feed and has no collection schedule."
                : source.policy}
            </p>
            <div className="admin-rate-note">
              {isManual
                ? "You can enter a public opportunity or upload its RFP from the workspace."
                : manualPortal
                  ? "Enable automatic reading to inspect this public website. Collection history reports results and any login, browser or document-reading requirements."
                  : "Only permitted, approved sources are collected. Review Jobs for host-approval or access blockers."}
            </div>
            {owner && !isManual && source.status === "proposed" && (
              <div className="admin-form-actions">
                <Button variant="danger" onClick={() => setStatus("rejected")}>
                  Reject source
                </Button>
                {collectable && (
                  <Button onClick={() => setStatus("approved")}>
                    Enable source
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="panel admin-section">
            <h2>{isManual ? "Source activity" : "Collection history"}</h2>
            {jobs.length ? (
              <ul className="admin-activity">
                {jobs.slice(0, 5).map((j) => (
                  <li key={j.id}>
                    <div className="admin-spread">
                      <strong>{j.type.replaceAll("_", " ")}</strong>
                      <Badge
                        tone={
                          j.status === "completed"
                            ? "green"
                            : j.status === "blocked"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {j.status}
                      </Badge>
                    </div>
                    <p className="admin-job-message">{j.message}</p>
                    <span>{dateTime(j.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-help">
                {isManual
                  ? "User-added opportunities do not run collection jobs."
                  : "No collection jobs recorded for this source."}
              </p>
            )}
          </div>
          <div className="panel admin-section">
            <h2>Decision history</h2>
            {audit.length ? (
              <ul className="admin-activity">
                {audit.map((a) => (
                  <li key={a.id}>
                    {a.action}
                    <span>
                      {a.actor} · {dateTime(a.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-help">
                Decisions made in this workspace will appear here.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
