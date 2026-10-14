import { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { can } from "../lib/domain";
import type { Opportunity } from "../types";
import { uid } from "../lib/format";
import {
  downloadText,
  fromImportRow,
  opportunitiesToCsv,
  parseOpportunityCsv,
  type ImportRow,
} from "../lib/import";
import {
  Badge,
  Button,
  Field,
  Modal,
  PageHeader,
  Tabs,
} from "../components/ui";
import OpportunityTable from "../components/OpportunityTable";
export default function Opportunities() {
  const { state, update, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(
    ["shortlisted", "in_progress", "submitted"].includes(
      params.get("status") || "",
    )
      ? params.get("status")!
      : "all",
  );
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState(params.get("sort") || "newest");
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(params.get("new") === "1");
  const [importOpen, setImportOpen] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [previewName, setPreviewName] = useState("");
  const [form, setForm] = useState({
    title: "",
    buyer: "",
    reference: "",
    url: "",
    description: "",
    category: "AI & analytics",
    deadline: "",
    time: "17:00",
  });
  const editable = can(state.settings.role, "edit");
  const selected = state.opportunities.filter((o) =>
    ["shortlisted", "in_progress", "submitted"].includes(o.status),
  );
  const filtered = useMemo(
    () =>
      state.opportunities
        .filter(
          (o) =>
            ["shortlisted", "in_progress", "submitted"].includes(o.status) &&
            (tab === "all" || o.status === tab) &&
            (category === "all" || o.category === category) &&
            `${o.title} ${o.buyer} ${o.reference}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "deadline"
            ? (a.deadline || "9999").localeCompare(b.deadline || "9999")
            : sort === "newest"
              ? b.createdAt.localeCompare(a.createdAt)
              : b.createdAt.localeCompare(a.createdAt),
        ),
    [state.opportunities, tab, category, query, sort],
  );
  const maxPages = Math.max(1, Math.ceil(filtered.length / 8));
  const currentPage = Math.min(page, maxPages);
  const shown = filtered.slice((currentPage - 1) * 8, currentPage * 8);
  const resetFilter = (fn: () => void) => {
    fn();
    setPage(1);
  };
  const closeAdd = () => {
    setAdd(false);
    setError("");
    if (params.has("new")) {
      params.delete("new");
      setParams(params, { replace: true });
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!editable) return;
    if (!form.title.trim()) {
      setError("Provide an opportunity title.");
      return;
    }
    if (form.url) {
      try {
        const u = new URL(form.url);
        if (u.protocol !== "https:" || u.username || u.password)
          throw new Error();
      } catch {
        setError("Use a valid HTTPS source URL without credentials.");
        return;
      }
    }
    if (
      state.opportunities.some(
        (o) =>
          (form.reference.trim() && o.reference === form.reference.trim()) ||
          (form.url.trim() && o.sourceUrl === form.url.trim()),
      )
    ) {
      setError("An opportunity with that reference or URL already exists.");
      return;
    }
    const closingDate =
      form.deadline && form.time
        ? new Date(`${form.deadline}T${form.time}:00+03:00`)
        : null;
    if (
      form.deadline &&
      (!closingDate || !Number.isFinite(closingDate.getTime()))
    ) {
      setError("Enter a valid closing date and time, or leave the date blank.");
      return;
    }
    const id = uid("opp");
    const opportunity: Opportunity = {
      id,
      title: form.title.trim(),
      buyer: form.buyer.trim() || "Buyer not provided",
      reference: form.reference.trim() || uid("manual"),
      description: form.description,
      category: form.category,
      tags: ["Manually added"],
      deadline: closingDate?.toISOString() || "",
      score: null,
      coverage: 0,
      status: "shortlisted",
      sourceId: "manual",
      value: null,
      saved: false,
      createdAt: new Date().toISOString(),
      documents: [],
      requirements: [],
      gaps: [],
      deadlineSource: form.deadline ? "Entered by you" : "",
      acquisition: "not_requested",
      language: "en",
      sourceUrl: form.url.trim(),
    };
    update(
      (s) => ({ ...s, opportunities: [opportunity, ...s.opportunities] }),
      "Opportunity added",
      opportunity.title,
    );
    notify("Opportunity added. Open it to upload the RFP.");
    setForm({
      title: "",
      buyer: "",
      reference: "",
      url: "",
      description: "",
      category: "AI & analytics",
      deadline: "",
      time: "17:00",
    });
    setTab("all");
    setSort("newest");
    setPage(1);
    closeAdd();
  };
  return (
    <>
      <PageHeader
        eyebrow="SELECTED FOR PROPOSAL PREPARATION"
        title="Opportunities"
        description="The opportunities you chose to pursue. Open one, upload the RFP, and prepare your proposal file."
        actions={
          <>
            <Button
              onClick={() => {
                setImportOpen(true);
                setError("");
              }}
              disabled={!editable}
            >
              <Upload size={16} />
              Import CSV
            </Button>
            <Button
              variant="primary"
              disabled={!editable}
              onClick={() => setAdd(true)}
            >
              <Plus size={17} />
              Add opportunity
            </Button>
          </>
        }
      />
      <div className="list-summary">
        <span>
          <strong>{selected.length}</strong> selected opportunities
        </span>
        <Link className="text-link" to="/review">
          Review new discoveries →
        </Link>
      </div>
      <section className="panel opportunity-list">
        <Tabs
          active={tab}
          onChange={(id) => resetFilter(() => setTab(id))}
          items={[
            { id: "all", label: "All selected", count: selected.length },
            { id: "shortlisted", label: "Ready to start" },
            { id: "in_progress", label: "Preparing proposal" },
            { id: "submitted", label: "Submitted" },
          ]}
        />
        <div className="filter-bar">
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="Search opportunities"
              placeholder="Search opportunities, buyers, references…"
              value={query}
              onChange={(e) => resetFilter(() => setQuery(e.target.value))}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={15} />
              </button>
            )}
          </div>
          <label className="select-filter">
            <Filter size={15} />
            <span className="sr-only">Filter category</span>
            <select
              value={category}
              onChange={(e) => resetFilter(() => setCategory(e.target.value))}
            >
              <option value="all">All categories</option>
              {[...new Set(state.opportunities.map((o) => o.category))].map(
                (c) => (
                  <option key={c}>{c}</option>
                ),
              )}
            </select>
          </label>
          <label className="select-filter">
            <ArrowDownUp size={15} />
            <span className="sr-only">Sort opportunities</span>
            <select
              value={sort}
              onChange={(e) => resetFilter(() => setSort(e.target.value))}
            >
              <option value="deadline">Closing soon</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
          <Button
            variant="ghost"
            aria-label="Export filtered opportunities"
            title="Export filtered CSV"
            onClick={() => {
              downloadText(
                opportunitiesToCsv(filtered),
                "tenderdesk-opportunities.csv",
                "text/csv;charset=utf-8",
              );
              notify("Filtered opportunities exported");
            }}
          >
            <Download size={17} />
          </Button>
        </div>
        <OpportunityTable items={shown} />
        <div className="pagination">
          <span>
            {filtered.length
              ? `${(currentPage - 1) * 8 + 1}–${Math.min(currentPage * 8, filtered.length)}`
              : "0"}{" "}
            of {filtered.length} opportunities
          </span>
          <div>
            <Button
              size="sm"
              aria-label="Previous page"
              disabled={currentPage === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={16} />
            </Button>
            <span>
              Page {currentPage} of {maxPages}
            </span>
            <Button
              size="sm"
              aria-label="Next page"
              disabled={currentPage === maxPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>
      </section>
      <p className="help-caption">
        New discoveries belong in the Review inbox. Status updates happen inside
        each opportunity; you can return an item to the inbox at any time.
      </p>
      <Modal open={add} onClose={closeAdd} title="Add an opportunity">
        <form onSubmit={submit} className="stack">
          <div className="notice">
            Use a public, sanitized, or synthetic example. This demo saves data
            only in this browser.
          </div>
          <Field label="Opportunity title">
            <input
              required
              maxLength={300}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Customer service automation platform"
              dir="auto"
            />
          </Field>
          <div className="form-grid">
            <Field label="Buyer">
              <input
                maxLength={200}
                value={form.buyer}
                onChange={(e) => setForm({ ...form, buyer: e.target.value })}
                placeholder="Organization name"
                dir="auto"
              />
            </Field>
            <Field label="Reference number (optional)">
              <input
                value={form.reference}
                maxLength={100}
                onChange={(e) =>
                  setForm({ ...form, reference: e.target.value })
                }
                placeholder="RFP-2026-001"
              />
            </Field>
          </div>
          <Field
            label="Source URL"
            hint="Optional. Add the original notice link when available."
          >
            <input
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://…"
            />
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {[
                "AI & analytics",
                "Systems integration",
                "Software development",
                "Digital transformation",
                "Other",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field
              label="Submission date"
              hint="Optional. The closing date stated in the source or RFP."
            >
              <input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              />
            </Field>
            <Field label="Submission time (Riyadh, UTC+3)">
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Description">
            <textarea
              rows={4}
              maxLength={100000}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Scope, deliverables, and what matters for the decision…"
              dir="auto"
            />
          </Field>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button onClick={closeAdd}>Cancel</Button>
            <Button type="submit" variant="primary">
              Add opportunity
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setRows([]);
          setPreviewName("");
          setError("");
        }}
        title="Import opportunities"
      >
        <div className="stack">
          <p className="muted">
            Upload a CSV with <code>title</code> and either{" "}
            <code>external_id</code> or <code>canonical_url</code>. Optional
            columns: buyer_name, description, sector_tags. Imported discoveries
            go to the Review inbox for your decision.
          </p>
          <Button
            size="sm"
            onClick={() =>
              downloadText(
                "title,buyer_name,external_id,canonical_url,description,sector_tags\nSynthetic analytics platform,Fictional buyer,DEMO-101,https://example.com/tenders/demo-101,Public sample for testing,AI & analytics",
                "tenderdesk-import-template.csv",
                "text/csv",
              )
            }
          >
            <Download size={15} />
            Download template
          </Button>
          <Field label="CSV file (up to 1 MiB)">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                setError("");
                setRows([]);
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  if (f.size > 1048576)
                    throw new Error("Choose a CSV smaller than 1 MiB.");
                  setRows(
                    parseOpportunityCsv(await f.text(), state.opportunities),
                  );
                  setPreviewName(f.name);
                } catch (err) {
                  setError(
                    err instanceof Error
                      ? err.message
                      : "Unable to read this CSV.",
                  );
                }
              }}
            />
          </Field>
          {previewName && (
            <p>
              <strong>{previewName}</strong> ·{" "}
              {rows.filter((r) => !r.error && !r.duplicate).length} ready to
              import
            </p>
          )}
          {rows.length > 0 && (
            <div className="table-wrap import-preview">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Title</th>
                    <th>Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      <td>{r.title || "Missing title"}</td>
                      <td>
                        {r.error ? (
                          <span className="form-error">{r.error}</span>
                        ) : (
                          <Badge tone={r.duplicate ? "amber" : "green"}>
                            {r.duplicate ? "Duplicate · skipped" : "Ready"}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !rows.some((r) => !r.error && !r.duplicate) || !editable
              }
              onClick={() => {
                const good = rows
                  .filter((r) => !r.error && !r.duplicate)
                  .map(fromImportRow);
                update(
                  (s) => ({
                    ...s,
                    opportunities: [...good, ...s.opportunities],
                  }),
                  "CSV imported",
                  `${good.length} opportunities`,
                );
                notify(`${good.length} discoveries added to the Review inbox`);
                setImportOpen(false);
                setRows([]);
                setPreviewName("");
                setSort("newest");
                setTab("all");
              }}
            >
              Import valid rows
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
