import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
type Row = Record<string, any>;
const PROVIDER_IDS = [
  "gemini_free",
  "qwen_free",
  "groq_free",
  "mistral_free",
  "cloudflare_free",
] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];
type ProviderMeta = {
  id: ProviderId;
  label: string;
  rank: number;
  secretHint: string;
  optional: boolean;
  projectLabel: string;
};
const PROVIDERS: ProviderMeta[] = [
  {
    id: "gemini_free",
    label: "Gemini free tier",
    rank: 1,
    secretHint: "APP_MODEL_GEMINI_*",
    optional: false,
    projectLabel: "Verified Google Cloud project identifier",
  },
  {
    id: "qwen_free",
    label: "Qwen Singapore free quota",
    rank: 2,
    secretHint: "APP_MODEL_QWEN_*",
    optional: false,
    projectLabel: "Verified Singapore workspace identifier",
  },
  {
    id: "groq_free",
    label: "Groq free tier (optional)",
    rank: 3,
    secretHint: "APP_MODEL_GROQ_*",
    optional: true,
    projectLabel: "Verified account label (for your records)",
  },
  {
    id: "mistral_free",
    label: "Mistral free tier (optional)",
    rank: 4,
    secretHint: "APP_MODEL_MISTRAL_*",
    optional: true,
    projectLabel: "Verified account label (for your records)",
  },
  {
    id: "cloudflare_free",
    label: "Cloudflare Workers AI (optional)",
    rank: 5,
    secretHint: "APP_MODEL_CLOUDFLARE_*",
    optional: true,
    projectLabel: "Cloudflare account ID",
  },
];
const isProviderId = (value: string): value is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(value);
const initial = {
  enabled: false,
  provider: "" as ProviderId | "",
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
  failover_rank: 1,
};
const emptyForms = (): Record<ProviderId, typeof initial> =>
  Object.fromEntries(
    PROVIDERS.map((p) => [
      p.id,
      { ...initial, provider: p.id, failover_rank: p.rank },
    ]),
  ) as Record<ProviderId, typeof initial>;
export default function ModelControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [forms, setForms] = useState(emptyForms);
  const [revisions, setRevisions] = useState<Record<ProviderId, number>>(
    Object.fromEntries(PROVIDER_IDS.map((id) => [id, 0])) as Record<
      ProviderId,
      number
    >,
  );
  const [items, setItems] = useState<Row[]>([]);
  const [authorizations, setAuthorizations] = useState<Row[]>([]);
  const [usage, setUsage] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | "">("");
  const [attest, setAttest] = useState(false);
  const [resolution, setResolution] = useState<Row | null>(null);
  const [actualInput, setActualInput] = useState("");
  const [actualOutput, setActualOutput] = useState("");
  const [reason, setReason] = useState("");
  const owner = state.settings.role === "Owner";
  function patchForm(id: ProviderId, patch: Partial<typeof initial>) {
    setForms((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  }
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
      if (
        !Array.isArray(settings.data.records) ||
        !Array.isArray(eligibility.data.items) ||
        !Array.isArray(eligibility.data.authorizations) ||
        !Array.isArray(ledger.data.records)
      )
        throw new Error(
          "The model controls received an invalid response. Reload to retry.",
        );
      const next = emptyForms();
      const nextRevisions = Object.fromEntries(
        PROVIDER_IDS.map((id) => [id, 0]),
      ) as Record<ProviderId, number>;
      for (const m of settings.data.records) {
        const id = m.provider as string;
        if (!isProviderId(id)) continue;
        nextRevisions[id] = m.revision;
        next[id] = {
          ...next[id],
          ...m,
          quota_ends_at: m.quota_ends_at?.slice(0, 16) || "",
        };
      }
      setForms(next);
      setRevisions(nextRevisions);
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
  async function saveProvider(id: ProviderId) {
    const form = forms[id];
    if (!form.model || !form.project_ref || !form.quota_ends_at) {
      setError(
        `Complete model, project, and quota expiry for ${PROVIDERS.find((p) => p.id === id)?.label}.`,
      );
      return false;
    }
    const date = new Date(form.quota_ends_at + "Z");
    if (!Number.isFinite(date.getTime())) {
      setError("Enter a valid UTC expiry.");
      return false;
    }
    return command("model.configure", {
      ...Object.fromEntries(
        Object.keys(initial).map((k) => [k, (form as Row)[k]]),
      ),
      provider: id,
      expected_revision: revisions[id],
      quota_ends_at: date.toISOString(),
    });
  }
  function providerTouched(id: ProviderId) {
    const form = forms[id];
    return (
      form.enabled ||
      form.billing_verified ||
      Boolean(form.model) ||
      Boolean(form.project_ref)
    );
  }
  async function saveAll() {
    for (const p of PROVIDERS) {
      if (!providerTouched(p.id) && revisions[p.id] === 0) continue;
      if (!(await saveProvider(p.id))) return;
    }
  }
  function renderProviderPanel(meta: ProviderMeta) {
    const form = forms[meta.id];
    return (
      <div key={meta.id} className="admin-muted-surface stack">
        <h3>{meta.label}</h3>
        <p className="admin-hint">
          Failover rank {form.failover_rank} · backend{" "}
          <code>{meta.secretHint}</code>
          {meta.optional &&
            " · leave disabled until you add secrets and verify free quota"}
        </p>
        <div className="form-grid">
          <Field label="Exact model identifier">
            <input
              disabled={!owner}
              value={form.model}
              onChange={(e) =>
                patchForm(meta.id, {
                  model: e.target.value,
                  enabled: false,
                })
              }
            />
          </Field>
          <Field label={meta.projectLabel}>
            <input
              disabled={!owner}
              value={form.project_ref}
              onChange={(e) =>
                patchForm(meta.id, {
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
                patchForm(meta.id, { quota_ends_at: e.target.value })
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
                  patchForm(meta.id, { [k]: Number(e.target.value) })
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
              patchForm(meta.id, {
                billing_verified: e.target.checked,
                enabled: false,
              })
            }
          />{" "}
          I verified this project's free billing status and the remaining quota
          in the provider console.
        </label>
        {meta.id === "qwen_free" && (
          <label>
            <input
              type="checkbox"
              disabled={!owner}
              checked={form.free_quota_only}
              onChange={(e) =>
                patchForm(meta.id, {
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
              (meta.id === "qwen_free" && !form.free_quota_only)
            }
            checked={form.enabled}
            onChange={(e) => patchForm(meta.id, { enabled: e.target.checked })}
          />{" "}
          Enable matching backend credentials after verification
        </label>
      </div>
    );
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <h2>Free model and data permissions</h2>
      <p>
        Configure one or more providers. Gemini can run on its own; add Qwen or
        another provider only when you want an additional verified fallback.
        Groq, Mistral, and Cloudflare Workers AI are optional extra slots in the
        same ordered pool. The worker skips disabled profiles and tries the next
        enabled provider when one endpoint is unreachable or waiting on quota.
        Store per-provider <code>APP_MODEL_*</code> secrets in the backend (see
        each panel). This form stores no API key. No paid fallback is available.
        Details: <code>backend/docs/FREE_MODEL_PROVIDERS.md</code>.
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
          <h3>Primary free providers</h3>
          {PROVIDERS.filter((p) => !p.optional).map(renderProviderPanel)}
          <h3>Optional free-tier providers</h3>
          <p>
            Configure only if you verified a free quota and stored matching
            secrets. Untouched optional rows are skipped when you save.
          </p>
          {PROVIDERS.filter((p) => p.optional).map(renderProviderPanel)}
          <Button disabled={!owner || saving} onClick={saveAll}>
            Save provider policies
          </Button>
          <h3>Content permitted for model processing</h3>
          <p>
            Authorize each item for <strong>every</strong> provider that may
            process it. Failover requires matching approvals on all enabled
            providers.
          </p>
          {items.length === 0 && <p>No eligible content has been added.</p>}
          <div className="stack">
            {items.map((item) => (
              <div key={item.entity_kind + item.entity_id}>
                <strong>{item.title}</strong> · {item.entity_kind} ·{" "}
                {PROVIDERS.map((p) => {
                  const auth = authorizations.find(
                    (a) =>
                      a.entity_id === item.entity_id &&
                      a.entity_kind === item.entity_kind &&
                      a.content_hash === item.content_hash &&
                      a.provider === p.id,
                  );
                  return (
                    <span key={p.id}>
                      {p.label}: {auth ? "authorized" : "not authorized"}{" "}
                    </span>
                  );
                })}
                {PROVIDERS.map((p) => (
                  <Button
                    key={p.id}
                    disabled={!owner || saving}
                    onClick={() => {
                      setSelected(item);
                      setSelectedProvider(p.id);
                      setAttest(false);
                    }}
                  >
                    Review for {p.label}
                  </Button>
                ))}
              </div>
            ))}
          </div>
          {selected && selectedProvider && (
            <div className="admin-muted-surface">
              <h3>{selected.title}</h3>
              <p>
                Provider:{" "}
                {PROVIDERS.find((p) => p.id === selectedProvider)?.label}
              </p>
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
                confidential information and may be processed by{" "}
                {selectedProvider}.
              </label>
              <Button
                disabled={!attest || saving}
                onClick={async () => {
                  if (
                    await command("content.authorize", {
                      entity_kind: selected.entity_kind,
                      entity_id: selected.entity_id,
                      content_hash: selected.content_hash,
                      provider: selectedProvider,
                      attestation: "nonconfidential_nonpersonal",
                    })
                  ) {
                    setSelected(null);
                    setSelectedProvider("");
                  }
                }}
              >
                Authorize this text
              </Button>
              <Button
                onClick={() => {
                  setSelected(null);
                  setSelectedProvider("");
                }}
              >
                Close
              </Button>
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
                  {u.provider} · {u.model} · {u.created_at} · reserved{" "}
                  {u.reserved_input} input / {u.reserved_output} output
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
