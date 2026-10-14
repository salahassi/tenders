import { useState } from "react";
import {
  BookOpen,
  Plus,
  Search,
  CheckCircle2,
  Pencil,
  ShieldCheck,
  Building2,
  Layers3,
  Ban,
  Coins,
  FileText,
} from "lucide-react";
import { useApp } from "../lib/store";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Modal,
  Field,
  Tabs,
} from "../components/ui";
import type { KnowledgeFact } from "../types";
import "./admin.css";
const categories = [
  { id: "all", label: "All knowledge" },
  { id: "capability", label: "Capabilities" },
  { id: "company", label: "Company facts" },
  { id: "exclusion", label: "Exclusions" },
  { id: "rate", label: "Rates" },
  { id: "template", label: "Templates" },
];
const icons = {
  capability: Layers3,
  company: Building2,
  exclusion: Ban,
  rate: Coins,
  template: FileText,
};
export default function Knowledge() {
  const { state, update, notify } = useApp();
  const [active, setActive] = useState("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({
    category: "capability" as KnowledgeFact["category"],
    title: "",
    content: "",
    evidence: "",
  });
  const canEdit = state.settings.role !== "Reviewer",
    owner = state.settings.role === "Owner";
  const items = state.knowledge.filter(
    (k) =>
      (active === "all" || k.category === active) &&
      `${k.title} ${k.content}`.toLowerCase().includes(search.toLowerCase()),
  );
  const launch = (k?: KnowledgeFact) => {
    setEditing(k?.id ?? null);
    setForm(
      k
        ? {
            category: k.category,
            title: k.title,
            content: k.content,
            evidence: k.evidence,
          }
        : {
            category:
              active === "all"
                ? "capability"
                : (active as KnowledgeFact["category"]),
            title: "",
            content: "",
            evidence: "",
          },
    );
    setError("");
    setOpen(true);
  };
  const save = () => {
    if (!canEdit) return;
    if (!form.title.trim() || !form.content.trim()) {
      setError("A title and description are required.");
      return;
    }
    const fact: KnowledgeFact = {
      ...form,
      id: editing ?? crypto.randomUUID(),
      title: form.title.trim(),
      content: form.content.trim(),
      evidence: form.evidence.trim(),
      verified: false,
    };
    update(
      (s) => ({
        ...s,
        knowledge: editing
          ? s.knowledge.map((k) => (k.id === editing ? fact : k))
          : [fact, ...s.knowledge],
      }),
      editing ? "Knowledge updated; verification reset" : "Knowledge added",
      fact.id,
    );
    setOpen(false);
    notify(
      "Saved as a draft. Owner verification is required before approved reuse.",
    );
  };
  const verify = (k: KnowledgeFact) => {
    if (!owner) return;
    if (!k.evidence.trim()) {
      notify("Add an evidence reference before verifying this item.");
      launch(k);
      return;
    }
    update(
      (s) => ({
        ...s,
        knowledge: s.knowledge.map((x) =>
          x.id === k.id ? { ...x, verified: !x.verified } : x,
        ),
      }),
      k.verified ? "Knowledge verification removed" : "Knowledge verified",
      k.id,
    );
    notify(
      k.verified
        ? "Verification removed."
        : "Item marked verified by the demo Owner.",
    );
  };
  return (
    <>
      <PageHeader
        eyebrow="YOUR COMPANY, CONSISTENTLY"
        title="Knowledge base"
        description="The facts, capabilities, and writing guidance behind every proposal."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => launch()}>
              <Plus size={16} /> Add knowledge
            </Button>
          ) : undefined
        }
      />
      <div className="admin-state-banner">
        <BookOpen size={22} />
        <div>
          <strong>Better proposals start with trusted knowledge.</strong>
          <p>
            Keep claims grounded in evidence. Demo entries are illustrative;
            replace them with approved, nonconfidential information for your
            trial.
          </p>
        </div>
      </div>
      <div className="admin-toolbar">
        <Tabs
          items={categories.map((c) => ({
            ...c,
            count:
              c.id === "all"
                ? state.knowledge.length
                : state.knowledge.filter((k) => k.category === c.id).length,
          }))}
          active={active}
          onChange={setActive}
        />
        <div className="admin-search">
          <Search />
          <input
            className="input"
            aria-label="Search knowledge"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a fact or capability…"
          />
        </div>
      </div>
      {items.length ? (
        <div className="admin-card-grid">
          {items.map((k) => {
            const Icon = icons[k.category];
            return (
              <article className="admin-card" key={k.id}>
                <div className="admin-spread">
                  <div className="admin-icon-title">
                    <span className="admin-source-icon">
                      <Icon size={20} />
                    </span>
                    <span className="admin-mini-label">{k.category}</span>
                  </div>
                  <Badge tone={k.verified ? "green" : "amber"}>
                    {k.verified ? "Verified" : "Draft"}
                  </Badge>
                </div>
                <h3 dir="auto">{k.title}</h3>
                <p
                  dir="auto"
                  className="small muted"
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {k.content}
                </p>
                <div className="admin-evidence">
                  <strong>Evidence: </strong>
                  {k.evidence || "Not provided"}
                </div>
                <div className="admin-card-foot">
                  <span className="small muted">
                    {k.verified ? (
                      <>
                        <ShieldCheck
                          size={13}
                          style={{ verticalAlign: "middle" }}
                        />{" "}
                        Approved for reuse
                      </>
                    ) : (
                      "Awaiting Owner verification"
                    )}
                  </span>
                  <div className="admin-cell-actions">
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => launch(k)}
                      >
                        <Pencil size={13} /> Edit
                      </Button>
                    )}
                    {owner && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => verify(k)}
                      >
                        {k.verified ? (
                          "Unverify"
                        ) : (
                          <>
                            <CheckCircle2 size={13} /> Verify
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No knowledge items yet"
          description="Add verified capabilities, company facts, exclusions, or reusable writing guidance."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => launch()}>
                Add an item
              </Button>
            ) : undefined
          }
        />
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit knowledge" : "Add knowledge"}
      >
        <div className="stack">
          <Field label="Category">
            <select
              className="input"
              value={form.category}
              onChange={(e) =>
                setForm({
                  ...form,
                  category: e.target.value as KnowledgeFact["category"],
                })
              }
            >
              {categories
                .filter((c) => c.id !== "all")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              dir="auto"
              className="input"
              maxLength={160}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field
            label={
              form.category === "template"
                ? "Writing and structure guidance"
                : "Description"
            }
            hint={
              form.category === "rate"
                ? "Record currency, unit, validity period, and rate source. Proposal calculations are completed in the financial editor."
                : undefined
            }
          >
            <textarea
              dir="auto"
              className="textarea admin-textarea"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
            />
          </Field>
          <Field
            label="Evidence reference"
            hint="A public URL, approved record identifier, or an explicit synthetic example reference."
          >
            <input
              dir="auto"
              className="input"
              value={form.evidence}
              onChange={(e) => setForm({ ...form, evidence: e.target.value })}
              placeholder="Source or approved reference"
            />
          </Field>
        </div>
        {editing && (
          <p className="admin-help">
            Saving an edit resets verification so that changed claims can be
            reviewed again.
          </p>
        )}
        {error && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        <div className="admin-form-actions">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save draft
          </Button>
        </div>
      </Modal>
    </>
  );
}
