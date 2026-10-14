import { useEffect, useState } from "react";
import {
  Download,
  Upload,
  RotateCcw,
  ShieldCheck,
  Users,
  Check,
  LockKeyhole,
} from "lucide-react";
import { useApp, serializeBackup, parseBackup } from "../lib/store";
import { Badge, Button, PageHeader, Modal, Field } from "../components/ui";
import type { AppState, Role } from "../types";
import "./admin.css";

export default function Settings() {
  const { state, update, notify, reset, restore, storageError } = useApp();
  const owner = state.settings.role === "Owner";
  const toForm = (s: AppState) => ({
    companyName: s.settings.companyName,
    dailyCallLimit: String(s.settings.dailyCallLimit),
    inputTokenLimit: String(s.settings.inputTokenLimit),
    outputTokenLimit: String(s.settings.outputTokenLimit),
    pollHours: String(s.settings.pollHours),
    retentionDays: String(s.settings.retentionDays),
  });
  const [form, setForm] = useState(() => toForm(state));
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"reset" | "restore" | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [restoreData, setRestoreData] = useState<AppState | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restoreError, setRestoreError] = useState("");
  useEffect(() => {
    setForm(toForm(state));
  }, [
    state.settings.companyName,
    state.settings.dailyCallLimit,
    state.settings.inputTokenLimit,
    state.settings.outputTokenLimit,
    state.settings.pollHours,
    state.settings.retentionDays,
  ]);
  const setRole = (role: Role) => {
    update(
      (s) => ({ ...s, settings: { ...s.settings, role } }),
      "Demo role changed",
      role,
    );
    notify(`Previewing the ${role} role. This is not authentication.`);
  };
  const save = () => {
    if (!owner) return;
    const next = {
      role: state.settings.role,
      ...form,
      dailyCallLimit: Number(form.dailyCallLimit),
      inputTokenLimit: Number(form.inputTokenLimit),
      outputTokenLimit: Number(form.outputTokenLimit),
      pollHours: Number(form.pollHours),
      retentionDays: Number(form.retentionDays),
      companyName: form.companyName.trim(),
    };
    const valid =
      next.companyName &&
      Number.isInteger(next.dailyCallLimit) &&
      next.dailyCallLimit >= 1 &&
      next.dailyCallLimit <= 50 &&
      Number.isInteger(next.inputTokenLimit) &&
      next.inputTokenLimit >= 1000 &&
      next.inputTokenLimit <= 250000 &&
      Number.isInteger(next.outputTokenLimit) &&
      next.outputTokenLimit >= 1000 &&
      next.outputTokenLimit <= 50000 &&
      Number.isInteger(next.pollHours) &&
      next.pollHours >= 6 &&
      next.pollHours <= 168 &&
      Number.isInteger(next.retentionDays) &&
      next.retentionDays >= 7 &&
      next.retentionDays <= 365;
    if (!valid) {
      setError(
        "Check the company name and numeric limits. Values must stay within the displayed trial bounds.",
      );
      return;
    }
    update(
      (s) => ({ ...s, settings: next }),
      "Workspace preferences updated",
      "settings",
    );
    setError("");
    notify("Preferences saved locally. Connected processing remains disabled.");
  };
  const download = () => {
    if (!owner) return;
    try {
      const url = URL.createObjectURL(
        new Blob([serializeBackup(state)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `tender-desk-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(
        "Local workspace backup downloaded. Original attachments are not included.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "The workspace backup could not be downloaded.",
      );
    }
  };
  const chooseRestore = async (file?: File) => {
    setRestoreData(null);
    setRestoreError("");
    setRestoreName("");
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setRestoreError("Choose a JSON backup under 25 MiB.");
      return;
    }
    try {
      const parsed = parseBackup(await file.text());
      setRestoreData(parsed);
      setRestoreName(file.name);
    } catch (e) {
      setRestoreError(
        e instanceof Error ? e.message : "Could not read the backup.",
      );
    }
  };
  const confirm = () => {
    if (!owner) return;
    if (dialog === "reset" && confirmation === "RESET") {
      reset();
      setDialog(null);
      setConfirmation("");
    }
    if (dialog === "restore" && confirmation === "RESTORE" && restoreData) {
      restore(restoreData);
      setDialog(null);
      setConfirmation("");
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Workspace settings"
        description="Set your preferences, preview permissions, and keep control of your data."
      />
      {storageError && (
        <div className="admin-error" role="alert">
          Browser storage could not save your changes: {String(storageError)}.
          Download a backup before closing this page.
        </div>
      )}
      <div className="split-layout">
        <div className="stack">
          <section className="panel admin-section">
            <div className="admin-spread">
              <div>
                <h2>Workspace preferences</h2>
                <p className="admin-help">
                  These settings are saved locally for the free trial.
                </p>
              </div>
              <Badge tone="green">Free only</Badge>
            </div>
            <div className="admin-form-grid">
              <div className="wide">
                <Field label="Workspace / company name">
                  <input
                    dir="auto"
                    className="input"
                    disabled={!owner}
                    maxLength={120}
                    value={form.companyName}
                    onChange={(e) =>
                      setForm({ ...form, companyName: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field
                label="Daily model-call limit"
                hint="1–50 calls. No model calls run in demo mode."
              >
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={50}
                  disabled={!owner}
                  value={form.dailyCallLimit}
                  onChange={(e) =>
                    setForm({ ...form, dailyCallLimit: e.target.value })
                  }
                />
              </Field>
              <Field
                label="Source polling interval"
                hint="6–168 hours, when the backend is connected."
              >
                <input
                  className="input"
                  type="number"
                  min={6}
                  max={168}
                  disabled={!owner}
                  value={form.pollHours}
                  onChange={(e) =>
                    setForm({ ...form, pollHours: e.target.value })
                  }
                />
              </Field>
              <Field
                label="Daily input-token limit"
                hint="1,000–250,000 tokens."
              >
                <input
                  className="input"
                  type="number"
                  min={1000}
                  max={250000}
                  disabled={!owner}
                  value={form.inputTokenLimit}
                  onChange={(e) =>
                    setForm({ ...form, inputTokenLimit: e.target.value })
                  }
                />
              </Field>
              <Field
                label="Daily output-token limit"
                hint="1,000–50,000 tokens."
              >
                <input
                  className="input"
                  type="number"
                  min={1000}
                  max={50000}
                  disabled={!owner}
                  value={form.outputTokenLimit}
                  onChange={(e) =>
                    setForm({ ...form, outputTokenLimit: e.target.value })
                  }
                />
              </Field>
              <Field
                label="History-retention preference"
                hint="7–365 days. No automatic deletion runs in this demo."
              >
                <input
                  className="input"
                  type="number"
                  min={7}
                  max={365}
                  disabled={!owner}
                  value={form.retentionDays}
                  onChange={(e) =>
                    setForm({ ...form, retentionDays: e.target.value })
                  }
                />
              </Field>
            </div>
            {error && (
              <div className="admin-error" role="alert">
                {error}
              </div>
            )}
            <div className="admin-form-actions">
              <Button variant="primary" onClick={save} disabled={!owner}>
                <Check size={15} /> Save preferences
              </Button>
            </div>
          </section>
          <section className="panel admin-section">
            <h2>Automation boundaries</h2>
            <div className="admin-toggle-row">
              <div>
                <h3>Paid provider fallback</h3>
                <p>
                  Quota exhaustion stops work; it never switches to a paid
                  model.
                </p>
              </div>
              <span className="admin-toggle-off">DISABLED</span>
            </div>
            <div className="admin-toggle-row">
              <div>
                <h3>Automatic purchase or submission</h3>
                <p>
                  Buying an RFP and submitting a bid require your manual action.
                </p>
              </div>
              <span className="admin-toggle-off">DISABLED</span>
            </div>
            <div className="admin-toggle-row">
              <div>
                <h3>External notifications</h3>
                <p>
                  In-app updates only. No emails, texts, or third-party
                  messages.
                </p>
              </div>
              <span className="admin-toggle-off">DISABLED</span>
            </div>
          </section>
          <section className="panel admin-section">
            <h2>Backup & restore</h2>
            <p className="admin-help">
              Download your local records, edits, file details, and extracted
              text as JSON. Original attachments are stored separately in this
              browser and are not included in the backup. Keep copies of your
              original files. Restore replaces this browser's current workspace.
            </p>
            <div className="row">
              <Button variant="secondary" onClick={download} disabled={!owner}>
                <Download size={15} /> Download backup
              </Button>
              <Button
                variant="secondary"
                disabled={!owner}
                onClick={() => {
                  setDialog("restore");
                  setConfirmation("");
                  setRestoreData(null);
                  setRestoreError("");
                  setRestoreName("");
                }}
              >
                <Upload size={15} /> Restore backup
              </Button>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="panel admin-section">
            <div className="admin-spread">
              <h2>Preview a role</h2>
              <Badge tone="amber">DEMO ONLY</Badge>
            </div>
            <p className="admin-help">
              Switch views to explore permission behavior. This is a local
              demonstration, not a sign-in or security control.
            </p>
            <div className="admin-role-control">
              {(["Owner", "Editor", "Reviewer"] as Role[]).map((role) => (
                <Button
                  key={role}
                  variant={
                    state.settings.role === role ? "primary" : "secondary"
                  }
                  size="sm"
                  onClick={() => setRole(role)}
                  aria-pressed={state.settings.role === role}
                >
                  {role}
                </Button>
              ))}
            </div>
            <div className="admin-divider" />
            <ul className="admin-feature-list">
              <li>
                <ShieldCheck />
                <span>
                  <strong>Owner</strong>
                  <br />
                  <span className="muted">
                    Manages sources, company files, workspace settings, and
                    proposal content.
                  </span>
                </span>
              </li>
              <li>
                <Users />
                <span>
                  <strong>Editor</strong>
                  <br />
                  <span className="muted">
                    Selects opportunities, uploads files, and edits proposals.
                  </span>
                </span>
              </li>
              <li>
                <LockKeyhole />
                <span>
                  <strong>Reviewer</strong>
                  <br />
                  <span className="muted">
                    Reads opportunities, company references, and proposals.
                  </span>
                </span>
              </li>
            </ul>
          </section>
          <section className="panel admin-section">
            <h2>Users & identity</h2>
            <p className="admin-help">
              No accounts or invitations are created in this frontend demo.
              Connected mode requires verified identities and server-enforced
              roles.
            </p>
            <div className="admin-muted-surface">
              <span className="admin-mini-label">Current simulated role</span>
              <p style={{ margin: "8px 0 0", fontWeight: 600 }}>
                {state.settings.role}
              </p>
            </div>
          </section>
          <section className="panel admin-section admin-danger">
            <h2>Reset demo workspace</h2>
            <p className="admin-help">
              Replace your local edits with the sample data and remove uploaded
              originals from this browser. Download a JSON backup and keep
              separate copies of original files before resetting.
            </p>
            <Button
              variant="danger"
              disabled={!owner}
              onClick={() => {
                setDialog("reset");
                setConfirmation("");
              }}
            >
              <RotateCcw size={15} /> Reset demo
            </Button>
          </section>
        </div>
      </div>
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog === "restore"
            ? "Restore a workspace backup"
            : "Reset your demo workspace"
        }
      >
        {dialog === "restore" ? (
          <>
            <p className="admin-help">
              Restore a version 1 JSON backup under 25 MiB. This replaces the
              current local workspace; it does not reconnect services.
            </p>
            <input
              className="admin-file-input"
              type="file"
              accept="application/json,.json"
              aria-label="Choose workspace backup"
              onChange={(e) => void chooseRestore(e.target.files?.[0])}
            />
            {restoreError && (
              <div className="admin-error" role="alert">
                {restoreError}
              </div>
            )}
            {restoreData && (
              <p className="admin-help">
                Validated {restoreName}: {restoreData.opportunities.length}{" "}
                opportunities, {restoreData.proposals.length} proposals.
              </p>
            )}
            <Field label="Type RESTORE to confirm">
              <input
                className="input"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </>
        ) : (
          <>
            <p className="admin-help">
              This removes local edits and uploaded originals, then restores the
              sample workspace. A JSON backup preserves extracted text but
              cannot restore original attachments.
            </p>
            <Field label="Type RESET to confirm">
              <input
                className="input"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </>
        )}
        <div className="admin-form-actions">
          <Button variant="secondary" onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={confirm}
            disabled={
              !owner ||
              (dialog === "restore"
                ? confirmation !== "RESTORE" || !restoreData
                : confirmation !== "RESET")
            }
          >
            {dialog === "restore" ? "Restore workspace" : "Reset workspace"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
