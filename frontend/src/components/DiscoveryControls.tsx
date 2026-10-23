import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import { MODEL_PROVIDERS } from "../lib/modelProviders";
import {
  SCOPE_LABELS,
  parseScopeKeywords,
  scopeError,
  type ScopeSource,
} from "../lib/discoveryScope";
export default function DiscoveryControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [scope, setScope] = useState<ScopeSource>("company_knowledge");
  const [includeKeywords, setIncludeKeywords] = useState("");
  const [excludeKeywords, setExcludeKeywords] = useState("");
  const [automatic, setAutomatic] = useState(false);
  const [companyKnowledge, setCompanyKnowledge] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [savedScope, setSavedScope] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = state.settings.role === "Owner";
  const scopePolicy = {
    scope,
    include_keywords: parseScopeKeywords(includeKeywords),
    exclude_keywords: parseScopeKeywords(excludeKeywords),
  };
  const validationError = scopeError(scopePolicy);
  async function load() {
    if (!backend) return;
    try {
      const response = await backend.request<{
        workspace: {
          revision: number;
          discovery_policy?: {
            scope: ScopeSource;
            include_keywords?: string[];
            exclude_keywords?: string[];
            auto_public_notices: boolean;
            auto_company_knowledge?: boolean;
            providers: string[];
          };
        };
      }>("/v1/bootstrap");
      const policy = response.data.workspace.discovery_policy;
      setRevision(response.data.workspace.revision);
      const source =
        policy?.scope && policy.scope in SCOPE_LABELS
          ? policy.scope
          : "company_knowledge";
      setScope(source);
      setIncludeKeywords((policy?.include_keywords || []).join("\n"));
      setExcludeKeywords((policy?.exclude_keywords || []).join("\n"));
      setSavedScope(
        JSON.stringify({
          scope: source,
          include_keywords: policy?.include_keywords || [],
          exclude_keywords: policy?.exclude_keywords || [],
        }),
      );
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
    if (!owner || !runCommand || busy || saving || validationError) return;
    setBusy(true);
    const scopeChanged = JSON.stringify(scopePolicy) !== savedScope;
    setError("");
    try {
      await runCommand("discovery.configure", {
        expected_revision: revision,
        ...scopePolicy,
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
          onChange={(e) => setScope(e.target.value as ScopeSource)}
        >
          {Object.entries(SCOPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted small">
        {scope === "company_knowledge"
          ? "The model compares the meaning of the purchased work with the services described in enabled, verified Company Knowledge files and notes. The notice does not need to use the same words."
          : scope === "keywords"
            ? "The model interprets your saved interests by meaning and context, without requiring the same words in the notice. These preferences do not prove company expertise."
            : "The model compares the purchased work with services in Company Knowledge and your saved interests by meaning and context. Configured exclusions take precedence."}
      </p>
      <p className="muted small">
        You do not need to list every unrelated activity as an exclusion.
      </p>
      {scope !== "company_knowledge" && (
        <>
          <Field label="Interest keywords">
            <textarea
              aria-label="Interest keywords"
              dir="auto"
              rows={4}
              value={includeKeywords}
              disabled={!owner || saving || busy || !revision}
              onChange={(e) => setIncludeKeywords(e.target.value)}
            />
          </Field>
          <Field label="Exclusion keywords">
            <textarea
              aria-label="Exclusion keywords"
              dir="auto"
              rows={3}
              value={excludeKeywords}
              disabled={!owner || saving || busy || !revision}
              onChange={(e) => setExcludeKeywords(e.target.value)}
            />
          </Field>
          <p className="muted small">
            Exclusions are optional. Use one term or phrase per line, or
            separate them with commas. Arabic and English are supported. Up to
            24 terms per list, 100 characters each.
          </p>
          {validationError && <p role="alert">{validationError}</p>}
        </>
      )}
      <p className="muted small">
        Delivery capability and eligibility are assessed separately using
        Company Knowledge. Changes to service scope or keywords trigger
        reassessment.
      </p>
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
          !!validationError ||
          ((automatic || companyKnowledge) && !selected.length)
        }
      >
        Save assessment & sharing settings
      </Button>
    </section>
  );
}
