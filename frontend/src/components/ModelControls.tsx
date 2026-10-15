import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
type Row = Record<string, any>;
const initial = {
  enabled: false,
  provider: "",
  model: "",
  project_ref: "",
  free_only: true,
  billing_verified: false,
  free_quota_only: false,
  quota_ends_at: "",
  quota_remaining_tokens: 0,
  calls_per_day: 50,
  input_per_day: 250000,
  output_per_day: 50000,
};
export default function ModelControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [form, setForm] = useState(initial),
    [revision, setRevision] = useState(0),
    [items, setItems] = useState<Row[]>([]),
    [authorizations, setAuthorizations] = useState<Row[]>([]),
    [usage, setUsage] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [attest, setAttest] = useState(false),
    [resolution, setResolution] = useState<Row | null>(null),
    [actualInput, setActualInput] = useState(""),
    [actualOutput, setActualOutput] = useState(""),
    [reason, setReason] = useState("");
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend) return;
    try {
      const [settings, eligibility, ledger] = await Promise.all([
        backend.request<{ records: Row[] }>("/v1/model-settings"),
        backend.request<{ items: Row[]; authorizations: Row[] }>(
          "/v1/eligibility",
        ),
        backend.request<{ records: Row[] }>("/v1/provider-usage?state=unknown"),
      ]);
      if(!Array.isArray(settings.data.records)||!Array.isArray(eligibility.data.items)||!Array.isArray(eligibility.data.authorizations)||!Array.isArray(ledger.data.records))throw new Error("The model controls received an invalid response. Reload to retry.");
      const m = settings.data.records[0];
      if (m) {
        setRevision(m.revision);
        setForm({
          ...initial,
          ...m,
          quota_ends_at: m.quota_ends_at?.slice(0, 16) || "",
        });
      }
      setItems(eligibility.data.items);
      setAuthorizations(eligibility.data.authorizations);
      setUsage(ledger.data.records);
      setReady(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load model settings.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [backend]);
  async function command(operation: string, input: Row) {
    if (!runCommand) return;
    setError("");
    try {
      await runCommand(operation, input);
      await load();
      notify("Saved by the server.");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
      return false;
    }
  }
  async function save() {
    if (
      !form.provider ||
      !form.model ||
      !form.project_ref ||
      !form.quota_ends_at
    ) {
      setError(
        "Select a provider and record the exact model, project and verified quota expiry.",
      );
      return;
    }
    const date = new Date(form.quota_ends_at + "Z");
    if (!Number.isFinite(date.getTime())) {
      setError("Enter a valid UTC expiry.");
      return;
    }
    await command("model.configure", {
      ...Object.fromEntries(
        Object.keys(initial).map((k) => [k, (form as Row)[k]]),
      ),
      expected_revision: revision,
      quota_ends_at: date.toISOString(),
    });
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <h2>Free model and data permissions</h2>
      <p>
        Model selection is pending until you choose and verify a free account.
        Credentials belong in the backend secret store. This form stores no API
        key. No paid fallback is available.
      </p>
      {error && (
        <div role="alert" className="admin-error">
          {error}
        </div>
      )}
      {!ready ? (
        <p>Loading model settings…</p>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Provider">
              <select
                disabled={!owner || saving}
                value={form.provider}
                onChange={(e) =>
                  setForm({
                    ...form,
                    provider: e.target.value,
                    enabled: false,
                    billing_verified: false,
                    free_quota_only: false,
                  })
                }
              >
                <option value="">Choose later</option>
                <option value="gemini_free">Gemini free tier</option>
                <option value="qwen_free">Qwen Singapore free quota</option>
              </select>
            </Field>
            <Field label="Exact model identifier">
              <input
                disabled={!owner}
                value={form.model}
                onChange={(e) =>
                  setForm({ ...form, model: e.target.value, enabled: false })
                }
              />
            </Field>
            <Field label="Verified project / workspace identifier">
              <input
                disabled={!owner}
                value={form.project_ref}
                onChange={(e) =>
                  setForm({
                    ...form,
                    project_ref: e.target.value,
                    enabled: false,
                  })
                }
              />
            </Field>
            <Field label="Free quota expiry (UTC)">
              <input
                type="datetime-local"
                disabled={!owner}
                value={form.quota_ends_at}
                onChange={(e) =>
                  setForm({ ...form, quota_ends_at: e.target.value })
                }
              />
            </Field>
            {(
              [
                "quota_remaining_tokens",
                "calls_per_day",
                "input_per_day",
                "output_per_day",
              ] as const
            ).map((k) => (
              <Field key={k} label={k.replaceAll("_", " ")}>
                <input
                  type="number"
                  min={1}
                  disabled={!owner}
                  value={form[k]}
                  onChange={(e) =>
                    setForm({ ...form, [k]: Number(e.target.value) })
                  }
                />
              </Field>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              disabled={!owner}
              checked={form.billing_verified}
              onChange={(e) =>
                setForm({
                  ...form,
                  billing_verified: e.target.checked,
                  enabled: false,
                })
              }
            />{" "}
            I verified this project's free billing status and the remaining
            quota in the provider console.
          </label>
          {form.provider === "qwen_free" && (
            <label>
              <input
                type="checkbox"
                disabled={!owner}
                checked={form.free_quota_only}
                onChange={(e) =>
                  setForm({
                    ...form,
                    free_quota_only: e.target.checked,
                    enabled: false,
                  })
                }
              />{" "}
              Free Quota Only is enabled and effective for this Singapore model.
            </label>
          )}
          <label>
            <input
              type="checkbox"
              disabled={
                !owner ||
                !form.billing_verified ||
                (form.provider === "qwen_free" && !form.free_quota_only)
              }
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />{" "}
            Enable matching backend credentials after verification
          </label>
          <Button disabled={!owner || saving} onClick={save}>
            Save model policy
          </Button>
          <h3>Content permitted for model processing</h3>
          <p>
            Open each item and check its complete text. Approval is tied to its
            current content and the selected provider. Changes require new
            approval. Personal or confidential content must stay out of
            free-provider requests; a checkbox does not make it suitable.
          </p>
          {items.length === 0 && <p>No eligible content has been added.</p>}
          <div className="stack">
            {items.map((item) => {
              const auth = authorizations.find(
                (a) =>
                  a.entity_id === item.entity_id &&
                  a.entity_kind === item.entity_kind &&
                  a.content_hash === item.content_hash &&
                  a.provider === form.provider,
              );
              return (
                <div key={item.entity_kind + item.entity_id}>
                  <strong>{item.title}</strong> · {item.entity_kind} ·{" "}
                  {auth ? "Authorized for selected provider" : "Not authorized"}{" "}
                  <Button
                    disabled={!owner || !form.provider || saving}
                    onClick={() => {
                      setSelected(item);
                      setAttest(false);
                    }}
                  >
                    Review text
                  </Button>
                  {auth && (
                    <Button
                      disabled={!owner || saving}
                      onClick={() =>
                        command("content.revoke", {
                          id: auth.id,
                          expected_revision: auth.revision,
                        })
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {selected && (
            <div className="admin-muted-surface">
              <h3>{selected.title}</h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 360,
                  overflow: "auto",
                  overflowWrap: "anywhere",
                }}
                dir="auto"
              >
                {selected.content}
              </pre>
              <label>
                <input
                  type="checkbox"
                  checked={attest}
                  onChange={(e) => setAttest(e.target.checked)}
                />{" "}
                I reviewed this exact text. It contains no personal or
                confidential information and may be processed by {form.provider}
                .
              </label>
              <Button
                disabled={!attest || saving}
                onClick={async () => {
                  if (
                    await command("content.authorize", {
                      entity_kind: selected.entity_kind,
                      entity_id: selected.entity_id,
                      content_hash: selected.content_hash,
                      provider: form.provider,
                      attestation: "nonconfidential_nonpersonal",
                    })
                  )
                    setSelected(null);
                }}
              >
                Authorize this text
              </Button>
              <Button onClick={() => setSelected(null)}>Close</Button>
            </div>
          )}
          <h3>Usage requiring review</h3>
          <p>
            Unknown usage keeps its reserved allowance. Reconcile only against
            the provider's usage record.
          </p>
          {usage
            .filter((u) => u.state === "unknown")
            .map((u) => (
              <div key={u.id}>
                <p>
                  {u.model} · {u.created_at} · reserved {u.reserved_input} input
                  / {u.reserved_output} output
                </p>
                <Button
                  disabled={!owner || saving}
                  onClick={() => {
                    setResolution(u);
                    setActualInput("");
                    setActualOutput("");
                    setReason("");
                  }}
                >
                  Reconcile usage
                </Button>
              </div>
            ))}
          {!usage.some((u) => u.state === "unknown") && (
            <p>No unresolved usage in the loaded records.</p>
          )}
          {resolution && (
            <div className="admin-muted-surface">
              <Field label="Measured input tokens">
                <input
                  type="number"
                  min={0}
                  value={actualInput}
                  onChange={(e) => setActualInput(e.target.value)}
                />
              </Field>
              <Field label="Measured total output, including thinking">
                <input
                  type="number"
                  min={0}
                  value={actualOutput}
                  onChange={(e) => setActualOutput(e.target.value)}
                />
              </Field>
              <Field label="Provider record reference and explanation">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <Button
                disabled={
                  saving ||
                  !actualInput ||
                  !actualOutput ||
                  reason.trim().length < 10
                }
                onClick={async () => {
                  if (
                    await command("usage.resolve", {
                      id: resolution.id,
                      expected_revision: resolution.revision,
                      actual_input: Number(actualInput),
                      actual_output: Number(actualOutput),
                      thinking_tokens: null,
                      reason,
                    })
                  )
                    setResolution(null);
                }}
              >
                Record verified usage
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
