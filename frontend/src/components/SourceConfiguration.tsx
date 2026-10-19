import { useState } from "react";
import type { Source } from "../types";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
export default function SourceConfiguration({ source }: { source: Source }) {
  const { runCommand, saving, notify, state } = useApp();
  const [url, setUrl] = useState(source.url),
    [kind, setKind] = useState(
      source.type === "manual"
        ? source.adapterConfig?.extraction
          ? "link_directory"
          : ""
        : source.type,
    ),
    [hosts, setHosts] = useState((source.approvedHosts || []).join(", ")),
    [policy, setPolicy] = useState(source.policy),
    [hours, setHours] = useState(source.pollHours || 6),
    [config, setConfig] = useState(
      JSON.stringify(
        source.adapterConfig?.extraction ||
          (source.type === "json_feed" ? source.adapterConfig : {}) ||
          {},
        null,
        2,
      ),
    ),
    [official, setOfficial] = useState(
      source.adapterConfig?.official_listing ||
        (source.type === "manual" && source.adapterConfig?.extraction)
        ? source.adapterConfig?.discover_source_links === true
          ? "combined"
          : "configured"
        : "",
    ),
    [error, setError] = useState("");
  if (!runCommand || state.settings.role !== "Owner") return null;
  async function save() {
    setError("");
    try {
      if (!kind)
        throw new Error(
          "Choose a collection method. Saving a portal link alone does not configure automatic collection.",
        );
      await runCommand!("source.configure", {
        id: source.id,
        expected_revision: source.revision,
        url,
        kind,
        approved_hosts: hosts
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
        policy_note: policy,
        poll_interval_hours: hours,
        adapter_config:
          kind === "json_feed"
            ? JSON.parse(config)
            : {
                ...(source.adapterConfig?.catalog
                  ? { catalog: source.adapterConfig.catalog }
                  : {}),
                ...(source.adapterConfig?.extraction
                  ? { extraction: source.adapterConfig.extraction }
                  : {}),
                ...(kind === "link_directory" && official
                  ? {
                      official_listing:
                        source.adapterConfig?.official_listing || "configured",
                      extraction: JSON.parse(config),
                      ...(official === "combined"
                        ? { discover_source_links: true }
                        : {}),
                    }
                  : {}),
              },
      });
      notify(
        "Configuration saved. Review and enable the source to schedule collection.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Configuration failed.");
    }
  }
  return (
    <section className="panel admin-section">
      <h2>Collection settings</h2>
      <p>
        Choose a feed, a supported official tender listing, or a directory of
        candidate sources. Official listings collect notices from the latest
        page; review each original notice for complete terms and dates.
      </p>
      <Field label="Collection URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          type="url"
        />
      </Field>
      <Field label="Adapter">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="" disabled>
            Choose a collection method
          </option>
          <option value="rss">RSS / Atom</option>
          <option value="json_feed">JSON feed</option>
          <option value="link_directory">
            Website listing / link directory
          </option>
        </select>
      </Field>
      {kind === "link_directory" && (
        <Field label="Website listing">
          <select
            value={official}
            onChange={(e) => setOfficial(e.target.value)}
          >
            <option value="">Discover candidate source links</option>
            <option value="configured">
              Collect notices using saved extraction settings
            </option>
            <option value="combined">
              Collect notices and discover candidate sources
            </option>
          </select>
          <p className="muted small">
            {official === "combined"
              ? "Both use the same fetched page. Notices enter assessment; discovered sources stay proposed until configured and enabled. "
              : ""}
            Extraction settings are stored with this source in the database.
            Their URL must match the collection URL.
          </p>
        </Field>
      )}
      <Field label="Permitted hostnames, separated by commas">
        <input value={hosts} onChange={(e) => setHosts(e.target.value)} />
      </Field>
      <Field label="Collection permission and last review">
        <textarea
          value={policy}
          onChange={(e) => setPolicy(e.target.value)}
          placeholder="Record the permitted access basis and date you checked it."
        />
      </Field>
      <Field label="Hours between collections">
        <input
          type="number"
          min={1}
          max={168}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        />
      </Field>
      {(kind === "json_feed" || (kind === "link_directory" && official)) && (
        <Field
          label={
            kind === "json_feed"
              ? "JSON field map"
              : "Website extraction settings (JSON)"
          }
        >
          <textarea
            rows={8}
            value={config}
            onChange={(e) => setConfig(e.target.value)}
          />
          <p className="muted small">
            {kind === "json_feed"
              ? "Use dotted field paths: items and fields (title, description, url, reference, buyer, deadline_raw). Empty configuration uses those default field names."
              : "The seed supplies supported source settings. URL, buyer, timezone and listing/detail selectors are editable here. Saving pauses collection until you review and enable it."}{" "}
            Expressions are not executed.
          </p>
        </Field>
      )}
      <p className="muted small">
        Fetching also requires these hosts to be allowed in the backend
        deployment. Until then, a collection job shows the exact blocker.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="row">
        <Button disabled={saving} onClick={() => void save()}>
          Save settings and pause
        </Button>
        <Button
          disabled={saving || source.status !== "approved"}
          onClick={async () => {
            try {
              await runCommand("source.collect", {
                id: source.id,
                expected_revision: source.revision,
              });
              notify("Collection queued. Follow progress in Jobs.");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Request failed.");
            }
          }}
        >
          Collect now
        </Button>
      </div>
    </section>
  );
}
