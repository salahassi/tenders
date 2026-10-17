import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Search,
  Pencil,
  FileText,
  Upload,
  Download,
  Trash2,
  Eye,
  CheckCircle2,
  FolderOpen,
  Users,
  Building2,
  LayoutTemplate,
} from "lucide-react";
import { useApp } from "../lib/store";
import { extractLocalDocument } from "../lib/documents";
import { date } from "../lib/format";
import {
  getLocalFile,
  removeLocalFile,
  saveLocalFile,
} from "../lib/knowledgeFiles";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Modal,
  Field,
  Tabs,
} from "../components/ui";
import { downloadOriginal } from "../lib/remoteFiles";
import type { KnowledgeDocument, KnowledgeFact } from "../types";
import "./admin.css";
import "./knowledge.css";

const fileCategories: {
  id: KnowledgeDocument["category"];
  label: string;
  icon: typeof FileText;
}[] = [
  { id: "previous_proposal", label: "Previous proposals", icon: FileText },
  { id: "company", label: "Company profile", icon: Building2 },
  { id: "team", label: "Team & resumes", icon: Users },
  { id: "template", label: "Templates & examples", icon: LayoutTemplate },
  { id: "other", label: "Other references", icon: FolderOpen },
];
const noteCategories: { id: KnowledgeFact["category"]; label: string }[] = [
  { id: "capability", label: "Capabilities" },
  { id: "company", label: "Company facts" },
  { id: "exclusion", label: "Exclusions" },
  { id: "rate", label: "Rates" },
  { id: "template", label: "Writing guidance" },
];
const bytesLabel = (size: number) =>
  size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const MAX_KNOWLEDGE_FILES = 200;
const MAX_KNOWLEDGE_NOTES = 3000;
const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : "The file could not be processed.";

export default function Knowledge() {
  const { state, update, notify, ready, mode, backend, saving } = useApp();
  const [active, setActive] = useState("all");
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [category, setCategory] =
    useState<KnowledgeDocument["category"]>("previous_proposal");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<KnowledgeDocument | null>(null);
  const [removing, setRemoving] = useState<KnowledgeDocument | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [fileAvailability, setFileAvailability] = useState<
    Record<string, boolean>
  >({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [noteForm, setNoteForm] = useState({
    category: "capability" as KnowledgeFact["category"],
    title: "",
    content: "",
    evidence: "",
  });
  const documents = state.knowledgeDocuments;
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const canEdit = state.settings.role !== "Reviewer";
  const items = documents.filter(
    (item) =>
      (active === "all" || item.category === active) &&
      `${item.name} ${item.text}`.toLowerCase().includes(search.toLowerCase()),
  );
  const readyCount = documents.filter(
    (item) => item.enabled && item.status === "ready",
  ).length;

  useEffect(() => {
    if (mode === "CONNECTED_FREE") {
      setFileAvailability(
        Object.fromEntries(documents.map((d) => [d.id, true])),
      );
      return;
    }
    let cancelled = false;
    void Promise.all(
      documents.map(async (item) => {
        try {
          return [item.id, Boolean(await getLocalFile(item.id))] as const;
        } catch {
          return [item.id, false] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setFileAvailability(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [documents, mode]);

  const launchUpload = () => {
    setSelectedFiles([]);
    setErrors([]);
    setUploadMessage("");
    setUploadOpen(true);
  };
  const upload = async () => {
    if (!canEdit || !ready || uploading || !selectedFiles.length) return;
    setUploading(true);
    setErrors([]);
    const failures: string[] = [];
    const added: KnowledgeDocument[] = [];
    let restored = 0;
    for (const file of selectedFiles) {
      setUploadMessage(`Reading ${file.name}…`);
      try {
        const record = await extractLocalDocument(file);
        const existing = [...documentsRef.current, ...added].find(
          (item) => item.hash === record.hash,
        );
        if (existing) {
          await saveLocalFile(existing.id, file);
          restored++;
          setFileAvailability((current) => ({
            ...current,
            [existing.id]: true,
          }));
          continue;
        }
        if (documentsRef.current.length + added.length >= MAX_KNOWLEDGE_FILES) {
          throw new Error(
            "This workspace supports up to 200 company files. Remove an unused file before adding another. Existing originals can still be restored.",
          );
        }
        await saveLocalFile(record.id, file);
        added.push({ ...record, category, enabled: true });
      } catch (error) {
        failures.push(`${file.name}: ${messageFor(error)}`);
      }
    }
    if (added.length) {
      const saved = await update(
        (s) => ({
          ...s,
          knowledgeDocuments: [...added, ...s.knowledgeDocuments],
        }),
        "Company reference files uploaded",
        `${added.length} file(s)`,
      );
      if (!saved) {
        setUploading(false);
        setUploadMessage(
          "The files have not all been accepted. Refresh to check accepted files, then retry missing files.",
        );
        return;
      }
    }
    setErrors(failures);
    setUploading(false);
    setUploadMessage("");
    const successMessage = [
      added.length
        ? `${added.length} file${added.length === 1 ? "" : "s"} added.`
        : "",
      restored
        ? `${restored} existing original${restored === 1 ? "" : "s"} restored; no duplicates created.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (successMessage) notify(successMessage);
    if (!failures.length) setUploadOpen(false);
    else setSelectedFiles([]);
  };
  const remove = async () => {
    if (!removing || !canEdit || removeBusy) return;
    setRemoveBusy(true);
    try {
      if (!backend) await removeLocalFile(removing.id);
      const saved = await update(
        (s) => ({
          ...s,
          knowledgeDocuments: s.knowledgeDocuments.filter(
            (item) => item.id !== removing.id,
          ),
        }),
        "Company reference removed",
        removing.id,
      );
      if (!saved) return;
      setRemoving(null);
      notify("The reference was archived; earlier evidence remains available.");
    } catch (error) {
      notify(messageFor(error));
    } finally {
      setRemoveBusy(false);
    }
  };
  const download = async (item: KnowledgeDocument) => {
    try {
      await downloadOriginal(backend, item.id, item.name);
    } catch (error) {
      notify(messageFor(error));
    }
  };
  const launchNote = (item?: KnowledgeFact) => {
    setEditing(item?.id ?? null);
    setNoteForm(
      item
        ? {
            category: item.category,
            title: item.title,
            content: item.content,
            evidence: item.evidence,
          }
        : { category: "capability", title: "", content: "", evidence: "" },
    );
    setNoteError("");
    setNoteOpen(true);
  };
  const saveNote = async () => {
    if (!canEdit) return;
    if (!editing && state.knowledge.length >= MAX_KNOWLEDGE_NOTES) {
      setNoteError(
        "This workspace supports up to 3,000 notes. Edit an existing note instead of adding another.",
      );
      return;
    }
    if (!noteForm.title.trim() || !noteForm.content.trim()) {
      setNoteError("Add a title and note.");
      return;
    }
    const item: KnowledgeFact = {
      ...noteForm,
      id: editing ?? crypto.randomUUID(),
      title: noteForm.title.trim(),
      content: noteForm.content.trim(),
      evidence: noteForm.evidence.trim(),
      verified: false,
    };
    update(
      (s) => ({
        ...s,
        knowledge: editing
          ? s.knowledge.map((fact) => (fact.id === editing ? item : fact))
          : [item, ...s.knowledge],
      }),
      editing ? "Company note updated" : "Company note added",
      item.id,
    );
    setNoteOpen(false);
    notify("Company note saved.");
  };

  return (
    <>
      <PageHeader
        eyebrow="YOUR COMPANY REFERENCE LIBRARY"
        title="Company knowledge"
        description="Upload the files that should inform your proposals: company profiles, team resumes, previous work, and templates."
        actions={
          canEdit ? (
            <Button variant="primary" onClick={launchUpload} disabled={!ready}>
              <Upload size={16} /> Upload files
            </Button>
          ) : undefined
        }
      />
      <section className="knowledge-intro">
        <span className="knowledge-intro-icon">
          <BookOpen size={27} />
        </span>
        <div>
          <h2>Give every proposal the right background.</h2>
          <p>
            Choose eligible company references for proposal preparation. Notes,
            original files and readable text are saved to your private
            workspace. Verify current company facts before using them as
            proposal evidence.
          </p>
          <div className="knowledge-summary">
            <span>
              <strong>{documents.length}</strong> files uploaded
            </span>
            <span>
              <strong>{readyCount}</strong> readable & included
            </span>
          </div>
        </div>
      </section>
      <div className="admin-toolbar">
        <Tabs
          items={[
            { id: "all", label: "All files", count: documents.length },
            ...fileCategories.map((item) => ({
              id: item.id,
              label: item.label,
              count: documents.filter((doc) => doc.category === item.id).length,
            })),
          ]}
          active={active}
          onChange={setActive}
        />
        <div className="admin-search">
          <Search />
          <input
            className="input"
            aria-label="Search company files"
            placeholder="Search files or their content…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {items.length ? (
        <div className="knowledge-file-list">
          {items.map((item) => {
            const fileCategory = fileCategories.find(
              (entry) => entry.id === item.category,
            )!;
            const Icon = fileCategory.icon;
            return (
              <article
                className={`knowledge-file-card ${!item.enabled ? "knowledge-file-excluded" : ""}`}
                key={item.id}
              >
                <div className="knowledge-file-main">
                  <span className="admin-source-icon">
                    <Icon size={23} />
                  </span>
                  <div className="knowledge-file-copy">
                    <h3 dir="auto">{item.name}</h3>
                    <p>
                      {fileCategory.label} · {bytesLabel(item.size)} · Added{" "}
                      {date(item.uploadedAt)}
                    </p>
                    <div className="knowledge-file-state">
                      <Badge
                        tone={
                          item.status === "ready"
                            ? "green"
                            : item.status === "error"
                              ? "red"
                              : "amber"
                        }
                      >
                        {item.status === "ready"
                          ? "Readable text"
                          : item.status === "error"
                            ? "Extraction failed"
                            : "Needs OCR / text review"}
                      </Badge>
                      {fileAvailability[item.id] === false && (
                        <span className="knowledge-missing">
                          Original missing in this browser — upload it again.
                        </span>
                      )}
                    </div>
                    {item.status !== "ready" && (
                      <p className="knowledge-extraction-note">
                        {item.status === "needs_ocr"
                          ? "Some content could not be read. Add a text-based version before using this file as proposal context."
                          : "The extracted content is unavailable. Remove this entry and upload a readable version."}
                      </p>
                    )}
                  </div>
                </div>
                <div className="knowledge-file-actions">
                  <label className="knowledge-include">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={!canEdit}
                      onChange={(event) =>
                        update(
                          (s) => ({
                            ...s,
                            knowledgeDocuments: s.knowledgeDocuments.map(
                              (doc) =>
                                doc.id === item.id
                                  ? { ...doc, enabled: event.target.checked }
                                  : doc,
                            ),
                          }),
                          "Company reference selection changed",
                          item.id,
                        )
                      }
                    />
                    <span>
                      {item.enabled
                        ? "Include as reference"
                        : "Excluded from proposals"}
                    </span>
                  </label>
                  <div className="admin-cell-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreview(item)}
                    >
                      <Eye size={14} /> View text
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void download(item)}
                      disabled={fileAvailability[item.id] === false}
                      aria-label={`Download ${item.name}`}
                    >
                      <Download size={14} /> Original
                    </Button>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setRemoving(item)}
                      >
                        <Trash2 size={15} />
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
          title={
            search || active !== "all"
              ? "No matching files"
              : "Start with your company files"
          }
          description={
            search || active !== "all"
              ? "Try a different category or search."
              : "Add previous proposals, team resumes, company profiles, or examples. PDF, Word, and text files are supported."
          }
          action={
            canEdit && !search && active === "all" ? (
              <Button variant="primary" onClick={launchUpload}>
                <Upload size={16} /> Upload your first files
              </Button>
            ) : undefined
          }
        />
      )}
      <p className="knowledge-storage-note">
        Accepted originals are stored privately and downloaded after an access
        check. Workspace backups include their verified original bytes.
      </p>
      <section className="knowledge-notes">
        <div className="knowledge-section-heading">
          <div>
            <h2>
              Additional notes <span>Optional</span>
            </h2>
            <p>
              Add writing preferences, scope exclusions, or details that are not
              in a file.
            </p>
          </div>
          {canEdit && (
            <Button variant="secondary" onClick={() => launchNote()}>
              <Plus size={15} /> Add note
            </Button>
          )}
        </div>
        {state.knowledge.length ? (
          <div className="knowledge-note-list">
            {state.knowledge.map((item) => (
              <article key={item.id} className="knowledge-note">
                <div>
                  <span className="admin-mini-label">
                    {
                      noteCategories.find(
                        (category) => category.id === item.category,
                      )?.label
                    }
                  </span>
                  <h3 dir="auto">{item.title}</h3>
                  <p dir="auto">{item.content}</p>
                  {item.evidence && <small>Reference: {item.evidence}</small>}
                  <p className="muted small">
                    {item.verified
                      ? "Verified company evidence"
                      : "Not yet verified as company evidence"}
                  </p>
                </div>
                {backend &&
                  state.settings.role === "Owner" &&
                  !item.verified &&
                  item.evidence &&
                  !["previous_proposal", "template"].includes(
                    item.category,
                  ) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={saving}
                      onClick={async () => {
                        await update(
                          (s) => ({
                            ...s,
                            knowledge: s.knowledge.map((fact) =>
                              fact.id === item.id
                                ? { ...fact, verified: true }
                                : fact,
                            ),
                          }),
                          "Verified company evidence",
                          item.id,
                        );
                      }}
                    >
                      Verify company fact
                    </Button>
                  )}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => launchNote(item)}
                    aria-label={`Edit ${item.title}`}
                  >
                    <Pencil size={14} /> Edit
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="admin-help">
            No additional notes. Uploaded files can provide the background on
            their own.
          </p>
        )}
      </section>
      <Modal
        open={uploadOpen}
        title="Upload company files"
        onClose={() => {
          if (!uploading) setUploadOpen(false);
        }}
      >
        <div className="stack">
          <Field label="File category">
            <select
              className="input"
              value={category}
              disabled={uploading}
              onChange={(event) =>
                setCategory(event.target.value as KnowledgeDocument["category"])
              }
            >
              {fileCategories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Files"
            hint="PDF, DOCX, TXT, or Markdown. Up to 10 MiB and 200 PDF pages per file; up to 200 company files per workspace."
          >
            <input
              type="file"
              aria-label="Company reference files"
              className="admin-file-input"
              accept=".pdf,.docx,.txt,.md"
              multiple
              disabled={uploading}
              onChange={(event) => {
                setSelectedFiles(Array.from(event.target.files ?? []));
                setErrors([]);
              }}
            />
          </Field>
          {selectedFiles.length > 0 && (
            <ul className="knowledge-upload-selection">
              {selectedFiles.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  <FileText size={14} />
                  <span dir="auto">{file.name}</span>
                  <small>{bytesLabel(file.size)}</small>
                </li>
              ))}
            </ul>
          )}
          <p className="admin-help">
            The original files and extracted text are stored locally. Scanned
            pages may need OCR; no AI service is called.
          </p>
        </div>
        {errors.length > 0 && (
          <div className="admin-error" role="alert">
            {errors.map((error, index) => (
              <p key={index}>{error}</p>
            ))}
          </div>
        )}
        {uploading && (
          <p className="admin-help" role="status">
            {uploadMessage}
          </p>
        )}
        <div className="admin-form-actions">
          <Button
            variant="secondary"
            onClick={() => setUploadOpen(false)}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void upload()}
            disabled={uploading || !selectedFiles.length}
          >
            {uploading
              ? "Reading files…"
              : `Add ${selectedFiles.length || ""} file${selectedFiles.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </Modal>
      <Modal
        open={Boolean(preview)}
        title={preview?.name ?? "Extracted text"}
        onClose={() => setPreview(null)}
      >
        <p className="admin-help">
          This is the text available for proposal preparation. Check that tables
          and important details were extracted correctly.
        </p>
        <div className="knowledge-text-preview" dir="auto">
          {preview?.text.trim() ||
            "No readable text was extracted from this file."}
        </div>
        <div className="admin-form-actions">
          {backend &&
            preview &&
            preview.status === "ready" &&
            !preview.verified &&
            state.settings.role === "Owner" &&
            !["previous_proposal", "template"].includes(preview.category) && (
              <Button
                variant="primary"
                onClick={async () => {
                  if (
                    await update(
                      (s) => ({
                        ...s,
                        knowledgeDocuments: s.knowledgeDocuments.map((d) =>
                          d.id === preview.id ? { ...d, verified: true } : d,
                        ),
                      }),
                      "Verified company evidence",
                      preview.id,
                    )
                  )
                    setPreview(null);
                }}
              >
                Verify current company evidence
              </Button>
            )}
          <Button variant="secondary" onClick={() => setPreview(null)}>
            Close
          </Button>
        </div>
      </Modal>
      <Modal
        open={Boolean(removing)}
        title="Remove reference file?"
        onClose={() => {
          if (!removeBusy) setRemoving(null);
        }}
      >
        <p className="admin-help">
          Remove <strong dir="auto">{removing?.name}</strong> and its extracted
          text from this workspace? Existing proposal text remains, and any
          approval is reset for review.
        </p>
        <div className="admin-form-actions">
          <Button
            variant="secondary"
            onClick={() => setRemoving(null)}
            disabled={removeBusy}
          >
            Keep file
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            disabled={removeBusy}
          >
            {removeBusy ? "Removing…" : "Remove file"}
          </Button>
        </div>
      </Modal>
      <Modal
        open={noteOpen}
        title={editing ? "Edit company note" : "Add company note"}
        onClose={() => setNoteOpen(false)}
      >
        <div className="stack">
          <Field label="Category">
            <select
              className="input"
              value={noteForm.category}
              onChange={(event) =>
                setNoteForm({
                  ...noteForm,
                  category: event.target.value as KnowledgeFact["category"],
                })
              }
            >
              {noteCategories.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              dir="auto"
              className="input"
              maxLength={160}
              value={noteForm.title}
              onChange={(event) =>
                setNoteForm({ ...noteForm, title: event.target.value })
              }
            />
          </Field>
          <Field label="Note">
            <textarea
              dir="auto"
              className="textarea admin-textarea"
              maxLength={2_000_000}
              value={noteForm.content}
              onChange={(event) =>
                setNoteForm({ ...noteForm, content: event.target.value })
              }
            />
          </Field>
          <Field label="Reference (optional)">
            <input
              dir="auto"
              className="input"
              value={noteForm.evidence}
              maxLength={2_000_000}
              onChange={(event) =>
                setNoteForm({ ...noteForm, evidence: event.target.value })
              }
            />
          </Field>
        </div>
        {noteError && (
          <div className="admin-error" role="alert">
            {noteError}
          </div>
        )}
        <div className="admin-form-actions">
          <Button variant="secondary" onClick={() => setNoteOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={saveNote}>
            <CheckCircle2 size={15} /> Save note
          </Button>
        </div>
      </Modal>
    </>
  );
}
