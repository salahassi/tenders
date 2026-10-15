import { useEffect, useState } from "react";
import { ShieldCheck, Users, Check, LockKeyhole } from "lucide-react";
import { useApp } from "../lib/store";
import { Badge, Button, PageHeader, Field } from "../components/ui";
import type { AppState } from "../types";
import "./admin.css";
import MembersPanel from "../components/MembersPanel";
import ModelControls from "../components/ModelControls";
import TemplateManager from "../components/TemplateManager";
import RecoveryPanel from "../components/RecoveryPanel";
import RateCatalog from "../components/RateCatalog";

export default function Settings() {
  const { state, update, notify, storageError, mode, saving } = useApp();
  const connected = mode === "CONNECTED_FREE";
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
  const save = async () => {
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
    if (
      !(await update(
        (s) => ({ ...s, settings: next }),
        "Workspace preferences updated",
        "settings",
      ))
    ) {
      return;
    }
    setError("");
    notify(
      connected
        ? "Workspace preferences saved to your account."
        : "Preferences saved locally. Connected processing remains disabled.",
    );
  };
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Workspace settings"
        description="Set your preferences and manage workspace access."
      />
      {storageError && (
        <div className="admin-error" role="alert">
          {connected
            ? "The server could not confirm this request: "
            : "Browser storage could not save your changes: "}
          {String(storageError)}
        </div>
      )}
      <div className="split-layout">
        <div className="stack">
          <section className="panel admin-section">
            <div className="admin-spread">
              <div>
                <h2>Workspace preferences</h2>
                <p className="admin-help">
                  {connected
                    ? "Preferences are saved to your workspace. Processing stays inactive until its services are configured."
                    : "These settings are saved locally for the free trial."}
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
                hint="1–50 calls. Model execution is not activated."
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
                hint="7–365 days. Automatic retention is not activated."
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
              <Button
                variant="primary"
                onClick={save}
                disabled={!owner || saving}
              >
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
          <RecoveryPanel />
        </div>
        <div className="stack">
          <section className="panel admin-section">
            <div className="admin-spread">
              <h2>Workspace permissions</h2>
              <Badge tone="amber">{state.settings.role}</Badge>
            </div>
            <p className="admin-help">
              Your verified workspace membership determines permissions.
            </p>
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
              Your account’s workspace membership and permissions are checked by
              the server.
            </p>
            <div className="admin-muted-surface">
              <span className="admin-mini-label">Current workspace role</span>
              <p style={{ margin: "8px 0 0", fontWeight: 600 }}>
                {state.settings.role}
              </p>
            </div>
          </section>
          {connected && owner && <MembersPanel />}
          {connected && <ModelControls />}
          {connected && <RateCatalog />}
          {connected && <TemplateManager />}
        </div>
      </div>
    </>
  );
}
