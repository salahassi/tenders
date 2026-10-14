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

const sourceTypeLabel: Record<Source["type"], string> = {
  link_directory: "Website",
  rss: "RSS feed",
  json_feed: "JSON feed",
  manual: "Added by you",
};
const sourceStatusLabel: Record<Source["status"], string> = {
  approved: "Enabled",
  proposed: "Not enabled",
  paused: "Paused",
  rejected: "Rejected",
};

export default function Sources() {
  const { state, update, notify } = useApp();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    url: "",
    type: "link_directory" as Exclude<Source["type"], "manual">,
    tags: "",
    policy: "",
  });
  const owner = state.settings.role === "Owner",
    canEdit = state.settings.role !== "Reviewer";
  const sources = state.sources.filter(
    (s) =>
      (filter === "all" || s.status === filter) &&
      `${s.name} ${sourceTypeLabel[s.type]} ${s.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const changeStatus = (id: string, status: Source["status"]) => {
    if (!owner || state.sources.find((s) => s.id === id)?.type === "manual")
      return;
    if (
      status === "approved" &&
      state.sources.find((x) => x.id === id)?.type !== "manual" &&
      state.sources.filter(
        (x) => x.status === "approved" && x.type !== "manual",
      ).length >= 5
    ) {
      notify(
        "This trial configuration supports five enabled sources. Pause one before enabling another.",
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
        ? "Source enabled in your saved configuration. Live collection is not connected."
        : `Source ${status}.`,
    );
  };
  const submit = () => {
    if (!canEdit) return;
    if (!form.name.trim()) {
      setError("Give the source a name.");
      return;
    }
    try {
      const u = new URL(form.url);
      if (u.protocol !== "https:") throw Error();
    } catch {
      setError("Enter a valid HTTPS website or feed URL.");
      return;
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
      "Source added",
      source.id,
    );
    setOpen(false);
    setForm({
      name: "",
      url: "",
      type: "link_directory",
      tags: "",
      policy: "",
    });
    setError("");
    notify(
      "Source saved. An Owner can enable it in Sources. Live collection is not connected.",
    );
  };
  return (
    <>
      <PageHeader
        eyebrow="DISCOVERY"
        title="Sources"
        description="Add the websites, RSS feeds, and JSON feeds you want the agent to monitor."
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
          label="Enabled sources"
          value={
            state.sources.filter(
              (s) => s.status === "approved" && s.type !== "manual",
            ).length
          }
          detail="Saved configuration; collection not connected"
          icon={<Radio size={18} />}
        />
        <Metric
          label="Not enabled"
          value={state.sources.filter((s) => s.status === "proposed").length}
          detail="An Owner can enable these sources"
          icon={<Globe2 size={18} />}
        />
        <Metric
          label="Opportunities recorded"
          value={state.opportunities.length}
          detail="Includes sample and user-added records"
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
          <option value="approved">Enabled</option>
          <option value="proposed">Not enabled</option>
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
                            {source.type === "manual"
                              ? "Added by you"
                              : source.name}
                          </Link>
                          <small>
                            {source.type === "manual"
                              ? "Opportunities you enter or import yourself"
                              : source.tags.join(" · ") ||
                                "No sectors specified"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="tag">
                        {sourceTypeLabel[source.type]}
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
                        {source.type === "manual"
                          ? "Built-in origin"
                          : sourceStatusLabel[source.status]}
                      </Badge>
                    </td>
                    <td>
                      {
                        state.opportunities.filter(
                          (o) => o.sourceId === source.id,
                        ).length
                      }
                    </td>
                    <td>
                      <div className="admin-cell-actions">
                        {owner &&
                          source.type !== "manual" &&
                          source.status === "proposed" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                changeStatus(source.id, "approved")
                              }
                            >
                              <Check size={13} /> Enable
                            </Button>
                          )}
                        {owner &&
                          source.type !== "manual" &&
                          source.status === "approved" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => changeStatus(source.id, "paused")}
                              aria-label={`Pause ${source.name}`}
                            >
                              <Pause size={14} />
                            </Button>
                          )}
                        {owner &&
                          source.type !== "manual" &&
                          source.status === "paused" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                changeStatus(source.id, "approved")
                              }
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
        Live collection is not connected. Enabling a source saves your
        preference in this browser. "Added by you" is the built-in origin for
        opportunities you enter or import yourself; it is not a website
        connector.
      </p>
      <Modal open={open} onClose={() => setOpen(false)} title="Add source">
        <p className="admin-help">
          Save a public website or feed. An Owner can enable it in the source
          list. Live monitoring requires the backend connection.
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
          <Field label="Source type">
            <select
              className="input"
              value={form.type}
              onChange={(e) =>
                setForm({
                  ...form,
                  type: e.target.value as Exclude<Source["type"], "manual">,
                })
              }
            >
              <option value="link_directory">Website</option>
              <option value="rss">RSS feed</option>
              <option value="json_feed">JSON feed</option>
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
            Save source
          </Button>
        </div>
      </Modal>
    </>
  );
}
