import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../lib/store";
import { Badge, Button, Field } from "./ui";
import { MODEL_PROVIDERS, providerLabel } from "../lib/modelProviders";

type Row = Record<string, any>;
const taskNames: Record<string, string> = {
  default: "Default fallback",
  connection_probe: "Connection check",
  inspect_source_page: "Read source pages",
  classify_opportunity: "Assess opportunities",
  summarize_review: "Interpret feedback",
  analyze_chunk: "Analyze RFP requirements",
  plan_proposal: "Plan proposal",
  draft_section: "Write proposal sections",
  plan_commercial: "Plan commercial inputs",
  review_proposal: "Review proposal",
  verify_grounding: "Verify claims and evidence",
  repair_result: "Correct a result",
};
const capabilities = (provider: string): Row => ({
  revision: 1,
  output:
    provider === "openai"
      ? "native_strict"
      : provider === "gemini_free"
        ? "schema"
        : "validated_json",
  background: ["openai", "gemini_free"].includes(provider),
  streaming: !["openai", "gemini_free"].includes(provider),
  reasoning: provider === "qwencloud" ? "qwen_toggle" : "none",
  reasoning_values: provider === "qwencloud" ? ["none"] : [],
  max_output_tokens: null,
});
export default function ModelCatalogControls({
  legacy,
}: {
  legacy: ReactNode;
}) {
  const { backend, runCommand, state, notify, saving } = useApp();
  const owner = state.settings.role === "Owner";
  const [data, setData] = useState<{
    connections: Row[];
    models: Row[];
    routes: Row[];
    settings: Row;
    status: Row;
  }>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [parallelRequests, setParallelRequests] = useState("1");
  const [connection, setConnection] = useState<Row | null>(null),
    [model, setModel] = useState<Row | null>(null);
  const [task, setTask] = useState("default"),
    [route, setRoute] = useState<Row>({
      model_ids: [],
      inherit_default: false,
      strategy: "priority",
      profile: null,
      revision: 0,
    });
  const disabled = !owner || busy || saving;
  async function load() {
    if (!backend) return;
    const paths = [
      "model-connections",
      "model-configurations",
      "model-task-routes",
      "model-execution-settings",
    ];
    const [rows, status] = await Promise.all([
      Promise.all(
        paths.map((path) =>
          backend.request<{ records: Row[] }>(`/v1/${path}?limit=100`),
        ),
      ),
      owner
        ? backend.request<Row>("/v1/model-catalog-status")
        : Promise.resolve({ data: { connections: [], tasks: [] } }),
    ]);
    if (rows.some((r) => !Array.isArray(r.data.records)))
      throw new Error("Unable to read model configuration.");
    const next = {
      connections: rows[0].data.records,
      models: rows[1].data.records,
      routes: rows[2].data.records,
      settings: rows[3].data.records[0] || { enabled: false, revision: 0 },
      status: status.data,
    };
    setData(next);
    setParallelRequests(String(next.settings.max_parallel_requests ?? 1));
    setRoute(
      next.routes.find((r) => r.task === task) ?? {
        model_ids: [],
        inherit_default: task !== "default",
        strategy: "priority",
        profile: null,
        revision: 0,
      },
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [backend, owner]);
  function selectTask(value: string) {
    setTask(value);
    setRoute(
      data?.routes.find((r) => r.task === value) ?? {
        model_ids: [],
        inherit_default: value !== "default",
        strategy: "priority",
        profile: null,
        revision: 0,
      },
    );
  }
  async function save(operation: string, input: Row) {
    if (disabled || !runCommand) return;
    setBusy(true);
    setError("");
    try {
      await runCommand(operation, input);
      await load();
      setConnection(null);
      setModel(null);
      notify(
        "Model settings saved. Current requests retain their saved configuration.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save settings.");
    } finally {
      setBusy(false);
    }
  }
  const connectionFor = (id: string) =>
    data?.connections.find((c) => c.id === id);
  const modelLabel = (id: string) => {
    const m = data?.models.find((m) => m.id === id),
      c = connectionFor(m?.connection_id);
    return m
      ? `${providerLabel(c?.provider)} · ${m.label} (${m.model})`
      : "Unavailable model";
  };
  const readyLabel = (id: string) => {
    const m = data?.models.find((m) => m.id === id),
      c = connectionFor(m?.connection_id);
    if (!m?.enabled || !c?.enabled) return "Disabled";
    return data?.status.connections?.find((s: Row) => s.id === c.id)
      ?.key_configured
      ? "Configured"
      : owner
        ? "Key missing"
        : "Connection status available to Owner";
  };
  function move(index: number, direction: number) {
    const ids = [...route.model_ids];
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    setRoute({ ...route, model_ids: ids });
  }
  if (!data)
    return (
      <div role={error ? "alert" : "status"}>
        {error || "Loading models and task routing…"}
        {error && (
          <Button onClick={() => void load().catch((e) => setError(e.message))}>
            Retry
          </Button>
        )}
      </div>
    );
  const defaults = data.status.tasks?.find((t: Row) => t.task === task)
    ?.profile ?? {
    revision: 1,
    max_output_tokens: 40000,
    reasoning: "low",
    require_native_strict: false,
  };
  const effectiveIds = [
    ...new Set<string>([
      ...route.model_ids,
      ...(task !== "default" && route.inherit_default
        ? (data.routes.find((r) => r.task === "default")?.model_ids ?? [])
        : []),
    ]),
  ];
  return (
    <div className="model-catalog">
      <h2>Models &amp; providers</h2>
      <p>
        Keys stay in the server runtime secret store. Connections identify the
        account and key; models and each task’s fallback order are saved here.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <section className="panel">
        <h3>Connections</h3>
        <p>
          Several models can share one connection. Use a separate connection for
          a different account or key.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Connection</th>
                <th>Credentials</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => (
                <tr key={c.id}>
                  <td>
                    {providerLabel(c.provider)} · {c.label}
                    <small className="muted" style={{ display: "block" }}>
                      {c.project_ref}
                    </small>
                  </td>
                  <td>
                    <code>{c.credential_alias}</code>
                  </td>
                  <td>
                    <Badge tone={c.enabled ? "green" : "neutral"}>
                      {c.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    {owner && (
                      <small style={{ display: "block" }}>
                        {data.status.connections?.find(
                          (s: Row) => s.id === c.id,
                        )?.key_configured
                          ? "Key present"
                          : "Key missing from server configuration"}
                      </small>
                    )}
                  </td>
                  <td>
                    <Button
                      disabled={disabled}
                      onClick={() => setConnection(c)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          disabled={disabled}
          onClick={() =>
            setConnection({
              provider: "openai",
              label: "OpenAI",
              credential_alias: "APP_MODEL_OPENAI_KEY",
              project_ref: "default",
              enabled: true,
              revision: 0,
            })
          }
        >
          Add connection
        </Button>
        {connection && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save("model.connection.save", {
                ...(connection.id ? { id: connection.id } : {}),
                expected_revision: connection.revision,
                provider: connection.provider,
                label: connection.label,
                credential_alias: connection.credential_alias,
                project_ref: connection.project_ref,
                enabled: connection.enabled,
              });
            }}
          >
            <Field label="Provider">
              <select
                value={connection.provider}
                disabled={disabled || Boolean(connection.id)}
                onChange={(e) => {
                  const p = MODEL_PROVIDERS.find(
                    (p) => p.id === e.target.value,
                  )!;
                  setConnection({
                    ...connection,
                    provider: p.id,
                    label: p.label,
                    credential_alias: `${p.prefix}_KEY`,
                    project_ref:
                      p.id === "qwencloud" &&
                      connection.project_ref === "default"
                        ? "ap-southeast-1"
                        : connection.project_ref,
                  });
                }}
              >
                {MODEL_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Connection label">
              <input
                required
                maxLength={120}
                value={connection.label}
                onChange={(e) =>
                  setConnection({ ...connection, label: e.target.value })
                }
              />
            </Field>
            <Field
              label="Secret name"
              hint="Enter the name of the key in the server runtime secret store, never the key itself."
            >
              <input
                required
                disabled={Boolean(connection.id)}
                pattern="APP_MODEL_[A-Z0-9_]+_KEY"
                value={connection.credential_alias}
                onChange={(e) =>
                  setConnection({
                    ...connection,
                    credential_alias: e.target.value,
                  })
                }
              />
            </Field>
            <Field
              label={
                MODEL_PROVIDERS.find((p) => p.id === connection.provider)
                  ?.accountLabel || "Account identifier"
              }
            >
              <input
                required
                maxLength={120}
                disabled={Boolean(connection.id)}
                value={connection.project_ref}
                onChange={(e) =>
                  setConnection({ ...connection, project_ref: e.target.value })
                }
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={connection.enabled}
                onChange={(e) =>
                  setConnection({ ...connection, enabled: e.target.checked })
                }
              />{" "}
              Enabled
            </label>
            <div className="page-actions">
              <Button type="submit" disabled={disabled}>
                Save connection
              </Button>
              <Button onClick={() => setConnection(null)}>Cancel</Button>
            </div>
          </form>
        )}
      </section>
      <section className="panel">
        <h3>Models</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Connection</th>
                <th>Output</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.label}
                    <small style={{ display: "block" }}>{m.model}</small>
                  </td>
                  <td>{connectionFor(m.connection_id)?.label}</td>
                  <td>
                    {m.capabilities.output === "native_strict"
                      ? "Native strict schema"
                      : m.capabilities.output === "schema"
                        ? "Schema guided"
                        : "Validated JSON"}
                  </td>
                  <td>{readyLabel(m.id)}</td>
                  <td>
                    <Button
                      disabled={disabled}
                      onClick={() => setModel(structuredClone(m))}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          disabled={disabled || !data.connections.length}
          onClick={() =>
            setModel({
              connection_id: data.connections[0].id,
              label: "",
              model: "",
              enabled: true,
              revision: 0,
              capabilities: capabilities(data.connections[0].provider),
            })
          }
        >
          Add model
        </Button>
        {model && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save("model.configuration.save", {
                ...(model.id ? { id: model.id } : {}),
                expected_revision: model.revision,
                connection_id: model.connection_id,
                label: model.label,
                model: model.model,
                enabled: model.enabled,
                capabilities: model.capabilities,
              });
            }}
          >
            <Field label="Connection">
              <select
                value={model.connection_id}
                onChange={(e) =>
                  setModel({
                    ...model,
                    connection_id: e.target.value,
                    capabilities: capabilities(
                      connectionFor(e.target.value)!.provider,
                    ),
                  })
                }
              >
                {data.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {providerLabel(c.provider)} · {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Model name"
              hint="Use the exact model identifier supplied by your provider."
            >
              <input
                required
                maxLength={120}
                value={model.model}
                onChange={(e) =>
                  setModel({
                    ...model,
                    model: e.target.value,
                    label:
                      !model.label || model.label === model.model
                        ? e.target.value
                        : model.label,
                  })
                }
              />
            </Field>
            <Field label="Display label">
              <input
                required
                maxLength={120}
                value={model.label}
                onChange={(e) => setModel({ ...model, label: e.target.value })}
              />
            </Field>
            <label>
              <input
                type="checkbox"
                checked={model.enabled}
                onChange={(e) =>
                  setModel({ ...model, enabled: e.target.checked })
                }
              />{" "}
              Enabled
            </label>
            <p className="muted">
              Requests run in the background of the app. TenderDesk manages how
              each provider processes them and resumes accepted requests
              automatically.
            </p>
            <details>
              <summary>Advanced model settings</summary>
              <p>
                Use capabilities supported by this model. Every response also
                receives local schema and evidence checks.
              </p>
              <Field label="Structured output">
                <select
                  value={model.capabilities.output}
                  onChange={(e) =>
                    setModel({
                      ...model,
                      capabilities: {
                        ...model.capabilities,
                        output: e.target.value,
                      },
                    })
                  }
                >
                  <option value="validated_json">Validated JSON</option>
                  <option value="schema">Schema guided</option>
                  <option value="native_strict">
                    Native strict JSON Schema
                  </option>
                </select>
              </Field>
              {["openai", "gemini_free"].includes(
                connectionFor(model.connection_id)?.provider,
              ) && (
                <Field
                  label="Request handling"
                  hint="Automatic uses provider background processing when available and switches to standard requests after an explicit unsupported-feature rejection. Existing accepted requests are always resumed."
                >
                  <select
                    value={
                      model.capabilities.background ? "automatic" : "standard"
                    }
                    onChange={(e) =>
                      setModel({
                        ...model,
                        capabilities: {
                          ...model.capabilities,
                          background: e.target.value === "automatic",
                        },
                      })
                    }
                  >
                    <option value="automatic">Automatic (recommended)</option>
                    <option value="standard">Standard requests only</option>
                  </select>
                </Field>
              )}
              <Field label="Reasoning control">
                <select
                  value={model.capabilities.reasoning}
                  onChange={(e) =>
                    setModel({
                      ...model,
                      capabilities: {
                        ...model.capabilities,
                        reasoning: e.target.value,
                        reasoning_values:
                          e.target.value === "none"
                            ? []
                            : e.target.value === "qwen_toggle"
                              ? ["none", "low"]
                              : ["low", "medium", "high"],
                      },
                    })
                  }
                >
                  <option value="none">Provider default</option>
                  {connectionFor(model.connection_id)?.provider ===
                  "gemini_free" ? (
                    <option value="gemini_level">Gemini thinking level</option>
                  ) : ["qwen_free", "qwencloud"].includes(
                      connectionFor(model.connection_id)?.provider,
                    ) ? (
                    <option value="qwen_toggle">Qwen thinking switch</option>
                  ) : (
                    !["anthropic", "cloudflare_free"].includes(
                      connectionFor(model.connection_id)?.provider,
                    ) && <option value="effort">Reasoning effort</option>
                  )}
                </select>
              </Field>
              <Field label="Maximum output supported by this model (optional)">
                <input
                  type="number"
                  min={1024}
                  max={131072}
                  value={model.capabilities.max_output_tokens ?? ""}
                  onChange={(e) =>
                    setModel({
                      ...model,
                      capabilities: {
                        ...model.capabilities,
                        max_output_tokens: e.target.value
                          ? Number(e.target.value)
                          : null,
                      },
                    })
                  }
                />
              </Field>
            </details>
            <div className="page-actions">
              <Button type="submit" disabled={disabled}>
                Save model
              </Button>
              <Button onClick={() => setModel(null)}>Cancel</Button>
            </div>
          </form>
        )}
      </section>
      <section className="panel">
        <h3>Task routing</h3>
        <p>
          Try models in the saved order, including multiple models from the same
          provider. If all are unavailable, processing waits and retries
          automatically.
        </p>
        <Field label="Task">
          <select value={task} onChange={(e) => selectTask(e.target.value)}>
            {Object.entries(taskNames)
              .filter(
                ([key]) =>
                  key === "default" ||
                  data.status.tasks?.some((t: Row) => t.task === key) ||
                  !owner,
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </Field>
        <ol>
          {route.model_ids.map((id: string, index: number) => (
            <li key={id} style={{ marginBlock: 12 }}>
              {modelLabel(id)} <small>· {readyLabel(id)}</small>
              <div className="page-actions">
                <Button
                  size="sm"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${modelLabel(id)} up`}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  disabled={disabled || index === route.model_ids.length - 1}
                  aria-label={`Move ${modelLabel(id)} down`}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setRoute({
                      ...route,
                      model_ids: route.model_ids.filter(
                        (x: string) => x !== id,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Field label="Add a model to this task">
          <select
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value)
                setRoute({
                  ...route,
                  model_ids: [...route.model_ids, e.target.value],
                });
            }}
          >
            <option value="">Choose a model</option>
            {data.models
              .filter((m) => !route.model_ids.includes(m.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {modelLabel(m.id)}
                </option>
              ))}
          </select>
        </Field>
        {task !== "default" && (
          <label>
            <input
              type="checkbox"
              checked={route.inherit_default}
              disabled={disabled}
              onChange={(e) =>
                setRoute({ ...route, inherit_default: e.target.checked })
              }
            />{" "}
            Append the default fallback models
          </label>
        )}
        <Field label="Selection strategy">
          <select
            value={route.strategy}
            disabled={disabled}
            onChange={(e) => setRoute({ ...route, strategy: e.target.value })}
          >
            <option value="priority">Start with the first model</option>
            <option value="round_robin">
              Rotate the starting model for new operations
            </option>
          </select>
        </Field>
        <p>
          <strong>Effective order:</strong>{" "}
          {effectiveIds.length
            ? effectiveIds.map(modelLabel).join(" → ")
            : "No models selected"}
        </p>
        <details>
          <summary>Output and reasoning for this task</summary>
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={Boolean(route.profile)}
              onChange={(e) =>
                setRoute({
                  ...route,
                  profile: e.target.checked ? { ...defaults } : null,
                })
              }
            />{" "}
            Customize task profile
          </label>
          <p>
            Output limits apply per request. Reported token usage is recorded;
            there is no daily application token quota.
          </p>
          {route.profile && (
            <>
              <Field label="Maximum output tokens">
                <input
                  type="number"
                  min={1024}
                  max={131072}
                  value={route.profile.max_output_tokens}
                  onChange={(e) =>
                    setRoute({
                      ...route,
                      profile: {
                        ...route.profile,
                        max_output_tokens: Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="Preferred reasoning">
                <select
                  value={route.profile.reasoning}
                  onChange={(e) =>
                    setRoute({
                      ...route,
                      profile: { ...route.profile, reasoning: e.target.value },
                    })
                  }
                >
                  {["none", "minimal", "low", "medium", "high"].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <label>
                <input
                  type="checkbox"
                  checked={route.profile.require_native_strict}
                  onChange={(e) =>
                    setRoute({
                      ...route,
                      profile: {
                        ...route.profile,
                        require_native_strict: e.target.checked,
                      },
                    })
                  }
                />{" "}
                Require native strict schema support
              </label>
            </>
          )}
        </details>
        <Button
          disabled={disabled || (task === "default" && !route.model_ids.length)}
          onClick={() =>
            void save("model.task_route.save", {
              task,
              expected_revision: route.revision,
              model_ids: route.model_ids,
              inherit_default: task !== "default" && route.inherit_default,
              strategy: route.strategy,
              profile: route.profile,
            })
          }
        >
          Save task routing
        </Button>
      </section>
      <section className="panel">
        <h3>Use task routing for new work</h3>
        <Badge tone={data.settings.enabled ? "green" : "amber"}>
          {data.settings.enabled
            ? "Task routing enabled"
            : "Existing provider routing active"}
        </Badge>
        <p>
          Current operations retain their saved configuration. Changing this
          setting controls which configuration new work starts with.
        </p>
        <Button
          disabled={
            disabled ||
            !data.routes.some((r) => r.task === "default" && r.model_ids.length)
          }
          onClick={() =>
            void save("model.execution.configure", {
              expected_revision: data.settings.revision,
              enabled: !data.settings.enabled,
            })
          }
        >
          {data.settings.enabled
            ? "Use existing provider routing for new work"
            : "Enable task routing for new work"}
        </Button>
      </section>
      <section className="panel">
        <h3>Processing concurrency</h3>
        <p>
          Allow independent tasks to wait for model results at the same time.
          Existing requests finish when this limit is reduced. A higher limit
          can spend the same work's budget faster and may reach provider rate
          limits.
        </p>
        <Field label="Simultaneous model requests">
          <select
            value={parallelRequests}
            disabled={disabled || !data.settings.enabled}
            onChange={(event) => setParallelRequests(event.target.value)}
          >
            {[1, 2, 3, 4].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={
            disabled ||
            !data.settings.enabled ||
            Number(parallelRequests) ===
              (data.settings.max_parallel_requests ?? 1)
          }
          onClick={() =>
            void save("model.execution.configure", {
              expected_revision: data.settings.revision,
              enabled: data.settings.enabled,
              max_parallel_requests: Number(parallelRequests),
            })
          }
        >
          Save processing concurrency
        </Button>
      </section>
      <details>
        <summary>Existing provider routing and connection checks</summary>
        {legacy}
      </details>
    </div>
  );
}
