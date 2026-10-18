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
  "zai_free",
] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];
type ServerModel = {
  provider: ProviderId;
  model: string;
  project_ref: string;
  key_configured: boolean;
};
type ProviderMeta = {
  id: ProviderId;
  label: string;
  rank: number;
  secretHint: string;
  optional: boolean;
  projectLabel: string;
};
const DEFAULT_ORDER: ProviderId[] = [
  "gemini_free",
  "qwen_free",
  "mistral_free",
  "groq_free",
  "zai_free",
];
const continuousProviders: readonly string[] = PROVIDER_IDS;
const PROVIDERS: ProviderMeta[] = [
  {
    id: "gemini_free",
    label: "Gemini",
    rank: 1,
    secretHint: "APP_MODEL_GEMINI_*",
    optional: false,
    projectLabel: "Google Cloud project identifier",
  },
  {
    id: "qwen_free",
    label: "Qwen (Singapore)",
    rank: 2,
    secretHint: "APP_MODEL_QWEN_*",
    optional: false,
    projectLabel: "Singapore workspace identifier",
  },
  {
    id: "groq_free",
    label: "Groq (optional)",
    rank: 3,
    secretHint: "APP_MODEL_GROQ_*",
    optional: true,
    projectLabel: "Account label (for your records)",
  },
  {
    id: "mistral_free",
    label: "Mistral (optional)",
    rank: 4,
    secretHint: "APP_MODEL_MISTRAL_*",
    optional: true,
    projectLabel: "Account label (for your records)",
  },
  {
    id: "zai_free",
    label: "z.ai (optional)",
    rank: 6,
    secretHint: "APP_MODEL_ZAI_*",
    optional: true,
    projectLabel: "Account label (for your records)",
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
  free_only: false,
  billing_verified: false,
  free_quota_only: false,
  quota_mode: "verified_budget" as "verified_budget" | "provider_managed",
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
      {
        ...initial,
        provider: p.id,
        failover_rank: p.rank,
        quota_mode: continuousProviders.includes(p.id)
          ? "provider_managed"
          : "verified_budget",
      },
    ]),
  ) as Record<ProviderId, typeof initial>;
export default function ModelControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const [forms, setForms] = useState(emptyForms);
  const [serverModels, setServerModels] = useState<ServerModel[]>([]);
  const [geminiSavedEnabled, setGeminiSavedEnabled] = useState(false);
  const [probeQueued, setProbeQueued] = useState(false);
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
  const [routing, setRouting] = useState<Row>({ enabled: false, revision: 0 });
  const [providerOrder, setProviderOrder] =
    useState<ProviderId[]>(DEFAULT_ORDER);
  const [strategy, setStrategy] = useState<"priority" | "round_robin">(
    "priority",
  );
  function moveProvider(index: number, change: number) {
    setProviderOrder((previous) => {
      const next = [...previous];
      [next[index], next[index + change]] = [next[index + change], next[index]];
      return next;
    });
  }
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
      const [settings, eligibility, ledger, setup, route] = await Promise.all([
        backend.request<{ records: Row[] }>("/v1/model-settings"),
        backend.request<{ items: Row[]; authorizations: Row[] }>(
          "/v1/eligibility",
        ),
        backend.request<{ records: Row[] }>("/v1/provider-usage?state=unknown"),
        owner
          ? backend.request<{ providers: ServerModel[] }>(
              "/v1/model-environment",
            )
          : Promise.resolve({ data: { providers: [] as ServerModel[] } }),
        owner
          ? backend.request<{ records: Row[] }>("/v1/model-routing")
          : Promise.resolve({ data: { records: [] } }),
      ]);
      const savedRoute = route.data.records?.[0];
      setRouting(savedRoute || { enabled: false, revision: 0 });
      setProviderOrder(savedRoute?.provider_order || DEFAULT_ORDER);
      setStrategy(savedRoute?.strategy || "priority");

      if (
        !Array.isArray(settings.data.records) ||
        !Array.isArray(eligibility.data.items) ||
        !Array.isArray(eligibility.data.authorizations) ||
        !Array.isArray(ledger.data.records) ||
        !Array.isArray(setup.data.providers)
      )
        throw new Error(
          "The model controls received an invalid response. Reload to retry.",
        );
      const next = emptyForms();
      for (const slot of setup.data.providers) {
        if (!isProviderId(slot.provider)) continue;
        next[slot.provider] = {
          ...next[slot.provider],
          model: slot.model,
          project_ref: slot.project_ref,
        };
      }
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
          quota_mode: m.quota_mode || "verified_budget",
          quota_ends_at: m.quota_ends_at?.slice(0, 16) || "",
          quota_remaining_tokens: m.quota_remaining_tokens ?? 0,
        };
      }
      setForms(next);
      setServerModels(setup.data.providers);
      setGeminiSavedEnabled(
        settings.data.records.some(
          (m) => m.provider === "gemini_free" && m.enabled,
        ),
      );
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
  }, [backend, owner]);
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
    const continuous = form.quota_mode === "provider_managed";
    if (
      !form.model ||
      !form.project_ref ||
      (!continuous && !form.quota_ends_at)
    ) {
      setError(
        `Complete model, project, and quota expiry for ${PROVIDERS.find((p) => p.id === id)?.label}.`,
      );
      return false;
    }
    const date = new Date(form.quota_ends_at + "Z");
    if (!continuous && !Number.isFinite(date.getTime())) {
      setError("Enter a valid UTC expiry.");
      return false;
    }
    return command("model.configure", {
      ...Object.fromEntries(
        Object.keys(initial).map((k) => [k, (form as Row)[k]]),
      ),
      provider: id,
      expected_revision: revisions[id],
      quota_ends_at: continuous ? null : date.toISOString(),
      quota_remaining_tokens: continuous ? null : form.quota_remaining_tokens,
    });
  }
  function providerTouched(id: ProviderId) {
    const form = forms[id];
    const slot = serverModels.find((entry) => entry.provider === id);
    return (
      form.enabled ||
      form.billing_verified ||
      form.model !== (slot?.model || "") ||
      form.project_ref !== (slot?.project_ref || "") ||
      Boolean(form.quota_ends_at) ||
      form.quota_remaining_tokens > 0
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
    const continuous = form.quota_mode === "provider_managed";
    const slot = serverModels.find((entry) => entry.provider === meta.id);
    return (
      <div key={meta.id} className="admin-muted-surface stack">
        <h3>{meta.label}</h3>
        <p className="admin-hint">
          Failover rank {form.failover_rank} · backend{" "}
          <code>{meta.secretHint}</code>
          {meta.optional &&
            (routing.enabled
              ? " · automatic routing can use server credentials while this individual switch is off"
              : " · add matching server credentials to use this provider")}
        </p>
        {slot && (
          <p className="admin-hint" role="status">
            {slot.key_configured
              ? "API key is configured on the server."
              : "API key is missing from the server configuration."}{" "}
            {slot.model && slot.project_ref
              ? revisions[meta.id] === 0
                ? "Model and project loaded from server configuration."
                : slot.model === form.model &&
                    slot.project_ref === form.project_ref
                  ? "Model and project match the server configuration."
                  : "Model or project differs from the server configuration; update them before enabling."
              : "Model or project is missing from the server configuration."}
          </p>
        )}
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
          {continuousProviders.includes(meta.id) && (
            <Field label="Quota management">
              <select
                disabled={!owner}
                value={form.quota_mode}
                onChange={(e) =>
                  patchForm(meta.id, {
                    quota_mode: e.target.value as typeof form.quota_mode,
                    enabled: false,
                  })
                }
              >
                <option value="provider_managed">Provider-managed quota</option>
                <option value="verified_budget">Verified quota budget</option>
              </select>
            </Field>
          )}
          {!continuous && (
            <Field label="Quota expiry (UTC)">
              <input
                type="datetime-local"
                disabled={!owner}
                value={form.quota_ends_at}
                onChange={(e) =>
                  patchForm(meta.id, { quota_ends_at: e.target.value })
                }
              />
            </Field>
          )}
          {(
            [
              "quota_remaining_tokens",
              "calls_per_day",
              "input_per_day",
              "output_per_day",
            ] as const
          )
            .filter((k) => !continuous || k !== "quota_remaining_tokens")
            .map((k) => (
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
        {continuous && (
          <p className="admin-hint">
            The provider reports its quota through API responses. Provider
            errors move to the next configured model. Daily application limits
            still apply and renew at midnight Riyadh time. No manual quota
            expiry is required.
          </p>
        )}
        <label>
          <input
            type="checkbox"
            disabled={
              !owner ||
              (!form.enabled &&
                (!slot?.key_configured ||
                  slot.model !== form.model ||
                  slot.project_ref !== form.project_ref))
            }
            checked={form.enabled}
            onChange={(e) => patchForm(meta.id, { enabled: e.target.checked })}
          />{" "}
          Enable matching backend credentials
        </label>
      </div>
    );
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <h2>Models and data permissions</h2>
      <p>
        Configure model names and credentials on the server. Automatic routing
        uses your selected order and moves to another provider after an error.
        Billing confirmation is not required. This form stores no API keys.
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
          <h3>Automatic model routing</h3>
          <p>
            Priority starts with the first configured provider in your order.
            Round robin rotates the starting position through the same order.
            Missing configuration is skipped. If no provider returns a valid
            result, the task waits and retries automatically.
          </p>
          <Field label="Provider selection">
            <select
              disabled={!owner || saving}
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as typeof strategy)}
            >
              <option value="priority">
                Priority: always start with the first provider
              </option>
              <option value="round_robin">
                Round robin: rotate the starting provider
              </option>
            </select>
          </Field>
          <ol aria-label="Provider order" className="stack">
            {providerOrder.map((id, index) => {
              const label = PROVIDERS.find((p) => p.id === id)!.label;
              return (
                <li key={id}>
                  <span>{label}</span>{" "}
                  <Button
                    disabled={!owner || saving || index === 0}
                    aria-label={`Move ${label} up`}
                    onClick={() => moveProvider(index, -1)}
                  >
                    Move up
                  </Button>{" "}
                  <Button
                    disabled={
                      !owner || saving || index === providerOrder.length - 1
                    }
                    aria-label={`Move ${label} down`}
                    onClick={() => moveProvider(index, 1)}
                  >
                    Move down
                  </Button>
                </li>
              );
            })}
          </ol>
          <Button
            disabled={!owner || saving}
            onClick={() =>
              command("model.routing", {
                enabled: routing.enabled,
                expected_revision: routing.revision,
                provider_order: providerOrder,
                strategy,
              })
            }
          >
            Save provider order
          </Button>
          <p role="status">
            {routing.enabled
              ? "Automatic model routing is enabled."
              : "Automatic model routing is disabled."}
          </p>
          <Button
            disabled={!owner || saving}
            onClick={() =>
              command("model.routing", {
                enabled: !routing.enabled,
                expected_revision: routing.revision,
              })
            }
          >
            {routing.enabled
              ? "Disable automatic routing"
              : "Enable automatic routing"}
          </Button>

          <h3>Primary providers</h3>
          {PROVIDERS.filter((p) => !p.optional).map(renderProviderPanel)}
          <h3>Additional providers</h3>
          <p>
            Models use the credentials and model names you configure. Billing
            confirmation is not required. Untouched rows are skipped when you
            save.
          </p>
          {PROVIDERS.filter((p) => p.optional).map(renderProviderPanel)}
          <Button disabled={!owner || saving} onClick={saveAll}>
            Save provider policies
          </Button>
          <Button
            disabled={
              !owner || saving || (!geminiSavedEnabled && !routing.enabled)
            }
            onClick={async () => {
              if (await command("model.probe", {})) setProbeQueued(true);
            }}
          >
            {routing.enabled
              ? "Check model routing"
              : "Check Gemini connection"}
          </Button>
          {routing.enabled && (
            <div className="admin-toolbar">
              {[
                "gemini_free",
                "qwen_free",
                "mistral_free",
                "groq_free",
                "zai_free",
              ].map((provider) => (
                <Button
                  key={provider}
                  variant="secondary"
                  disabled={!owner || saving}
                  onClick={async () => {
                    if (await command("model.probe", { provider }))
                      setProbeQueued(true);
                  }}
                >
                  Check {provider.replace("_free", "").replace("zai", "z.ai")}{" "}
                  only
                </Button>
              ))}
            </div>
          )}
          {probeQueued && (
            <p role="status">
              Connection check queued. Follow its result in{" "}
              <a href="#/jobs">Activity &amp; jobs</a>.
            </p>
          )}
          <h3>Content permitted for model processing</h3>
          <p>
            Discovery scope can permit enabled, verified Company Knowledge files
            and notes for the selected providers, including future updates.
            Other content can be authorized individually below. Explicit
            revocations take priority over the workspace policy.
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
