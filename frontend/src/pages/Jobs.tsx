import { useState } from "react";
import {
  Activity,
  Clock3,
  CheckCircle2,
  RotateCcw,
  X,
  Search,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Metric,
} from "../components/ui";
import type { Job } from "../types";
import "./admin.css";
export default function Jobs() {
  const { state, update, notify, mode } = useApp();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const canEdit = state.settings.role !== "Reviewer";
  const jobs = state.jobs.filter(
    (j) =>
      (filter === "all" || j.status === filter) &&
      `${j.target} ${j.type}`.toLowerCase().includes(search.toLowerCase()),
  );
  const cancel = async (job: Job) => {
    if (!canEdit) return;
    if (
      !(await update(
        (s) => ({
          ...s,
          jobs: s.jobs.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  status: "cancelled",
                  message:
                    "Cancelled in this local demo. No connected worker was contacted.",
                }
              : j,
          ),
        }),
        "Job cancelled",
        job.id,
      ))
    ) {
      return;
    }
    notify(
      mode === "CONNECTED_FREE"
        ? "Cancellation recorded. A running task stops at its next safe checkpoint."
        : "Local job cancelled.",
    );
  };
  const retry = async (job: Job) => {
    if (!canEdit) return;
    if (
      !(await update(
        (s) => ({
          ...s,
          jobs: s.jobs.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  status: "blocked",
                  attempt: j.attempt + 1,
                  progress: 0,
                  message:
                    "Retry checked locally: a connected backend is required. No external request was made.",
                }
              : j,
          ),
        }),
        "Job retry checked",
        job.id,
      ))
    ) {
      return;
    }
    notify(
      mode === "CONNECTED_FREE"
        ? "Retry checked. See the task blocker; processing is not configured yet."
        : "Retry is blocked until a backend is connected. Your work is preserved.",
    );
  };
  const tone = (s: Job["status"]) =>
    s === "completed"
      ? "green"
      : s === "failed"
        ? "red"
        : s === "blocked"
          ? "amber"
          : s === "running"
            ? "blue"
            : "neutral";
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE OPERATIONS"
        title="Activity & jobs"
        description="Understand what ran, what is waiting, and what needs attention."
        actions={
          <Link to="/setup" className="admin-link">
            Connection status →
          </Link>
        }
      />
      <div className="admin-metrics">
        <Metric
          label="Waiting or active"
          value={
            state.jobs.filter(
              (j) => j.status === "queued" || j.status === "running",
            ).length
          }
          detail={
            mode === "CONNECTED_FREE"
              ? "Server job records"
              : "Illustrative demo job records"
          }
          icon={<Clock3 size={18} />}
        />
        <Metric
          label="Completed"
          value={state.jobs.filter((j) => j.status === "completed").length}
          detail={
            mode === "CONNECTED_FREE"
              ? "Recorded completions"
              : "Local demo history"
          }
          icon={<CheckCircle2 size={18} />}
        />
        <Metric
          label="Needs attention"
          value={
            state.jobs.filter(
              (j) => j.status === "blocked" || j.status === "failed",
            ).length
          }
          detail="Review blockers before retrying"
          icon={<Activity size={18} />}
        />
      </div>
      <div className="notice notice-warning">
        {mode === "CONNECTED_FREE"
          ? "Background handlers and scheduling are not active yet. A blocked job remains blocked until its dependency is configured."
          : "Background processing is not running in this frontend demo. Test and retry controls record truthful local states; they do not call a model or collector."}
      </div>
      <div className="admin-toolbar" style={{ marginTop: 24 }}>
        <div className="admin-search">
          <Search />
          <input
            className="input"
            aria-label="Search jobs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search jobs or opportunities…"
          />
        </div>
        <select
          className="input"
          aria-label="Filter jobs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          {[
            "queued",
            "running",
            "completed",
            "failed",
            "blocked",
            "cancelled",
          ].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="panel">
        {jobs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job / target</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Details</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="admin-job-target">{j.target}</div>
                      <span className="small muted">
                        {j.type.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>
                      <Badge tone={tone(j.status)}>{j.status}</Badge>
                    </td>
                    <td>
                      <div className="admin-progress">
                        <span
                          style={{
                            width: `${Math.max(0, Math.min(100, j.progress))}%`,
                          }}
                        />
                      </div>
                      <span className="small muted">{j.progress}%</span>
                    </td>
                    <td>
                      <div className="admin-job-message">{j.message}</div>
                      <span className="small muted">
                        Attempt {j.attempt} ·{" "}
                        {new Date(j.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td>
                      {canEdit && (
                        <div className="admin-cell-actions">
                          {["queued", "running"].includes(j.status) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => cancel(j)}
                            >
                              <X size={13} /> Cancel
                            </Button>
                          )}
                          {["failed", "blocked", "cancelled"].includes(
                            j.status,
                          ) && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => retry(j)}
                            >
                              <RotateCcw size={13} /> Check retry
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No jobs match this view"
            description="Adjust your filters, or run a local source test to create an activity record."
          />
        )}
      </div>
    </>
  );
}
