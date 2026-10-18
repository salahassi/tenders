import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Badge, Button, Field } from "./ui";
import {
  DEFAULT_PROVIDER_ORDER,
  MODEL_PROVIDERS,
  providerLabel,
  type ProviderId,
  type ServerModel,
} from "../lib/modelProviders";
type Row = Record<string, any>;
const defaults = {
  enabled: false,
  model: "",
  project_ref: "",
  free_only: false,
  billing_verified: false,
  free_quota_only: false,
  quota_mode: "provider_managed",
  quota_ends_at: "",
  quota_remaining_tokens: 0,
  calls_per_day: 50,
  input_per_day: 250000,
  output_per_day: 50000,
  revision: 0,
};
const newForms = () =>
  Object.fromEntries(
    MODEL_PROVIDERS.map((p) => [p.id, { ...defaults, failover_rank: p.rank }]),
  ) as unknown as Record<ProviderId, Row>;
export default function ModelControls() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const owner = state.settings.role === "Owner";
  const [forms, setForms] = useState(newForms);
  const [serverModels, setServerModels] = useState<ServerModel[]>([]);
  const [routing, setRouting] = useState<Row>({ enabled: false, revision: 0 });
  const [providerOrder, setProviderOrder] = useState<ProviderId[]>(
    DEFAULT_PROVIDER_ORDER,
  );
  const [strategy, setStrategy] = useState("priority");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probeQueued, setProbeQueued] = useState(false);
  const disabled = !owner || saving || busy;
  async function load() {
    if (!backend) return;
    const [policies, setup, route] = await Promise.all([
      backend.request<{ records: Row[] }>("/v1/model-settings"),
      owner
        ? backend.request<{ providers: ServerModel[] }>("/v1/model-environment")
        : Promise.resolve({ data: { providers: [] as ServerModel[] } }),
      owner
        ? backend.request<{ records: Row[] }>("/v1/model-routing")
        : Promise.resolve({ data: { records: [] as Row[] } }),
    ]);
    if (
      !Array.isArray(policies.data.records) ||
      !Array.isArray(setup.data.providers) ||
      !Array.isArray(route.data.records)
    )
      throw new Error("Unable to read provider settings. Refresh to retry.");
    const next = newForms();
    for (const m of policies.data.records) {
      if (!(m.provider in next)) continue;
      next[m.provider as ProviderId] = {
        ...next[m.provider as ProviderId],
        ...m,
        quota_mode: m.quota_mode || "verified_budget",
        quota_ends_at: m.quota_ends_at?.slice(0, 16) || "",
      };
    }
    setForms(next);
    setServerModels(setup.data.providers);
    const saved = route.data.records[0] || { enabled: false, revision: 0 };
    setRouting(saved);
    setProviderOrder(saved.provider_order || DEFAULT_PROVIDER_ORDER);
    setStrategy(saved.strategy || "priority");
    setReady(true);
  }
  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : "Unable to load providers."),
    );
  }, [backend, owner]);
  async function command(
    operation: string,
    input: Row,
    message: string,
    reload = true,
  ) {
    if (!owner || !runCommand || busy || saving) return false;
    setBusy(true);
    setError("");
    try {
      const result = await runCommand(operation, input);
      if (reload && operation === "model.routing") {
        const saved: Row = {
          ...routing,
          ...input,
          ...(result || {}),
          revision: Number(result?.revision || routing.revision + 1),
        };
        setRouting(saved);
        setProviderOrder(saved.provider_order || DEFAULT_PROVIDER_ORDER);
        setStrategy(saved.strategy || "priority");
      } else if (reload) await load();
      notify(message);
      return result || true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function patch(id: ProviderId, values: Row) {
    setForms((prev) => ({ ...prev, [id]: { ...prev[id], ...values } }));
  }
  function move(index: number, offset: number) {
    setProviderOrder((prev) => {
      const next = [...prev];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }
  async function savePolicy(id: ProviderId) {
    const form = forms[id],
      server = serverModels.find((p) => p.provider === id);
    const automatic = routing.enabled;
    const model = server?.model || form.model,
      project = server?.project_ref || form.project_ref;
    if (!model || !project) {
      setError(
        `Configure ${providerLabel(id)} in Supabase Secrets before saving its policy.`,
      );
      return;
    }
    const continuous = automatic || form.quota_mode === "provider_managed";
    const date = new Date(form.quota_ends_at + "Z");
    if (!continuous && !Number.isFinite(date.getTime())) {
      setError("Enter a valid UTC expiry.");
      return;
    }
    const numeric = [
      form.calls_per_day,
      form.input_per_day,
      form.output_per_day,
    ];
    if (
      !numeric.every(Number.isInteger) ||
      form.calls_per_day < 1 ||
      form.calls_per_day > 50 ||
      form.input_per_day < 1000 ||
      form.input_per_day > 250000 ||
      form.output_per_day < 1000 ||
      form.output_per_day > 50000
    ) {
      setError("Use whole numbers within the displayed application limits.");
      return;
    }
    const result = await command(
      "model.configure",
      {
        provider: id,
        expected_revision: form.revision,
        enabled: form.enabled,
        model,
        project_ref: project,
        free_only: form.free_only,
        billing_verified: form.billing_verified,
        free_quota_only: form.free_quota_only,
        quota_mode: continuous ? "provider_managed" : "verified_budget",
        quota_ends_at: continuous ? null : date.toISOString(),
        quota_remaining_tokens: continuous
          ? null
          : Number(form.quota_remaining_tokens),
        calls_per_day: form.calls_per_day,
        input_per_day: form.input_per_day,
        output_per_day: form.output_per_day,
        failover_rank: form.failover_rank,
      },
      `${providerLabel(id)} policy saved.`,
      false,
    );
    // Update just this row. Saving one provider must preserve drafts for other providers and routing.
    if (result)
      patch(id, {
        model,
        project_ref: project,
        revision:
          typeof result === "object" && result.revision
            ? result.revision
            : form.revision + 1,
      });
  }
  async function probe(provider?: ProviderId) {
    if (
      await command(
        "model.probe",
        provider ? { provider } : {},
        "Connection check queued.",
        false,
      )
    )
      setProbeQueued(true);
  }
  function card(id: ProviderId, index?: number) {
    const meta = MODEL_PROVIDERS.find((p) => p.id === id)!,
      form = forms[id],
      slot = serverModels.find((p) => p.provider === id);
    const configured = Boolean(
      slot?.key_configured && slot.model && slot.project_ref,
    );
    const changedAccount = Boolean(
      form.revision &&
      slot?.project_ref &&
      form.project_ref !== slot.project_ref,
    );
    const automatic = routing.enabled;
    const legacy = !automatic;
    return (
      <article className="provider-card" aria-label={`${meta.label} provider`}>
        <div className="admin-spread">
          <div>
            <h3>
              {index === undefined ? "" : `${index + 1}. `}
              {meta.label}
            </h3>
            <Badge tone={configured && !changedAccount ? "green" : "neutral"}>
              {!owner
                ? "Owner manages connection"
                : changedAccount
                  ? "Account change needs review"
                  : configured
                    ? "Configured"
                    : "Not configured"}
            </Badge>
          </div>
          {index !== undefined && (
            <div className="admin-cell-actions">
              <Button
                size="sm"
                disabled={disabled || index === 0}
                aria-label={`Move ${meta.label} up`}
                onClick={() => move(index, -1)}
              >
                Move up
              </Button>
              <Button
                size="sm"
                disabled={disabled || index === providerOrder.length - 1}
                aria-label={`Move ${meta.label} down`}
                onClick={() => move(index, 1)}
              >
                Move down
              </Button>
            </div>
          )}
        </div>
        <dl className="provider-identity">
          <dt>Model from Secrets</dt>
          <dd dir="auto">
            {owner ? slot?.model || "Not set" : form.model || "Owner only"}
          </dd>
          <dt>API key</dt>
          <dd>
            {!owner
              ? "Owner only"
              : slot?.key_configured
                ? "Configured on server"
                : "Missing from server"}
          </dd>
        </dl>
        {owner && !configured && (
          <p className="admin-hint">
            Skipped until the API key, model and required account identifier are
            configured on the server.
          </p>
        )}
        {changedAccount && (
          <p role="status">
            The account identifier changed in Secrets. Review and save this
            provider’s policy below to accept the new identity.
          </p>
        )}
        {automatic && (
          <Button
            size="sm"
            disabled={disabled || !configured || changedAccount}
            onClick={() => void probe(id)}
          >
            Check {meta.label} only
          </Button>
        )}
        <details className="settings-details">
          <summary>
            Connection setup{owner ? " and advanced policy" : ""}
          </summary>
          <p>
            Set <code>{meta.prefix}_KEY</code> and{" "}
            <code>{meta.prefix}_NAME</code> in Supabase Edge Function Secrets.
            The model name is used exactly as entered there. Refresh this page
            after changing Secrets.
          </p>
          <p>
            <code>{meta.prefix}_PROJECT</code>: {meta.accountLabel}.{" "}
            {id === "openai" || id === "anthropic"
              ? "Optional; used for account tracking."
              : id === "cloudflare_free"
                ? "Required for the API endpoint."
                : "Required for account tracking."}
          </p>
          {owner && (
            <>
              <p>
                Server account identifier:{" "}
                <strong dir="auto">{slot?.project_ref || "Not set"}</strong>
              </p>
              <h4>
                {automatic
                  ? "Advanced application limits"
                  : "Manual provider policy"}
              </h4>
              <p>
                These are application ceilings, not the provider’s remaining
                quota. The lower of the workspace and this policy’s limit
                applies to the combined daily usage across all providers. Reset:
                midnight in Riyadh.
              </p>
              <p>
                <a href="#/settings?section=workspace">
                  Manage workspace-wide limits
                </a>
              </p>
              <div className="admin-form-grid">
                {(
                  [
                    {
                      key: "calls_per_day",
                      label: "Daily call ceiling",
                      min: 1,
                      max: 50,
                    },
                    {
                      key: "input_per_day",
                      label: "Daily input-token ceiling",
                      min: 1000,
                      max: 250000,
                    },
                    {
                      key: "output_per_day",
                      label: "Daily output-token ceiling",
                      min: 1000,
                      max: 50000,
                    },
                  ] as const
                ).map((field) => (
                  <Field key={field.key} label={`${meta.label} ${field.label}`}>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      disabled={disabled}
                      value={form[field.key]}
                      onChange={(e) =>
                        patch(id, { [field.key]: Number(e.target.value) })
                      }
                    />
                  </Field>
                ))}
              </div>
              {legacy && (
                <>
                  <p>
                    Manual mode starts with an enabled Gemini policy; other
                    enabled policies are legacy fallbacks. Automatic routing
                    uses its saved order and server credentials instead.
                  </p>
                  <Field label={`${meta.label} quota management`}>
                    <select
                      disabled={disabled}
                      value={form.quota_mode}
                      onChange={(e) =>
                        patch(id, { quota_mode: e.target.value })
                      }
                    >
                      <option value="provider_managed">
                        Provider-managed quota
                      </option>
                      <option value="verified_budget">
                        Verified quota budget
                      </option>
                    </select>
                  </Field>
                  {form.quota_mode !== "provider_managed" && (
                    <div className="admin-form-grid">
                      <Field label={`${meta.label} quota expiry (UTC)`}>
                        <input
                          type="datetime-local"
                          disabled={disabled}
                          value={form.quota_ends_at}
                          onChange={(e) =>
                            patch(id, { quota_ends_at: e.target.value })
                          }
                        />
                      </Field>
                      <Field label={`${meta.label} verified remaining tokens`}>
                        <input
                          type="number"
                          min={1}
                          disabled={disabled}
                          value={form.quota_remaining_tokens}
                          onChange={(e) =>
                            patch(id, {
                              quota_remaining_tokens: e.target.value,
                            })
                          }
                        />
                      </Field>
                    </div>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      disabled={disabled || (!form.enabled && !configured)}
                      checked={Boolean(form.enabled)}
                      onChange={(e) => patch(id, { enabled: e.target.checked })}
                    />{" "}
                    Enable {meta.label} for manual routing
                  </label>
                </>
              )}
              <Button
                disabled={disabled || (!slot?.model && !form.model)}
                onClick={() => void savePolicy(id)}
              >
                Save {meta.label} policy
              </Button>
            </>
          )}
        </details>
      </article>
    );
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <div className="admin-spread">
        <h2>Models &amp; providers</h2>
        <Button
          disabled={busy || saving}
          onClick={() => {
            setError("");
            void load().catch((e) => setError(e.message));
          }}
        >
          Refresh server setup
        </Button>
      </div>
      <p>
        <strong>Supabase Secrets</strong> hold the API key, exact model name and
        account identifier. <strong>Settings</strong> control provider order,
        selection strategy, application limits and data permissions. Saving here
        never changes Secrets.
      </p>
      <p>
        Configured means the required values are present. A connection check
        confirms whether the provider accepts them; its result and token usage
        appear in <a href="#/jobs">Activity &amp; jobs</a>.
      </p>
      <p>
        <a href="#/settings?section=data">
          Manage which company and tender data providers may process
        </a>
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
          {owner && (
            <>
              <div className="admin-spread">
                <h3>Automatic routing</h3>
                <Badge tone={routing.enabled ? "green" : "neutral"}>
                  {routing.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <p>
                Priority starts with the first configured provider. Round robin
                rotates the starting position. Errors move to the next provider;
                unsuccessful rounds wait and retry with recorded attempts.
              </p>
              <div className="admin-toolbar">
                <Field label="Provider selection">
                  <select
                    disabled={disabled}
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value)}
                  >
                    <option value="priority">
                      Priority: first available provider
                    </option>
                    <option value="round_robin">
                      Round robin: rotate the starting provider
                    </option>
                  </select>
                </Field>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void command(
                      "model.routing",
                      {
                        enabled: !routing.enabled,
                        expected_revision: routing.revision,
                        provider_order: providerOrder,
                        strategy,
                      },
                      "Routing settings saved.",
                    )
                  }
                >
                  {routing.enabled
                    ? "Disable automatic routing"
                    : "Enable automatic routing"}
                </Button>
              </div>
              {!routing.enabled && (
                <p className="admin-hint">
                  Automatic selection is off. Saved manual policies can still
                  process work when Gemini is enabled. Their controls are under
                  each provider’s advanced policy.
                </p>
              )}
            </>
          )}
          <ol className="provider-list" aria-label="Provider order">
            {providerOrder.map((id, index) => (
              <li key={id}>{card(id, owner ? index : undefined)}</li>
            ))}
          </ol>
          {owner && (
            <p className="admin-hint">
              Order and strategy changes take effect when you save. Refresh
              server setup reloads the saved settings.
            </p>
          )}
          <div className="admin-toolbar">
            <Button
              variant="primary"
              disabled={disabled}
              onClick={() =>
                void command(
                  "model.routing",
                  {
                    enabled: routing.enabled,
                    expected_revision: routing.revision,
                    provider_order: providerOrder,
                    strategy,
                  },
                  "Provider order saved.",
                )
              }
            >
              Save provider order
            </Button>
            <Button
              disabled={
                disabled || (!routing.enabled && !forms.gemini_free.enabled)
              }
              onClick={() => void probe()}
            >
              {routing.enabled
                ? "Check model routing"
                : "Check Gemini connection"}
            </Button>
          </div>
          {probeQueued && (
            <p role="status">
              Connection check queued. Follow its result in{" "}
              <a href="#/jobs">Activity &amp; jobs</a>.
            </p>
          )}
        </>
      )}
    </section>
  );
}
