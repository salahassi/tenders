import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../lib/store";
import { Button, Badge } from "./ui";
export type ModelAttempt = {
  id: string;
  provider: string;
  model: string;
  project_ref: string;
  operation: string;
  status: string;
  result_code: string | null;
  sent: boolean;
  job_id: string;
  plan_id: string | null;
  opportunity_id: string | null;
  opportunity_title: string | null;
  proposal_id: string | null;
  round_number: number;
  worker_attempt: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  actual_input: number | null;
  actual_output: number | null;
  thinking_tokens: number | null;
  reserved_input: number | null;
  reserved_output: number | null;
  usage_state: string | null;
  usage_id: string | null;
  http_status: number | null;
  request_id: string | null;
  provider_error_code?: string | null;
  provider_error_type?: string | null;
  provider_error_reason?: string | null;
  response_id: string | null;
  remote_request_id: string | null;
  reported_model: string | null;
  finish_reason: string | null;
  request_phase: string | null;
  retry_after: string | null;
  next_attempt_at: string | null;
  job_status: string;
};
const when = (v: string | null) =>
  v && Number.isFinite(Date.parse(v))
    ? new Date(v).toLocaleString(undefined, { timeZone: "Asia/Riyadh" }) +
      " Riyadh"
    : "Not recorded";
const count = (v: number | null) =>
  v == null ? "Not reported" : v.toLocaleString();
const rejectionReasons: Record<string, string> = {
  overloaded: "Provider servers temporarily overloaded",
  rate_limit: "Provider request rate limit",
  concurrency_limit: "Provider concurrent request limit",
  usage_limit: "Provider usage limit",
  insufficient_balance:
    "Provider reported insufficient balance or resource package",
  subscription_expired: "Provider reported an expired subscription",
  model_access: "Provider reported no access to this model",
  account_rate_restriction: "Provider restricted this account's request rate",
  key_product_mismatch: "Provider reported a key for a different product",
  unspecified_429:
    "Provider rejected the request (429); specific reason unavailable",
  provider_rejected: "Provider rejected the request",
};
export default function ModelActivity() {
  const { backend } = useApp();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<ModelAttempt[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const query = new URLSearchParams();
  for (const key of ["provider", "status", "opportunity", "proposal", "job"]) {
    const v = params.get(key);
    if (v) query.set(key, v);
  }
  const filterKey = query.toString();
  useEffect(() => {
    if (!backend) return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    setRows([]);
    setCursor(null);
    backend
      .request<{ records: ModelAttempt[]; next_cursor: string | null }>(
        `/v1/model-activity?limit=25${filterKey ? "&" + filterKey : ""}`,
        { signal: abort.signal },
      )
      .then(({ data }) => {
        if (!abort.signal.aborted) {
          setRows(data.records);
          setCursor(data.next_cursor);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [backend, filterKey, refresh]);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  async function more() {
    if (!backend || !cursor) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await backend.request<{
        records: ModelAttempt[];
        next_cursor: string | null;
      }>(
        `/v1/model-activity?limit=25&cursor=${cursor}${filterKey ? "&" + filterKey : ""}`,
      );
      setRows((p) => [...p, ...data.records]);
      setCursor(data.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load activity");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      aria-label="Model activity"
      style={{ padding: 24, marginBottom: 24 }}
    >
      <h2>Model activity</h2>
      <p>
        Every provider attempt, newest first. Success means the response passed
        validation. Skipped means no generation request was sent. Token counts
        are provider-reported; reserved amounts are estimates.
      </p>
      <div className="admin-toolbar">
        <select
          className="input"
          aria-label="Model provider"
          value={params.get("provider") || ""}
          onChange={(e) => setFilter("provider", e.target.value)}
        >
          <option value="">All providers</option>
          {["gemini", "qwen", "mistral", "groq", "zai", "cloudflare"].map(
            (p) => (
              <option key={p} value={`${p}_free`}>
                {p === "zai" ? "z.ai" : p}
              </option>
            ),
          )}
        </select>
        <select
          className="input"
          aria-label="Model outcome"
          value={params.get("status") || ""}
          onChange={(e) => setFilter("status", e.target.value)}
        >
          <option value="">All outcomes</option>
          {[
            "running",
            "succeeded",
            "failed",
            "skipped",
            "waiting",
            "interrupted",
            "historical",
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setRefresh((x) => x + 1)}
        >
          Refresh model activity
        </Button>
        {["job", "opportunity", "proposal"].some((k) => params.has(k)) && (
          <Button
            variant="ghost"
            onClick={() => {
              const next = new URLSearchParams(params);
              for (const k of ["job", "opportunity", "proposal"])
                next.delete(k);
              setParams(next);
            }}
          >
            Clear linked-record filter
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {busy && <p role="status">Loading model activity…</p>}
      {!busy && !error && !rows.length && (
        <p>No model attempts match these filters.</p>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Operation / linked record</th>
              <th>Provider / model</th>
              <th>Outcome</th>
              <th>Tokens</th>
              <th>Time / details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.operation.replaceAll("_", " ")}</strong>
                  <div>
                    {a.opportunity_id ? (
                      <Link to={`/opportunities/${a.opportunity_id}`}>
                        {a.opportunity_title || "Open opportunity"}
                      </Link>
                    ) : a.operation === "connection_probe" ? (
                      "Connection check"
                    ) : (
                      "Workspace operation"
                    )}
                  </div>
                  {a.proposal_id && (
                    <Link to={`/proposals/${a.proposal_id}`}>
                      Open proposal
                    </Link>
                  )}
                  <div className="small muted">
                    Round {a.round_number || "not recorded"} · Worker attempt{" "}
                    {a.worker_attempt || "not recorded"}
                  </div>
                </td>
                <td>
                  {a.provider.replace("_free", "").replace("zai", "z.ai")}
                  <div dir="auto">{a.model || "No model configured"}</div>
                </td>
                <td>
                  <Badge
                    tone={
                      a.status === "succeeded"
                        ? "green"
                        : a.status === "failed"
                          ? "red"
                          : "neutral"
                    }
                  >
                    {a.status}
                  </Badge>
                  <div>{a.result_code}</div>
                  {(a.provider_error_reason || a.http_status === 429) && (
                    <p className="small">
                      {rejectionReasons[
                        a.provider_error_reason || "unspecified_429"
                      ] || "Provider rejected the request"}
                    </p>
                  )}
                  {a.status === "historical" && (
                    <p className="small">
                      Historical usage; response validation outcome was not
                      recorded.
                    </p>
                  )}
                </td>
                <td>
                  Input: {count(a.actual_input)}
                  <br />
                  Output: {count(a.actual_output)}
                  <br />
                  <span className="small muted">
                    Reasoning: {count(a.thinking_tokens)} (may be included in
                    output)
                  </span>
                </td>
                <td>
                  {when(a.started_at)}
                  <div>
                    {a.duration_ms == null
                      ? "Duration not recorded"
                      : `${(a.duration_ms / 1000).toFixed(2)} s`}
                  </div>
                  <details>
                    <summary>Attempt details</summary>
                    <dl style={{ overflowWrap: "anywhere" }}>
                      {Object.entries({
                        "Generation request sent": a.sent ? "Yes" : "No",
                        "HTTP status": a.http_status,
                        "Provider error code": a.provider_error_code,
                        "Provider error type": a.provider_error_type,
                        "Request phase": a.request_phase,
                        "Provider request ID": a.request_id,
                        "Response ID": a.response_id,
                        "Remote request ID": a.remote_request_id,
                        "Reported model": a.reported_model,
                        "Finish reason": a.finish_reason,
                        "Project / account": a.project_ref,
                        "Reserved input": a.reserved_input,
                        "Reserved output": a.reserved_output,
                        "Usage state": a.usage_state,
                        "Usage record": a.usage_id,
                        "Job ID": a.job_id,
                        "Plan ID": a.plan_id,
                        "Job status": a.job_status,
                        Finished: when(a.finished_at),
                        "Provider retry after": when(a.retry_after),
                        "Job next attempt": when(a.next_attempt_at),
                      }).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v ?? "Not recorded"}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <Button variant="secondary" disabled={busy} onClick={more}>
          Load older attempts
        </Button>
      )}
    </section>
  );
}
