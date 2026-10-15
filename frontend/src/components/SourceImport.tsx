import { useState } from "react";
import Papa from "papaparse";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
export default function SourceImport() {
  const { runCommand, saving, notify, state } = useApp();
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState("");
  if (!runCommand || state.settings.role === "Reviewer") return null;
  return (
    <details className="panel admin-section">
      <summary>Import candidate sources from CSV</summary>
      <p>
        Include name and url columns, with up to 100 rows. Imported candidates
        need an Owner to configure an adapter and approve collection.
      </p>
      <Field label="Source CSV">
        <input
          type="file"
          accept=".csv"
          disabled={saving}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setPreview(null);
            setError("");
            try {
              if (file.size > 1048576)
                throw new Error("Choose a CSV smaller than 1 MiB.");
              const csv = Papa.parse<Record<string, string>>(
                await file.text(),
                { header: true, skipEmptyLines: true },
              );
              if (csv.errors.length) throw new Error(csv.errors[0].message);
              setPreview(
                await runCommand("import.preview", {
                  kind: "sources",
                  rows: csv.data,
                }),
              );
            } catch (e) {
              setError(e instanceof Error ? e.message : "Preview failed.");
            }
          }}
        />
      </Field>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <>
          <ul>
            {(preview.rows as { name: string; url: string }[]).map((r, i) => (
              <li key={i}>
                {r.name} — {r.url}
              </li>
            ))}
          </ul>
          <Button
            disabled={saving}
            onClick={async () => {
              try {
                const result = await runCommand(
                  "import.commit",
                  {
                    id: preview.id,
                    expected_revision: preview.revision,
                    preview_hash: preview.preview_hash,
                  },
                  `import:${preview.id}`,
                );
                notify(`${result.processed} candidate rows processed.`);
                setPreview(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Import failed.");
              }
            }}
          >
            Import these candidates
          </Button>
        </>
      )}
    </details>
  );
}
