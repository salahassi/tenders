import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import { providerLabel } from "../lib/modelProviders";
type Row = Record<string, any>;
export default function ModelUsageReview() {
  const { backend, runCommand, state, saving, notify } = useApp();
  const owner = state.settings.role === "Owner";
  const [usage, setUsage] = useState<Row[]>([]),
    [resolution, setResolution] = useState<Row | null>(null);
  const [actualInput, setActualInput] = useState(""),
    [actualOutput, setActualOutput] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    if (!backend) return;
    const rows = await backend.list<Row>("provider-usage", {
      state: "unknown",
    });
    setUsage(rows);
    setReady(true);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [backend]);
  async function command(operation: string, input: Row) {
    if (!owner || !runCommand || saving || busy) return false;
    setBusy(true);
    setError("");
    try {
      await runCommand(operation, input);
      await load();
      notify("Verified usage saved.");
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save verified usage.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      <p>
        Provider attempts, results and token counts are in{" "}
        <a href="#/jobs">Activity &amp; jobs</a>. This section resolves unknown
        usage using a verified provider record.
      </p>
      {!ready ? (
        <p>Loading usage…</p>
      ) : (
        <>
          <h2>Usage requiring review</h2>
          <p>
            Unknown usage keeps its reserved allowance. Reconcile only against
            the provider's usage record.
          </p>
          {usage
            .filter((u) => u.state === "unknown")
            .map((u) => (
              <div key={u.id}>
                <p>
                  {providerLabel(u.provider)} · {u.model} · {u.created_at} ·
                  reserved {u.reserved_input} input / {u.reserved_output} output
                </p>
                <Button
                  disabled={!owner || saving || busy}
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
                  !owner ||
                  busy ||
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
