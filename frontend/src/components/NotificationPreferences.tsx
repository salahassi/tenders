import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Badge, Button, Field } from "./ui";

type Preferences = {
  revision: number;
  email_enabled: boolean;
  failure_alerts: boolean;
  failure_interval_hours: number;
  review_reminders: boolean;
  review_interval_hours: number;
  language: "ar" | "en";
  next_review_at?: string;
};
type Delivery = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  error_code: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
};
type Settings = {
  preferences: Preferences;
  recipient: string | null;
  transport: { configured: boolean; issues?: string[] };
  deliveries: Delivery[];
};
const label: Record<string, string> = {
  queued: "Queued",
  sending: "Sending",
  retry_wait: "Retry scheduled",
  sent: "Accepted by mail server",
  failed: "Delivery failed",
  delivery_unknown: "Delivery unconfirmed",
  canceled: "Canceled",
};
export default function NotificationPreferences() {
  const { backend, runCommand, notify } = useApp();
  const [data, setData] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(reset = true) {
    if (!backend) return;
    const response = await backend.request<Settings>(
      "/v1/notification-settings",
    );
    setData(response.data);
    if (reset) setDraft(response.data.preferences);
  }
  useEffect(() => {
    void load().catch((e) =>
      setError(
        e instanceof Error
          ? e.message
          : "Unable to load notification preferences.",
      ),
    );
  }, [backend]);
  if (!backend) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data?.preferences);
  async function act(test = false) {
    if (!runCommand || !draft || busy) return;
    setBusy(true);
    setError("");
    try {
      if (test) await runCommand("notification.test", {});
      else
        await runCommand("notification.preferences", {
          expected_revision: draft.revision,
          email_enabled: draft.email_enabled,
          failure_alerts: draft.failure_alerts,
          failure_interval_hours: draft.failure_interval_hours ?? 24,
          review_reminders: draft.review_reminders,
          review_interval_hours: draft.review_interval_hours,
          language: draft.language,
        });
      await load();
      notify(
        test
          ? "Test email queued. Check delivery history for the actual result."
          : "Your notification preferences are saved.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save notification preferences.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel admin-section notification-preferences">
      <h2>Notification preferences</h2>
      <p>
        These preferences apply to your account. Emails go to your verified
        sign-in address.
      </p>
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {!draft || !data ? (
        <p role="status">Loading notification preferences…</p>
      ) : (
        <>
          <p>
            <strong>Recipient:</strong>{" "}
            <span dir="ltr">
              {data.recipient || "A verified email address is required"}
            </span>
          </p>
          <Badge tone={data.transport.configured ? "green" : "amber"}>
            {data.transport.configured
              ? "SMTP configured"
              : "SMTP setup required"}
          </Badge>
          <p className="admin-help">
            {data.transport.configured
              ? "Credentials are configured. Delivery history confirms whether the mail server accepted a message."
              : "Email delivery will start after SMTP is configured on the server. Collection, assessment and in-app notifications continue."}
          </p>
          {!data.transport.configured &&
            Boolean(data.transport.issues?.length) && (
              <p className="admin-help">
                Missing or invalid server settings:{" "}
                {data.transport.issues?.join(", ")}
              </p>
            )}
          <div className="stack">
            <label>
              <input
                type="checkbox"
                checked={draft.email_enabled}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, email_enabled: e.target.checked })
                }
              />{" "}
              Email notifications
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.failure_alerts}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, failure_alerts: e.target.checked })
                }
              />{" "}
              Alert me when collection or assessment keeps failing
            </label>
            <p className="admin-help">
              One email summarizes new failure causes. More affected tasks do
              not repeat an alert while the same issue continues. A recovered
              issue can alert again if it returns, subject to the frequency
              below. Automatic recovery continues; resolved issues are excluded.
            </p>
            <label>
              <input
                type="checkbox"
                checked={draft.review_reminders}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, review_reminders: e.target.checked })
                }
              />{" "}
              Remind me about items waiting for review
            </label>
          </div>
          <div className="admin-form-grid">
            <Field label="Failure alert frequency">
              <select
                aria-label="Failure alert frequency"
                value={draft.failure_interval_hours ?? 24}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    failure_interval_hours: Number(e.target.value),
                  })
                }
              >
                <option value={1}>At most once an hour</option>
                <option value={6}>At most every 6 hours</option>
                <option value={12}>At most every 12 hours</option>
                <option value={24}>At most daily</option>
              </select>
            </Field>
            <Field label="Review reminder frequency">
              <select
                aria-label="Review reminder frequency"
                value={draft.review_interval_hours}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    review_interval_hours: Number(e.target.value),
                  })
                }
              >
                <option value={6}>Every 6 hours</option>
                <option value={12}>Every 12 hours</option>
                <option value={24}>Daily</option>
                <option value={48}>Every 2 days</option>
                <option value={168}>Weekly</option>
              </select>
            </Field>
            <Field label="Email language">
              <select
                aria-label="Email language"
                value={draft.language}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    language: e.target.value as "ar" | "en",
                  })
                }
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
          <p className="admin-help">
            Reminders include current discoveries and proposals that need
            review. No reminder is sent when both queues are empty.
          </p>
          <div className="admin-form-actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void act()}
            >
              Save notification preferences
            </Button>
            <Button
              disabled={
                busy ||
                dirty ||
                !data.transport.configured ||
                !data.preferences.email_enabled ||
                !data.recipient
              }
              onClick={() => void act(true)}
            >
              Send test email to me
            </Button>
          </div>
          <details>
            <summary>SMTP connection setup</summary>
            <p>
              Works with Resend or any SMTP provider. Store these values in
              Supabase Secrets:
            </p>
            <ul>
              <li>
                <code>APP_SMTP_HOST</code> — SMTP server
              </li>
              <li>
                <code>APP_SMTP_PORT</code> — 465 / 2465 for TLS, or 587 / 2587
                for STARTTLS
              </li>
              <li>
                <code>APP_SMTP_USER</code> — SMTP username
              </li>
              <li>
                <code>APP_SMTP_PASSWORD</code> — SMTP password or provider API
                key
              </li>
              <li>
                <code>APP_SMTP_FROM</code> — verified sender email address
              </li>
            </ul>
            <p>
              Passwords stay on the server. Resend uses{" "}
              <code>smtp.resend.com</code>, username <code>resend</code>, and
              its API key as the password.
            </p>
          </details>
          <h3>Recent email delivery</h3>
          <Button
            disabled={busy}
            onClick={() => void load(false).catch((e) => setError(String(e)))}
          >
            Refresh delivery history
          </Button>
          {data.deliveries.length ? (
            <ul className="stack">
              {data.deliveries.map((d) => (
                <li key={d.id}>
                  <strong>
                    {d.kind === "review_digest"
                      ? "Review reminder"
                      : d.kind === "test"
                        ? "Test email"
                        : "Processing alert"}
                  </strong>{" "}
                  · {label[d.status] || d.status} · Attempts: {d.attempts}
                  {d.error_code && <div>{d.error_code}</div>}
                  {d.status === "delivery_unknown" && (
                    <p>
                      The SMTP connection ended without a confirmed result.
                      Automatic resend is paused to avoid sending the same email
                      twice.
                    </p>
                  )}
                  <div className="muted small">
                    {new Intl.DateTimeFormat("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Asia/Riyadh",
                    }).format(new Date(d.created_at))}{" "}
                    Riyadh
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>No notification email has been queued yet.</p>
          )}
        </>
      )}
    </section>
  );
}
