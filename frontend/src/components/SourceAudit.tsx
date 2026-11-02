import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useApp } from "../lib/store";
import { dateTime } from "../lib/format";
import { Button } from "./ui";

const auditRow = z.object({
  id: z.uuid(),
  action: z.string(),
  entity_id: z.uuid().nullable(),
  actor_id: z.uuid().nullable(),
  created_at: z.string(),
});
const auditPage = z.object({
  records: z.array(auditRow).max(500),
  next_cursor: z.uuid().nullable(),
});
type AuditRow = z.infer<typeof auditRow>;

export default function SourceAudit({ sourceId }: { sourceId: string }) {
  const { backend } = useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const savedRows = useRef<AuditRow[]>([]);
  const savedCursor = useRef<string | null>(null);
  const seenCursors = useRef(new Set<string>());

  const load = useCallback(
    async (append = false) => {
      if (!backend || request.current) return;
      const abort = new AbortController();
      request.current = abort;
      const after = append ? savedCursor.current : null;
      if (!append) {
        savedRows.current = [];
        savedCursor.current = null;
        seenCursors.current.clear();
        setRows([]);
        setCursor(null);
        setLoaded(false);
      }
      setBusy(true);
      setError("");
      try {
        const { data } = await backend.request<unknown>(
          `/v1/audit-events?limit=500${after ? `&cursor=${after}` : ""}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        const page = auditPage.parse(data);
        const ids = new Set(savedRows.current.map((row) => row.id));
        if (
          page.records.some((row) => {
            if (ids.has(row.id) || (after && row.id <= after)) return true;
            ids.add(row.id);
            return false;
          }) ||
          (page.next_cursor &&
            (!page.records.length ||
              page.records.at(-1)?.id !== page.next_cursor ||
              seenCursors.current.has(page.next_cursor) ||
              (after && page.next_cursor <= after)))
        )
          throw new Error("Decision history did not advance. Please retry.");
        savedRows.current = [...savedRows.current, ...page.records];
        savedCursor.current = page.next_cursor;
        if (page.next_cursor) seenCursors.current.add(page.next_cursor);
        setRows(savedRows.current);
        setCursor(page.next_cursor);
        setLoaded(true);
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Decision history could not be loaded.",
          );
      } finally {
        if (request.current === abort) {
          request.current = null;
          setBusy(false);
        }
      }
    },
    [backend, sourceId],
  );

  useEffect(() => {
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

  const decisions = rows
    .filter((row) => row.entity_id === sourceId)
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
    );
  return (
    <section className="panel admin-section" aria-label="Decision history">
      <h2>Decision history</h2>
      <p className="admin-help">
        Browse saved workspace history to find decisions for this source.
      </p>
      {!backend && (
        <p role="alert">
          Decision history is unavailable without a workspace connection.
        </p>
      )}
      {loaded && (
        <p className="small muted">
          {rows.length.toLocaleString()} workspace events checked ·{" "}
          {decisions.length.toLocaleString()} decisions for this source.
          {cursor && " More workspace events are available."}
        </p>
      )}
      {decisions.length > 0 && (
        <ul className="admin-activity">
          {decisions.map((row) => (
            <li key={row.id}>
              {row.action}
              <span>
                {row.actor_id || "Actor not recorded"} ·{" "}
                {dateTime(row.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {loaded && !decisions.length && (
        <p className="admin-help">
          {cursor
            ? "No decisions for this source in the loaded history. Load more workspace events to continue."
            : "No decisions recorded for this source."}
        </p>
      )}
      {busy && <p role="status">Loading decision history…</p>}
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {error ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void load(loaded)}
        >
          Retry loading history
        </Button>
      ) : cursor ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load more workspace events
        </Button>
      ) : null}
      {backend && loaded && (
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          Refresh history
        </Button>
      )}
    </section>
  );
}
