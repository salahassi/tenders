import { useSearchParams } from "react-router-dom";
import ContentPermissions from "../components/ContentPermissions";
import ModelUsageReview from "../components/ModelUsageReview";
import DiscoveryControls from "../components/DiscoveryControls";
import { useEffect, useState } from "react";
import { ShieldCheck, Users, Check, LockKeyhole } from "lucide-react";
import { useApp } from "../lib/store";
import { Badge, Button, PageHeader, Field } from "../components/ui";
import type { AppState } from "../types";
import "./admin.css";
import MembersPanel from "../components/MembersPanel";
import ModelControls from "../components/ModelControls";
import TemplateManager from "../components/TemplateManager";
import OperationsPanel from "../components/OperationsPanel";
import RecoveryPanel from "../components/RecoveryPanel";
import RateCatalog from "../components/RateCatalog";
import NotificationPreferences from "../components/NotificationPreferences";

export default function Settings() {
  const { state, update, notify, storageError, mode, saving } = useApp();
  const sections = [
    ["workspace", "Workspace"],
    ["models", "Models & providers"],
    ["data", "Assessment & data"],
    ["notifications", "Notifications"],
    ["team", "Team & access"],
    ["proposals", "Proposal defaults"],
    ["operations", "Operations & recovery"],
  ] as const;
  const [params, setParams] = useSearchParams();
  const section = sections.some(([id]) => id === params.get("section"))
    ? params.get("section")!
    : "workspace";
  const [visited, setVisited] = useState(() => new Set(["workspace", section]));
  useEffect(() => {
    setVisited((previous) => new Set([...previous, section]));
  }, [section]);
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
        "Check the company name and numeric limits. Values must stay within the displayed application limits.",
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
        eyebrow="WORKSPACE CONTROLS"
        title="Workspace settings"
        description="Manage connections, processing, data access and workspace administration."
      />
      {storageError && (
        <div className="admin-error" role="alert">
          The server could not confirm this request: {String(storageError)}
        </div>
      )}
      <nav className="settings-navigation" aria-label="Settings sections">
        {sections.map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-current={section === id ? "page" : undefined}
            aria-controls={`settings-${id}`}
            onClick={() => setParams({ section: id })}
          >
            {label}
          </button>
        ))}
      </nav>
      <div
        id="settings-workspace"
        className="stack settings-page-section"
        hidden={section !== "workspace"}
      >
        <section className="panel admin-section">
          <div className="admin-spread">
            <div>
              <h2>Workspace preferences</h2>
              <p className="admin-help">
                {connected
                  ? "Application-wide preferences are saved to your workspace. Model connection details are managed under Models & providers."
                  : "These settings are saved locally for the free trial."}
              </p>
            </div>
            <Badge tone="green">Workspace-wide</Badge>
          </div>
          <p className="admin-hint">
            Automatic processing follows provider responses. Reported token
            usage is logged for visibility and does not stop automatic work.
          </p>
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
              label="Default source polling interval"
              hint="6–168 hours for newly added sources. Existing sources keep their own schedule in Sources."
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
              label="Operational history retention"
              hint="7–365 days for eligible completed operational history. Referenced evidence and usage records are retained."
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
          <h2>Procurement</h2>
          <p>
            Buying tender documents and submitting a bid remain manual actions.
            Email alerts and review reminders are managed under Notifications.
          </p>
        </section>
      </div>
      <div
        id="settings-notifications"
        className="stack settings-page-section"
        hidden={section !== "notifications"}
      >
        {connected && visited.has("notifications") && (
          <NotificationPreferences />
        )}
      </div>
      <div
        id="settings-models"
        className="stack settings-page-section"
        hidden={section !== "models"}
      >
        {connected && visited.has("models") && <ModelControls />}
      </div>
      <div
        id="settings-data"
        className="stack settings-page-section"
        hidden={section !== "data"}
      >
        {visited.has("data") && <DiscoveryControls />}
        {connected && visited.has("data") && <ContentPermissions />}
      </div>
      <div
        id="settings-team"
        className="stack settings-page-section"
        hidden={section !== "team"}
      >
        {" "}
        <section className="panel admin-section">
          <div className="admin-spread">
            <h2>Team roles & access</h2>
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
        {connected && owner && visited.has("team") && <MembersPanel />}
      </div>
      <div
        id="settings-proposals"
        className="stack settings-page-section"
        hidden={section !== "proposals"}
      >
        <p className="admin-help">
          Optional shared rates and document templates. Tender-specific prices
          are entered and reviewed in each proposal.
        </p>
        {connected && visited.has("proposals") && <RateCatalog />}
        {connected && visited.has("proposals") && <TemplateManager />}
      </div>
      <div
        id="settings-operations"
        className="stack settings-page-section"
        hidden={section !== "operations"}
      >
        {visited.has("operations") && <OperationsPanel />}
        {connected && visited.has("operations") && <ModelUsageReview />}
        {visited.has("operations") && <RecoveryPanel />}
      </div>
    </>
  );
}
