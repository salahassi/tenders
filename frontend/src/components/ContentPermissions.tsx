import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import {
  MODEL_PROVIDERS,
  providerLabel,
  type ProviderId,
} from "../lib/modelProviders";
import { Button, Field } from "./ui";
type Row = Record<string, any>;
export default function ContentPermissions() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const owner = state.settings.role === "Owner";
  const [items, setItems] = useState<Row[]>([]),
    [authorizations, setAuthorizations] = useState<Row[]>([]);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [provider, setProvider] = useState<ProviderId>("gemini_free"),
    [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Row | null>(null),
    [attest, setAttest] = useState(false);
  async function load() {
    if (!backend) return;
    const response = await backend.request<{
      items: Row[];
      authorizations: Row[];
    }>("/v1/eligibility");
    if (
      !Array.isArray(response.data.items) ||
      !Array.isArray(response.data.authorizations)
    )
      throw new Error("Unable to load content permissions.");
    setItems(response.data.items);
    setAuthorizations(response.data.authorizations);
    setReady(true);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [backend]);
  async function authorize() {
    if (!owner || !runCommand || !selected || !attest || busy || saving) return;
    setBusy(true);
    setError("");
    try {
      await runCommand("content.authorize", {
        entity_kind: selected.entity_kind,
        entity_id: selected.entity_id,
        content_hash: selected.content_hash,
        provider,
        attestation: "nonconfidential_nonpersonal",
      });
      await load();
      setSelected(null);
      setAttest(false);
      notify("Permission saved for this text and provider.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Permission could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!backend) return null;
  const filtered = items.filter((i) =>
    String(i.title).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="panel admin-section">
      <h2>Individual content permissions</h2>
      <p>
        Use this for a specific document or text that needs a separate review.
        The workspace sharing policy above handles eligible public notices and
        Company Knowledge. An individual permission record is not the full
        processing decision.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      <details className="settings-details">
        <summary>
          Review individual documents and notices
          {ready ? ` (${items.length})` : ""}
        </summary>
        <div className="admin-form-grid">
          <Field label="Provider for this review">
            <select
              value={provider}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                setSelected(null);
                setAttest(false);
              }}
            >
              {MODEL_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Find content by title">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
        </div>
        {!ready ? (
          <p>Loading content…</p>
        ) : (
          <>
            <p>
              {filtered.length} matching items. Showing up to 25; narrow the
              search to find another item.
            </p>
            <ul className="permission-list">
              {filtered.slice(0, 25).map((item) => {
                const auth = authorizations.find(
                  (a) =>
                    a.entity_id === item.entity_id &&
                    a.entity_kind === item.entity_kind &&
                    a.content_hash === item.content_hash &&
                    a.provider === provider,
                );
                const status = !auth
                  ? "No current individual permission record; workspace policy may apply."
                  : auth.authorization_basis === "company_knowledge_policy"
                    ? "Recorded through Company Knowledge policy; current policy and evidence are checked when used."
                    : "Individual permission recorded for this exact text.";
                return (
                  <li key={item.entity_kind + item.entity_id}>
                    <div>
                      <strong dir="auto">{item.title}</strong>
                      <p className="admin-hint">
                        {item.entity_kind} · {status}
                      </p>
                    </div>
                    <Button
                      disabled={!owner || saving || busy}
                      onClick={() => {
                        setSelected(item);
                        setAttest(false);
                      }}
                    >
                      Review text
                    </Button>
                  </li>
                );
              })}
            </ul>
            {!filtered.length && <p>No matching content.</p>}
          </>
        )}
        {selected && (
          <div className="admin-muted-surface">
            <h3 dir="auto">{selected.title}</h3>
            <p>Provider: {providerLabel(provider)}</p>
            <pre className="permission-preview" dir="auto">
              {selected.content}
            </pre>
            <label>
              <input
                type="checkbox"
                checked={attest}
                disabled={!owner || busy}
                onChange={(e) => setAttest(e.target.checked)}
              />{" "}
              I reviewed this exact text. It contains no personal or
              confidential information and may be processed by{" "}
              {providerLabel(provider)}.
            </label>
            <div className="admin-toolbar">
              <Button
                disabled={!owner || !attest || busy || saving}
                onClick={() => void authorize()}
              >
                Authorize this text
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  setAttest(false);
                }}
              >
                Close review
              </Button>
            </div>
          </div>
        )}
      </details>
    </section>
  );
}
