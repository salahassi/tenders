import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import { MODEL_PROVIDERS } from "../lib/modelProviders";
export default function DiscoveryControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [scope, setScope] = useState("all");
  const [automatic, setAutomatic] = useState(false);
  const [companyKnowledge, setCompanyKnowledge] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [savedScope, setSavedScope] = useState("all");
  const [busy, setBusy] = useState(false);
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend) return;
    try {
      const response = await backend.request<{
        workspace: {
          revision: number;
          discovery_policy?: {
            scope: string;
            auto_public_notices: boolean;
            auto_company_knowledge?: boolean;
            providers: string[];
          };
        };
      }>("/v1/bootstrap");
      const policy = response.data.workspace.discovery_policy;
      setRevision(response.data.workspace.revision);
      setScope(policy?.scope || "all");
      setSavedScope(policy?.scope || "all");
      setAutomatic(policy?.auto_public_notices || false);
      setCompanyKnowledge(policy?.auto_company_knowledge || false);
      setSelected(policy?.providers || []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load discovery settings.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [backend]);
  if (!backend) return null;
  async function save() {
    if (!owner || !runCommand || busy || saving) return;
    setBusy(true);
    const scopeChanged = scope !== savedScope;
    setError("");
    try {
      await runCommand("discovery.configure", {
        expected_revision: revision,
        scope,
        auto_public_notices: automatic,
        auto_company_knowledge: companyKnowledge,
        providers: selected,
      });
      await load();
      notify(
        scopeChanged
          ? "Service scope saved. Existing notices will be reassessed."
          : "Data-sharing settings saved. Existing assessments are preserved.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save discovery settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel admin-section">
      <h2>Assessment & data sharing</h2>
      <p>
        Collected notices enter the review inbox after assessment. Exclusions
        remain available under Outside scope; blocked work appears under Needs
        attention.
      </p>
      {error && <p role="alert">{error}</p>}
      <Field label="Company service scope">
        <select
          aria-label="Company service scope"
          value={scope}
          disabled={!owner || saving || busy || !revision}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="all">Use verified company profile</option>
          <option value="software_services">
            Software, digital transformation and AI — no hardware
          </option>
        </select>
      </Field>
      <label>
        <input
          type="checkbox"
          checked={automatic}
          disabled={!owner || saving || busy || !revision}
          onChange={(e) => setAutomatic(e.target.checked)}
        />{" "}
        Automatically assess public collector notices
      </label>
      <p className="muted small">
        Allows exact public notices from approved collectors to be sent to the
        selected providers. Explicitly revoked content remains excluded.
      </p>
      <label>
        <input
          type="checkbox"
          checked={companyKnowledge}
          disabled={!owner || saving || busy || !revision}
          onChange={(e) => setCompanyKnowledge(e.target.checked)}
        />{" "}
        Include Company Knowledge in model processing
      </label>
      <p className="muted small">
        Allows the selected providers to compare tenders with enabled, verified
        company files and notes, including expertise, projects, capabilities and
        qualifications. New files and updated notes follow this setting once
        enabled and verified. Disabled, expired and explicitly revoked evidence
        stays excluded.
      </p>
      <h3>Providers allowed to receive this data</h3>
      <p>
        These choices grant data-processing permission. They do not configure an
        API key, enable a connection or change provider order. Manage those
        under <a href="#/settings?section=models">Models &amp; providers</a>.
      </p>
      <div className="permission-providers">
        {MODEL_PROVIDERS.map(({ id: provider, label }) => (
          <label className="admin-inline-check" key={provider}>
            <input
              type="checkbox"
              checked={selected.includes(provider)}
              disabled={!owner || saving || busy || !revision}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, provider]
                    : selected.filter((p) => p !== provider),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <Button
        onClick={() => void save()}
        disabled={
          !owner ||
          !revision ||
          saving ||
          busy ||
          ((automatic || companyKnowledge) && !selected.length)
        }
      >
        Save assessment & sharing settings
      </Button>
    </section>
  );
}
