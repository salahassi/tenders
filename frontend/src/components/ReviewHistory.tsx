import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button } from "./ui";
import { downloadOriginal } from "../lib/remoteFiles";
type Row = Record<string, any>;
export default function ReviewHistory({ proposalId }: { proposalId: string }) {
  const { backend, state } = useApp(),
    [inputs, setInputs] = useState<Row[]>([]),
    [files, setFiles] = useState<Row[]>([]),
    [error, setError] = useState("");
  async function load() {
    if (!backend) return;
    try {
      const [rows, documents] = await Promise.all([
        backend.list<Row>("review-inputs", { proposal: proposalId }),
        backend.list<Row>("documents"),
      ]);
      setInputs(rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      setFiles(documents.filter((d) => !d.archived));
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load shared feedback.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [backend, proposalId, state.proposals]);
  if (!backend) return null;
  return (
    <section className="panel commercial-panel">
      <h2>Shared review inputs</h2>
      <p>
        Feedback from all authorized reviewers, including attachments and its
        original proposal version. Your editable feedback remains in the
        sections above.
      </p>
      <Button onClick={load}>Refresh shared feedback</Button>
      {error && <p role="alert">{error}</p>}
      {!inputs.length && !error && <p>No saved review inputs.</p>}
      {inputs.map((r) => (
        <details key={r.id} className="commercial-card">
          <summary>
            {r.target_kind}
            {r.target_id ? ` · ${r.target_id}` : ""} ·{" "}
            {new Date(r.updated_at).toLocaleString()}
          </summary>
          <p>
            <small>
              Reviewer: {r.created_by} · Base version: {r.base_version_id}
            </small>
          </p>
          <p className="commercial-evidence" dir="auto">
            {r.body || "Attachment-only feedback"}
          </p>
          {files
            .filter((d) => d.review_input_id === r.id)
            .map((d) => (
              <div key={d.id}>
                <Button
                  onClick={() =>
                    downloadOriginal(backend, d.id, d.original_name).catch(
                      (e) => setError(e.message),
                    )
                  }
                >
                  Download {d.original_name}
                </Button>
                <details>
                  <summary>Extracted text · {d.status}</summary>
                  <p className="commercial-evidence" dir="auto">
                    {d.extracted_text || "No readable extracted text."}
                  </p>
                </details>
              </div>
            ))}
        </details>
      ))}
    </section>
  );
}
