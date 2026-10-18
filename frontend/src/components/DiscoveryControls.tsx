import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
const providers = [
  "gemini_free",
  "qwen_free",
  "mistral_free",
  "groq_free",
  "cloudflare_free",
  "zai_free",
];
export default function DiscoveryControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [scope, setScope] = useState("all");
  const [automatic, setAutomatic] = useState(false);
  const [companyKnowledge, setCompanyKnowledge] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
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
    if (!owner || !runCommand) return;
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
      notify("Discovery scope saved. Existing notices will be reassessed.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save discovery settings.",
      );
    }
  }
  return (
    <section className="panel admin-section">
      <h2>Discovery scope</h2>
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
          disabled={!owner}
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
          disabled={!owner}
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
          disabled={!owner}
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
      {providers.map((provider) => (
        <label className="row" key={provider}>
          <input
            type="checkbox"
            checked={selected.includes(provider)}
            disabled={!owner}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, provider]
                  : selected.filter((p) => p !== provider),
              )
            }
          />
          {provider.replace("_free", "")}
        </label>
      ))}
      <Button
        onClick={() => void save()}
        disabled={
          !owner ||
          !revision ||
          saving ||
          ((automatic || companyKnowledge) && !selected.length)
        }
      >
        Save discovery settings
      </Button>
    </section>
  );
}
