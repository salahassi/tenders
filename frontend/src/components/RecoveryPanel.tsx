import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import {
  downloadWorkspaceBackup,
  previewBackup,
  restoreWorkspaceBackup,
} from "../lib/connectedRecovery";
import type { BackupBundle } from "../lib/backupFormat";
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export default function RecoveryPanel() {
  const { backend, state } = useApp(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [bundle, setBundle] = useState<BackupBundle | null>(null),
    [consent, setConsent] = useState(false),
    [sessions, setSessions] = useState<any[]>([]),
    [session, setSession] = useState(""),
    [restored, setRestored] = useState(false),
    [origin, setOrigin] = useState<any>(null);
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend || !owner) return;
    const [s, b] = await Promise.all([
      backend.list<any>("restore-sessions"),
      backend.request<any>("/v1/bootstrap"),
    ]);
    setSessions(s.filter((x) => x.state === "staging"));
    setOrigin(b.data.workspace.restore_origin);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [backend, owner]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <h2>Backup and restore</h2>
      {origin && (
        <p role="status">
          This workspace was restored on{" "}
          {new Date(origin.restored_at).toLocaleString()}. Historical author IDs
          do not grant access. Review company facts, files, rates and templates
          before regenerating and approving a new version.
        </p>
      )}
      <p className="admin-help">
        Backups include saved business records, original documents and export
        files. Keep the ZIP privately. Accounts, invitations, service
        credentials and scheduler secrets are excluded. Large backups are best
        handled on a desktop browser.
      </p>
      {!owner ? (
        <p>Only the Owner can export or restore a workspace.</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="admin-error">
              {error}
            </p>
          )}
          {progress && (
            <p role="status" aria-live="polite">
              {progress}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const blob = await downloadWorkspaceBackup(
                  backend,
                  setProgress,
                );
                save(
                  blob,
                  `tenderdesk-backup-${new Date().toISOString().slice(0, 10)}.zip`,
                );
                setProgress(
                  "Backup verified and downloaded, including all listed originals.",
                );
              })
            }
          >
            Download complete backup
          </Button>
          <h3>Restore into an empty project</h3>
          <p>
            Use the same application schema and an empty workspace with your
            real Owner account. The complete archive is checked locally before
            any upload. All sources and model calls stay disabled after
            restoration; earlier approvals become historical and require a new
            review.
          </p>
          <Field label="Tenderdesk backup ZIP">
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                setBundle(null);
                setConsent(false);
                setRestored(false);
                if (file)
                  void run(async () => {
                    setProgress(
                      "Checking every record and original locally. Nothing has been uploaded.",
                    );
                    const preview = await previewBackup(file);
                    setBundle(preview);
                    setProgress(
                      "Archive checks passed. Review the exact contents before restoring.",
                    );
                  });
              }}
            />
          </Field>
          {bundle && (
            <>
              <p>
                <strong>{bundle.manifest.workspace_name}</strong> ·{" "}
                {bundle.rows.length} records · {bundle.manifest.files.length}{" "}
                originals/export files ·{" "}
                {(
                  bundle.manifest.files.reduce((n, f) => n + f.size, 0) /
                  1048576
                ).toFixed(1)}{" "}
                MiB
              </p>
              <details>
                <summary>Inspect original files and hashes</summary>
                <ul>
                  {bundle.manifest.files.map((f) => (
                    <li key={f.key}>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          save(
                            new Blob(
                              [bundle.files[f.key] as Uint8Array<ArrayBuffer>],
                              { type: f.mime },
                            ),
                            f.name,
                          )
                        }
                      >
                        {f.name}
                      </Button>{" "}
                      · {f.size} bytes · <code>{f.hash.slice(0, 16)}</code>
                    </li>
                  ))}
                </ul>
              </details>
              <label className="commercial-check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I reviewed this exact backup and its originals, including file
                metadata. Its business content is nonconfidential, nonpersonal
                and free of secrets. I understand that sources, model access and
                earlier approvals must be reviewed again.
              </label>
              <Button
                disabled={busy || !consent || restored}
                variant="primary"
                onClick={() =>
                  run(async () => {
                    await restoreWorkspaceBackup(
                      backend,
                      bundle,
                      setProgress,
                      setSession,
                    );
                    setRestored(true);
                    setProgress(
                      "The complete workspace was restored. Sources and models remain disabled. Reload to review the restored records.",
                    );
                  })
                }
              >
                Restore verified backup
              </Button>
              {restored && (
                <Button onClick={() => window.location.reload()}>
                  Reload restored workspace
                </Button>
              )}
            </>
          )}
          {!!sessions.length && (
            <>
              <h3>Pending restore</h3>
              <p>
                You can retry the same verified backup to resume. Canceling
                removes staged records; staged files are queued for cleanup.
              </p>
              {sessions.map((s) => (
                <p key={s.id}>
                  Started {new Date(s.created_at).toLocaleString()} · expires{" "}
                  {new Date(s.expires_at).toLocaleString()}{" "}
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await backend.request(
                          `/v1/recovery/restore/${s.id}/cancel`,
                          { method: "POST", body: {} },
                        );
                        setProgress(
                          "Pending restore canceled. Normal workspace editing is available.",
                        );
                        if (session === s.id) setSession("");
                      })
                    }
                  >
                    Cancel pending restore
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
