import { useEffect, useState, type FormEvent } from "react";
import { BackendClient } from "./backendClient";

export function authRedirect(recovery = false, invitationToken = "") {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("mode", "connected");
  if (recovery) url.searchParams.set("auth", "recovery");
  if (!recovery && /^[a-f0-9]{64}$/.test(invitationToken))
    url.hash = `/invite/${invitationToken}`;
  return url.href;
}
export function AuthPanel({
  client,
  recovery = false,
  onRecoveryDone,
  invitationToken = "",
}: {
  invitationToken?: string;
  client: BackendClient;
  recovery?: boolean;
  onRecoveryDone?: () => void;
}) {
  const [view, setView] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [invited, setInvited] = useState(false);
  useEffect(() => {
    let active = true;
    setInvited(false);
    if (invitationToken)
      void client
        .checkInvitation(invitationToken)
        .then((value) => {
          if (active) {
            setEmail(value.email);
            setInvited(true);
            setView("signup");
          }
        })
        .catch((cause) => {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : "This invitation is unavailable.",
            );
        });
    return () => {
      active = false;
    };
  }, [client, invitationToken]);
  const change = (next: typeof view) => {
    setView(next);
    setError("");
    setMessage("");
    setPassword("");
    setConfirmation("");
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (
        (view === "signup" || recovery) &&
        (password.length < 12 || password !== confirmation)
      )
        throw new Error(
          "Use at least 12 characters and enter the same password twice.",
        );
      if (recovery) {
        const { error } = await client.auth.auth.updateUser({ password });
        if (error) throw error;
        setPassword("");
        setConfirmation("");
        onRecoveryDone?.();
      } else if (view === "signin") {
        const { error } = await client.auth.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        setPassword("");
      } else if (view === "signup") {
        if (!invited)
          throw new Error("Ask your workspace Owner for an invitation.");
        const { data, error } = await client.auth.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: authRedirect(false, invitationToken) },
        });
        if (error) throw error;
        setPassword("");
        setConfirmation("");
        setMessage(
          data.session
            ? "Account created. Checking workspace access…"
            : "Check your email for the confirmation link. After confirmation, sign in here. Workspace access requires Owner approval.",
        );
      } else {
        const { error } = await client.auth.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: authRedirect(true) },
        );
        if (error) throw error;
        setMessage(
          "If this address can receive account emails, a password reset link has been requested. Check your inbox.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The sign-in request failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-panel" aria-label="Account access">
      <h2>
        {recovery
          ? "Choose a new password"
          : view === "signup"
            ? "Accept your invitation"
            : view === "reset"
              ? "Reset your password"
              : "Sign in with email"}
      </h2>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <form onSubmit={submit} className="stack">
        {!recovery && (
          <label className="field">
            Email address
            <input
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              readOnly={view === "signup" && invited}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
              disabled={busy}
            />
          </label>
        )}
        {(recovery || view !== "reset") && (
          <label className="field">
            {recovery ? "New password" : "Password"}
            <input
              className="input"
              type="password"
              autoComplete={
                recovery || view === "signup"
                  ? "new-password"
                  : "current-password"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={view === "signup" || recovery ? 12 : 1}
              maxLength={128}
              required
              disabled={busy}
            />
          </label>
        )}
        {(recovery || view === "signup") && (
          <label className="field">
            Confirm password
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={12}
              maxLength={128}
              required
              disabled={busy}
            />
          </label>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy
            ? "Please wait…"
            : recovery
              ? "Save new password"
              : view === "signup"
                ? "Create account"
                : view === "reset"
                  ? "Send reset link"
                  : "Sign in"}
        </button>
      </form>
      {!recovery && (
        <div
          className="row"
          style={{ justifyContent: "center", marginTop: 12 }}
        >
          {(invited || view !== "signin") && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                change(view === "signin" && invited ? "signup" : "signin")
              }
            >
              {view === "signin" ? "Create invited account" : "Back to sign in"}
            </button>
          )}
          {view === "signin" && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => change("reset")}
            >
              Forgot password?
            </button>
          )}
        </div>
      )}
      {!recovery && !invited && (
        <p>New accounts require an invitation from your workspace Owner.</p>
      )}
    </section>
  );
}
