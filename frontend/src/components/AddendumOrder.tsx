import { useState } from "react";
import { useApp } from "../lib/store";
import type { DocumentRecord } from "../types";
import { Button, Field } from "./ui";
export default function AddendumOrder({ files }: { files: DocumentRecord[] }) {
  const { backend, runCommand, refresh, state, saving } = useApp(),
    [selected, setSelected] = useState(""),
    [precedence, setPrecedence] = useState("0"),
    [supersedes, setSupersedes] = useState(""),
    [error, setError] = useState("");
  if (!backend || state.settings.role === "Reviewer" || !files.length)
    return null;
  return (
    <details className="commercial-card">
      <summary>RFP addenda and precedence</summary>
      <p>
        Higher precedence controls conflicts. An addendum can supersede one
        earlier file. Originals and past versions remain available; changing
        precedence invalidates existing approvals.
      </p>
      <Field label="Document to order">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            const d = files.find((f) => f.id === e.target.value);
            setPrecedence(String(d?.precedence || 0));
            setSupersedes(d?.supersedesId || "");
          }}
        >
          <option value="">Choose a document</option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Precedence (0–1000)">
        <input
          type="number"
          min="0"
          max="1000"
          value={precedence}
          onChange={(e) => setPrecedence(e.target.value)}
        />
      </Field>
      <Field label="Supersedes">
        <select
          value={supersedes}
          onChange={(e) => setSupersedes(e.target.value)}
        >
          <option value="">Does not supersede another file</option>
          {files
            .filter((f) => f.id !== selected)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </Field>
      {error && <p role="alert">{error}</p>}
      <Button
        disabled={
          saving ||
          !selected ||
          !/^\d+$/.test(precedence) ||
          Number(precedence) > 1000
        }
        onClick={async () => {
          try {
            const { data } = await backend.request<{ revision: number }>(
              `/v1/documents/${selected}`,
            );
            await runCommand!("document.precedence", {
              id: selected,
              expected_revision: data.revision,
              precedence: Number(precedence),
              supersedes_id: supersedes || null,
            });
            await refresh?.();
            setError("");
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Unable to update precedence.",
            );
          }
        }}
      >
        Save precedence
      </Button>
    </details>
  );
}
