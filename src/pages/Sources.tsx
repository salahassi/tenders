import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Globe2,
  Plus,
  Search,
  Radio,
  Pause,
  Check,
  ArrowUpRight,
} from "lucide-react";
import { useApp } from "../lib/store";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Modal,
  Field,
  Metric,
} from "../components/ui";
import type { Source } from "../types";
import "./admin.css";

export default function Sources() {
  const { state, update, notify } = useApp();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    url: "",
    type: "rss" as Source["type"],
    tags: "",
    policy: "",
  });
  const owner = state.settings.role === "Owner",
    canEdit = state.settings.role !== "Reviewer";
  const sources = state.sources.filter(
    (s) =>
      (filter === "all" || s.status === filter) &&
      `${s.name} ${s.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const changeStatus = (id: string, status: Source["status"]) => {
    if (!owner) return;
    if (
      status === "approved" &&
      state.sources.find((x) => x.id === id)?.type !== "manual" &&
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
      id,
    );
    notify(
      status === "approved"
        ? "Source approved locally. Connected collection is not configured."
        : `Source ${status}.`,
    );
  };
  const submit = () => {
    if (!canEdit) return;
    if (!form.name.trim()) {
      setError("Give the source a name.");
      return;
    }
    if (form.type !== "manual") {
      try {
        const u = new URL(form.url);
        if (u.protocol !== "https:") throw Error();
      } catch {
        setError("Enter a valid HTTPS source URL, or choose manual entry.");
        return;
      }
    }
    const source: Source = {
      id: crypto.randomUUID(),
      name: form.name.trim(),
      url: form.url.trim(),
      type: form.type,
      status: "proposed",
      health: "unknown",
      lastRun: null,
      nextRun: null,
      count: 0,
      policy:
        form.policy.trim() ||
        "Access permission and collection policy must be verified before collection.",
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    update(
      (s) => ({ ...s, sources: [source, ...s.sources] }),
      "Source proposed",
      source.id,
    );
    setOpen(false);
    setForm({ name: "", url: "", type: "rss", tags: "", policy: "" });
    setError("");
    notify("Source proposed. An Owner can review and approve it.");
  };
  const test = (source: Source) => {
    if (!owner) return;
    if (source.status !== "approved") {
      notify("Approve this source before testing it.");
      return;
    }
    const fixture =
      (source.id === "src-1" &&
        source.url === "https://example.com/fixtures/public-tenders.xml") ||
      (source.id === "src-2" &&
        source.url === "https://example.com/fixtures/enterprise-tenders.json");
    const records = state.opportunities.filter((o) => o.sourceId === source.id);
    const valid =
      records.every((o) => o.title.trim() && o.buyer.trim()) &&
      new Set(records.map((o) => o.id)).size === records.length;
    const completed = fixture && valid;
    const jobId = crypto.randomUUID();
    const message = fixture
      ? valid
        ? `Validated ${records.length} existing local fixture records. No network request or duplicate import occurred.`
        : "Local fixture validation found a missing title, buyer, or duplicate ID."
      : source.type === "manual"
        ? "Manual source: automated collection is not available. Add opportunities using Import."
        : "Connected backend is not configured. No network request was made.";
    update(
      (s) => ({
        ...s,
        jobs: [
          {
            id: jobId,
            type: fixture ? "fixture_validation" : "source_collect",
            target: source.name,
            status: completed ? "completed" : fixture ? "failed" : "blocked",
            progress: completed ? 100 : 0,
            attempt: 1,
            message,
            createdAt: new Date().toISOString(),
          },
          ...s.jobs,
        ],
      }),
      "Source test requested",
      source.id,
    );
    notify(message);
  };
  return (
    <>
      <PageHeader
        eyebrow="DISCOVERY"
        title="Sources"
        description="A curated watchlist for your next opportunity."
        actions={
          canEdit ? (
            <Button
              variant="primary"
              onClick={() => {
                setOpen(true);
                setError("");
              }}
            >
              <Plus size={16} /> Add source
            </Button>
          ) : undefined
        }
      />
      <div className="admin-metrics">
        <Metric
          label="Approved sources"
          value={state.sources.filter((s) => s.status === "approved").length}
          detail="Your approved watchlist"
          icon={<Radio size={18} />}
        />
        <Metric
          label="Pending review"
          value={state.sources.filter((s) => s.status === "proposed").length}
          detail="Awaiting Owner approval"
          icon={<Globe2 size={18} />}
        />
        <Metric
          label="Collected opportunities"
          value={state.sources.reduce((n, s) => n + s.count, 0)}
          detail="Includes illustrative demo records"
          icon={<ArrowUpRight size={18} />}
        />
      </div>
      <div className="admin-toolbar">
        <div className="admin-search">
          <Search />
          <input
            className="input"
            aria-label="Search sources"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sources or sectors…"
          />
        </div>
        <select
          className="input"
          aria-label="Filter source status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All sources</option>
          <option value="approved">Approved</option>
          <option value="proposed">Pending review</option>
          <option value="paused">Paused</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div className="panel">
        <div className="panel-header">
          <div>
            <h2 className="section-title">Your source directory</h2>
            <span className="small muted">
              {sources.length} sources · collection requires the connected
              backend
            </span>
          </div>
        </div>
        {sources.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>Opportunities</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <div className="admin-source-name">
                        <span className="admin-source-icon">
                          <Globe2 size={20} />
                        </span>
                        <div>
                          <Link
                            className="admin-link"
                            to={`/sources/${source.id}`}
                          >
                            {source.name}
                          </Link>
                          <small>
                            {source.tags.join(" · ") || "No sectors specified"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="tag">
                        {source.type.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>
                      <Badge
                        tone={
                          source.status === "approved"
                            ? "green"
                            : source.status === "proposed"
                              ? "amber"
                              : source.status === "rejected"
                                ? "red"
                                : "neutral"
                        }
                      >
                        {source.status === "proposed"
                          ? "Needs review"
                          : source.status}
                      </Badge>
                    </td>
                    <td>{source.count}</td>
                    <td>
                      <div className="admin-cell-actions">
                        {owner && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => test(source)}
                            disabled={source.status !== "approved"}
                          >
                            Test
                          </Button>
                        )}
                        {owner && source.status === "proposed" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => changeStatus(source.id, "approved")}
                          >
                            <Check size={13} /> Approve
                          </Button>
                        )}
                        {owner && source.status === "approved" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => changeStatus(source.id, "paused")}
                            aria-label={`Pause ${source.name}`}
                          >
                            <Pause size={14} />
                          </Button>
                        )}
                        {owner && source.status === "paused" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => changeStatus(source.id, "approved")}
                          >
                            Resume
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No matching sources"
            description="Add a source or adjust your filters to build your watchlist."
          />
        )}
      </div>
      <p className="admin-help">
        Demo records show the intended workflow. Approving a source here saves
        your decision locally; it does not activate a live crawler. Restricted
        or login-only sources remain manual.
      </p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Propose a source"
      >
        <p className="admin-help">
          Suggest a public source for review. Only an Owner can approve
          collection.
        </p>
        <div className="stack">
          <Field label="Source name">
            <input
              dir="auto"
              className="input"
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., Public procurement feed"
            />
          </Field>
          <Field label="Collection method">
            <select
              className="input"
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as Source["type"] })
              }
            >
              <option value="rss">RSS feed</option>
              <option value="json_feed">Public JSON feed</option>
              <option value="link_directory">Public link directory</option>
              <option value="manual">Manual entry</option>
            </select>
          </Field>
          <Field
            label="Source URL"
            hint="HTTPS only. A URL is not proof that automated access is permitted."
          >
            <input
              dir="auto"
              type="url"
              className="input"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://"
            />
          </Field>
          <Field label="Sectors" hint="Separate sectors with commas.">
            <input
              dir="auto"
              className="input"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="Energy, technology, public sector"
            />
          </Field>
          <Field label="Access policy notes">
            <textarea
              dir="auto"
              className="textarea"
              value={form.policy}
              onChange={(e) => setForm({ ...form, policy: e.target.value })}
              placeholder="What is published, and what collection is permitted?"
            />
          </Field>
        </div>
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        <div className="admin-form-actions">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Propose source
          </Button>
        </div>
      </Modal>
    </>
  );
}
