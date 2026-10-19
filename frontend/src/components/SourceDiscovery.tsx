import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/store";
import { Button, Field, Modal } from "./ui";

export default function SourceDiscovery() {
  const { state, runCommand, saving, notify } = useApp();
  const [open, setOpen] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  async function discover() {
    setError("");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:")
        throw Error("Enter a public HTTPS URL.");
      if (!runCommand) return;
      await runCommand("source.discover", { url: parsed.href });
      setOpen(false);
      notify(
        "Source discovery queued. Follow progress in Jobs; suggestions appear here for review.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Source discovery failed.");
    }
  }
  return (
    <>
      {state.settings.role === "Owner" && (
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          Discover sources
        </Button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Discover sources"
      >
        <p>
          Provide a public directory or procurement page. The system reads it
          and suggests tender sources for review.
        </p>
        <Field label="Directory or procurement page URL">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
          />
        </Field>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="admin-form-actions">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || !url.trim()}
            onClick={() => void discover()}
          >
            Find source suggestions
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function SourceSuggestions() {
  const { state } = useApp();
  const suggestions = state.sources.filter(
    (s) => s.status === "proposed" && s.adapterConfig?.discovery_job,
  );
  return (
    <>
      {suggestions.length > 0 && (
        <div className="panel admin-section">
          <h2>Suggested sources</h2>
          <p>
            Review a suggestion and enable it to begin automatic collection.
          </p>
          <ul>
            {suggestions.map((s) => (
              <li key={s.id}>
                <Link to={`/sources/${s.id}`} className="admin-link">
                  {s.name}
                </Link>
                <p className="small muted" style={{ overflowWrap: "anywhere" }}>
                  {s.url}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
