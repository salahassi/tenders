import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Globe2, ExternalLink, ShieldCheck } from "lucide-react";
import { useApp } from "../lib/store";
import { Badge, Button, EmptyState, PageHeader } from "../components/ui";
import "./admin.css";
export default function SourceDetail() {
  const { id } = useParams();
  const { state, update, notify } = useApp();
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
  const audit = state.audit.filter((a) => a.target === id).slice(0, 8);
  const jobs = state.jobs.filter((j) => j.target === source.name);
  const setStatus = (status: typeof source.status) => {
    if (!owner) return;
    if (
      status === "approved" &&
      source.type !== "manual" &&
      state.sources.filter(
        (x) => x.status === "approved" && x.type !== "manual",
      ).length >= 5
    ) {
      notify(
        "The trial allows five approved automated sources. Pause one before approving another.",
      );
      return;
    }
    update(
      (s) => ({
        ...s,
        sources: s.sources.map((x) =>
          x.id === id ? { ...x, status, nextRun: null } : x,
        ),
      }),
      `Source ${status}`,
      source.id,
    );
    notify(`Source ${status} locally. Live collection is not configured.`);
  };
  const safeUrl = source.url.startsWith("https://");
  return (
    <>
      <Link to="/sources" className="admin-back-link">
        <ArrowLeft size={15} /> All sources
      </Link>
      <PageHeader
        eyebrow="SOURCE DETAILS"
        title={source.name}
        description="Review access, collection policy, and source activity."
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
              {source.status}
            </Badge>
            {owner && source.status !== "approved" && (
              <Button onClick={() => setStatus("approved")}>
                Approve source
              </Button>
            )}
            {owner && source.status === "approved" && (
              <Button variant="secondary" onClick={() => setStatus("paused")}>
                Pause source
              </Button>
            )}
          </div>
        }
      />
      <div className="split-layout">
        <div className="stack">
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
                  source.url || "Manual source — no URL"
                )}
              </dd>
              <dt>Method</dt>
              <dd>{source.type.replaceAll("_", " ")}</dd>
              <dt>Polling preference</dt>
              <dd>Every {state.settings.pollHours} hours, when connected</dd>
              <dt>Last collection</dt>
              <dd>
                {source.lastRun
                  ? `${new Date(source.lastRun).toLocaleString()} (demo record)`
                  : "Not run"}
              </dd>
              <dt>Next collection</dt>
              <dd>Not scheduled — demo mode</dd>
              <dt>Opportunities</dt>
              <dd>{source.count} illustrative records</dd>
              <dt>Sectors</dt>
              <dd>
                <div className="admin-tag-row">
                  {source.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </dd>
            </dl>
          </div>
          <div className="panel admin-section">
            <div className="admin-icon-title">
              <ShieldCheck size={20} />
              <h2>Permitted collection policy</h2>
            </div>
            <p>{source.policy}</p>
            <div className="admin-rate-note">
              No login automation, CAPTCHA bypass, payment, or document
              purchase. Verify permission and the source connector before
              enabling collection in the connected backend.
            </div>
            {owner && source.status === "proposed" && (
              <div className="admin-form-actions">
                <Button variant="danger" onClick={() => setStatus("rejected")}>
                  Reject source
                </Button>
                <Button onClick={() => setStatus("approved")}>
                  Approve locally
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="panel admin-section">
            <h2>Collection history</h2>
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
                    <span>{new Date(j.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-help">
                No collection jobs recorded for this source.
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
                      {a.actor} · {new Date(a.at).toLocaleString()}
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
