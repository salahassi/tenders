import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import {
  setOverviewHealthVisible,
  useOverviewHealthVisible,
} from "../lib/overviewHealth";
import { Button, Field } from "./ui";
import "../pages/admin.css";
type Status = {
  server_time: string;
  last_heartbeat_at: string | null;
  last_source_success_at: string | null;
  last_maintenance_at: string | null;
  scheduler_enabled: boolean;
  reserved_storage_bytes: string;
  cleanup_bytes: string;
  extracted_bytes: string;
  database_bytes: string;
  queued_jobs: number;
  blocked_jobs: number;
  cleanup_pending: number;
  cleanup_blocked: number;
  calls_today: number;
  input_tokens_today: string;
  output_tokens_today: string;
  unknown_usage: number;
  usage_day: string;
  model_enabled: boolean;
};
type Opportunity = {
  id: string;
  title: string;
  revision: number;
  archived: boolean;
};
type Preview = {
  id: string;
  title: string;
  archived: boolean;
  active_worker: boolean;
  preview_hash: string;
  counts: Record<string, number>;
  files: { id: string; name: string; size: number; hash: string }[];
};
const when = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "No recorded run";
const mib = (v: string | number | undefined) =>
  (Number(v || 0) / 1048576).toFixed(1) + " MiB";
export default function OperationsPanel({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { backend, state } = useApp(),
    owner = state.settings.role === "Owner",
    canEdit = state.settings.role !== "Reviewer";
  const [status, setStatus] = useState<Status | null>(null),
    [opportunities, setOpportunities] = useState<Opportunity[]>([]),
    [cleanup, setCleanup] = useState<
      { id: string; error_code: string; estimated_size: number }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [typed, setTyped] = useState(""),
    [ack, setAck] = useState(false);
  async function load() {
    if (!backend) return;
    setStatus((await backend.request<Status>("/v1/status")).data);
    if (!compact && canEdit) {
      setOpportunities(await backend.list<Opportunity>("opportunities"));
      if (owner)
        setCleanup(
          (
            await backend.list<{
              id: string;
              status: string;
              error_code: string;
              estimated_size: number;
            }>("storage-cleanup")
          ).filter((x) => x.status === "blocked"),
        );
    }
  }
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) void load().catch((e) => active && setError(e.message));
    };
    refresh();
    const id = setInterval(refresh, 60000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [backend, compact, canEdit, owner]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }
  const opportunity = opportunities.find((o) => o.id === selected),
    delayed =
      status &&
      (!status.last_heartbeat_at ||
        Date.parse(status.server_time) - Date.parse(status.last_heartbeat_at) >
          600000);
  const showOnOverview = useOverviewHealthVisible();
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <div className="admin-spread operations-heading">
        <h2>Processing health</h2>
        {compact ? (
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Hide processing health"
            onClick={() => setOverviewHealthVisible(false)}
          >
            Hide
          </button>
        ) : (
          <label className="admin-inline-check">
            <input
              type="checkbox"
              checked={showOnOverview}
              onChange={(event) =>
                setOverviewHealthVisible(event.target.checked)
              }
            />
            Show on the overview
          </label>
        )}
      </div>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!status ? (
        <p>Loading server status…</p>
      ) : (
        <>
          <p role="status">
            {delayed
              ? "Background processing delayed"
              : "Background processing is responding"}{" "}
            · Scheduler{" "}
            {status.scheduler_enabled ? "enabled" : "not configured"} · Model{" "}
            {status.model_enabled ? "enabled" : "disabled"}
          </p>
          <dl className="operations-metrics">
            <div>
              <dt>Scheduler heartbeat</dt>
              <dd>{when(status.last_heartbeat_at)}</dd>
            </div>
            <div>
              <dt>Last successful source poll</dt>
              <dd>{when(status.last_source_success_at)}</dd>
            </div>
            <div>
              <dt>Maintenance</dt>
              <dd>{when(status.last_maintenance_at)}</dd>
            </div>
            <div>
              <dt>Jobs</dt>
              <dd>
                {status.queued_jobs} queued · {status.blocked_jobs} blocked
              </dd>
            </div>
            <div>
              <dt>Storage reserved</dt>
              <dd>
                {mib(status.reserved_storage_bytes)} / 250 MiB ·{" "}
                {mib(status.cleanup_bytes)} awaiting deletion
              </dd>
            </div>
            <div>
              <dt>Extracted text / database</dt>
              <dd>
                {mib(status.extracted_bytes)} / 20 MiB ·{" "}
                {mib(status.database_bytes)} / 250 MiB
              </dd>
            </div>
            <div>
              <dt>Usage on {status.usage_day} (Riyadh)</dt>
              <dd>
                {status.calls_today} calls · {status.input_tokens_today} input /{" "}
                {status.output_tokens_today} output tokens ·{" "}
                {status.unknown_usage} unresolved usage records
              </dd>
            </div>
            <div>
              <dt>File cleanup</dt>
              <dd>
                {status.cleanup_pending} pending · {status.cleanup_blocked}{" "}
                blocked
              </dd>
            </div>
          </dl>
          {delayed && (
            <p>
              Check whether the Supabase project is paused, then review the
              scheduler and worker logs. This signal reports a missing
              heartbeat; it does not identify the cause. Retry normal work after
              the heartbeat returns.
            </p>
          )}
        </>
      )}
      {!compact && canEdit && (
        <>
          <h3>Archive and restore opportunities</h3>
          <p>
            Archiving hides an opportunity from normal lists and requests
            cancellation of its processing. Its documents and submission history
            remain available for backup. Restoring makes it visible again.
          </p>
          <Field label="Opportunity">
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setSelected(e.target.value);
                setPreview(null);
                setTyped("");
                setAck(false);
              }}
            >
              <option value="">Choose an opportunity</option>
              {opportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.archived ? "Archived · " : ""}
                  {o.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason (at least 10 characters)">
            <textarea
              value={reason}
              maxLength={3000}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {opportunity && (
            <Button
              disabled={busy || reason.trim().length < 10}
              onClick={() =>
                run(async () => {
                  await backend.request(
                    `/v1/opportunities/${opportunity.id}/archive`,
                    {
                      method: "POST",
                      body: {
                        expected_revision: opportunity.revision,
                        archive: !opportunity.archived,
                        reason: reason.trim(),
                      },
                    },
                  );
                  setPreview(null);
                  setMessage(
                    opportunity.archived
                      ? "Opportunity restored. Reload the workspace to see it in normal lists."
                      : "Opportunity archived. Reload the workspace to update normal lists.",
                  );
                })
              }
            >
              {opportunity.archived
                ? "Restore opportunity"
                : "Archive opportunity"}
            </Button>
          )}
          {owner && opportunity?.archived && (
            <>
              <h3>Permanently delete an archived opportunity</h3>
              <p>
                This removes its related business records, versions and
                submission history. Original and export files are queued for
                deletion; storage remains reserved until deletion succeeds.
                Shared company references, source configuration and minimal
                model usage accounting are preserved. Download a complete backup
                first if you need to retain this history.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setPreview(
                      (
                        await backend.request<Preview>(
                          `/v1/opportunities/${selected}/purge-preview`,
                        )
                      ).data,
                    );
                    setTyped("");
                    setAck(false);
                  })
                }
              >
                Preview affected records and files
              </Button>
              {preview && (
                <>
                  <ul>
                    {Object.entries(preview.counts)
                      .filter(([, n]) => n)
                      .map(([table, n]) => (
                        <li key={table}>
                          {table.replaceAll("_", " ")}: {n}
                        </li>
                      ))}
                  </ul>
                  <details>
                    <summary>{preview.files.length} files</summary>
                    <ul>
                      {preview.files.map((f) => (
                        <li key={f.id}>
                          {f.name} · {mib(f.size)} ·{" "}
                          <code>{f.hash?.slice(0, 16)}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                  {preview.active_worker && (
                    <p role="alert">
                      A worker still holds a live lease. Wait for processing to
                      stop and refresh this preview.
                    </p>
                  )}
                  <Field label="Type the exact opportunity title">
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                    />
                  </Field>
                  <label className="commercial-check">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I understand that all listed versions and submission history
                    will be permanently removed.
                  </label>
                  <Button
                    disabled={
                      busy ||
                      preview.active_worker ||
                      typed !== preview.title ||
                      !ack ||
                      reason.trim().length < 10
                    }
                    onClick={() =>
                      run(async () => {
                        await backend.request(
                          `/v1/opportunities/${preview.id}/purge`,
                          {
                            method: "POST",
                            body: {
                              preview_hash: preview.preview_hash,
                              confirmed_title: typed,
                              acknowledge_history: ack,
                              reason: reason.trim(),
                            },
                          },
                        );
                        setPreview(null);
                        setSelected("");
                        setMessage(
                          "Business records deleted. File deletion is queued and tracked above.",
                        );
                      })
                    }
                  >
                    Permanently delete listed records
                  </Button>
                </>
              )}
            </>
          )}
          {owner && cleanup.length > 0 && (
            <>
              <h3>Blocked file cleanup</h3>
              {cleanup.map((c) => (
                <p key={c.id}>
                  {c.error_code} · {mib(c.estimated_size)}{" "}
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await backend.request(
                          `/v1/storage-cleanup/${c.id}/retry`,
                          { method: "POST", body: {} },
                        );
                        setMessage(
                          "Cleanup queued for another checked attempt.",
                        );
                      })
                    }
                  >
                    Retry cleanup
                  </Button>
                </p>
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
