import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import {
  createConnectedExport,
  downloadExport,
  saveReviewedExport,
} from "../lib/connectedExport";
import type { Proposal } from "../types";
type Row = Record<string, any>;
export default function ExportPanel({ proposal }: { proposal: Proposal }) {
  const { backend, state } = useApp(),
    [requests, setRequests] = useState<Row[]>([]),
    [artifacts, setArtifacts] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [result, setResult] = useState("");
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend || !proposal.versionId) return;
    try {
      const [r, a] = await Promise.all([
        backend.list<Row>("exports", { version: proposal.versionId }),
        backend.list<Row>("export-artifacts"),
      ]);
      setRequests(r.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setArtifacts(
        a
          .filter((x) => r.some((v) => v.id === x.export_id))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load exports.");
    }
  }
  useEffect(() => {
    void load();
  }, [backend, proposal.versionId]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setResult("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!backend || !proposal.versionId) return null;
  return (
    <section className="panel commercial-panel">
      <h2>Word export and reviewed artifacts</h2>
      <p>
        Draft and final exports use saved version {proposal.version}. Combined
        output is the default; separate technical and financial files follow the
        buyer’s instructions. Exports never submit a bid.
      </p>
      <p>
        Open Word, update the entire table of contents and all fields (Ctrl+A
        then F9 on Windows, or Word’s Update Table command), inspect every page
        and save. Create PDF manually from the reviewed Word file if required.
        Remove personal document properties before uploading the final file.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {result && <p role="status">{result}</p>}
      <Button
        disabled={busy}
        onClick={() =>
          run(() =>
            createConnectedExport(backend, proposal.versionId!, "draft"),
          )
        }
      >
        {busy ? "Preparing or verifying…" : "Download draft Word"}
      </Button>
      {owner && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            run(() =>
              createConnectedExport(backend, proposal.versionId!, "final"),
            )
          }
        >
          Authorize and download final Word
        </Button>
      )}
      <h3>Saved files</h3>
      {!artifacts.length && <p>No verified export files for this version.</p>}
      {artifacts.map((a) => (
        <div className="commercial-card" key={a.id}>
          <strong>{a.original_name}</strong>
          <p>
            {a.kind} · {a.status} ·{" "}
            {a.verification || "Awaiting server verification"}
          </p>
          <small>SHA-256: {a.content_hash}</small>
          {a.status === "ready" && (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = requests.find((r) => r.id === a.export_id);
                  if (r && new Date(r.expires_at) < new Date()) {
                    if (!owner && r.mode === "final")
                      throw Error(
                        "Ask the Owner to renew final authorization.",
                      );
                    await backend.request("/v1/commands", {
                      method: "POST",
                      body: {
                        commands: [
                          {
                            operation: "export.renew",
                            input: { id: r.id, expected_revision: r.revision },
                          },
                        ],
                      },
                      idempotencyKey: crypto.randomUUID(),
                    });
                  }
                  await downloadExport(backend, a);
                })
              }
            >
              Download verified bytes
            </Button>
          )}
        </div>
      ))}
      {owner && (
        <details>
          <summary>Save the file reviewed in Word</summary>
          <p>
            Choose the matching final export, then attach the saved DOCX or
            manually produced PDF. The actual file hash is recorded. DOCX body
            text must match the authorized content; PDF review is an Owner
            attestation and is labeled accordingly.
          </p>
          <Field label="Final export and volume">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose a final export</option>
              {requests
                .filter((r) => r.mode === "final")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.volume} · {new Date(r.created_at).toLocaleString()}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Reviewed DOCX or PDF">
            <input
              type="file"
              accept=".docx,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I updated all fields and the entire contents table, reviewed every
            page and verified this file matches the approved proposal, including
            its figures and required volume separation.
          </label>
          <Button
            disabled={busy || !selected || !file || !confirmed}
            onClick={() =>
              run(async () => {
                await saveReviewedExport(
                  backend,
                  requests.find((r) => r.id === selected)!,
                  file!,
                );
                setFile(null);
                setConfirmed(false);
                setResult(
                  "Reviewed file saved with its verified byte hash. Manual submission is recorded separately.",
                );
              })
            }
          >
            Verify and save reviewed artifact
          </Button>
        </details>
      )}
    </section>
  );
}
