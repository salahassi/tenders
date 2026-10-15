import { useEffect, useState, type FormEvent } from "react";
import { BackendClient } from "./backendClient";
import { deployment } from "./deployment";
import { ArrowRight, Eye, EyeOff, LockKeyhole } from "lucide-react";

export function authRedirect(recovery = false, invitationToken = "") {
  const base =
    import.meta.env.DEV &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1")
      ? window.location.origin
      : deployment.appOrigin;
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  url.search = "";
  url.hash = "";
  url.searchParams.set("mode", "connected");
  if (recovery) url.searchParams.set("auth", "recovery");
  if (!recovery && /^[a-f0-9]{64}$/.test(invitationToken))
    url.hash = `/invite/${invitationToken}`;
  return url.href;
}

function authErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return "The sign-in request failed. Please try again.";
  }
  const text = cause.message.toLowerCase();
  if (text.includes("email not confirmed")) {
    return "Confirm your email first, then sign in. Check your inbox and spam folder for the Supabase link.";
  }
  if (text.includes("invalid login credentials")) {
    return "Email or password is incorrect. If you have not created an account yet, open your invitation link and choose Create account.";
  }
  return cause.message;
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
  const [checkingInvitation, setCheckingInvitation] = useState(
    Boolean(invitationToken),
  );
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    let active = true;
    setInvited(false);
    setCheckingInvitation(Boolean(invitationToken));
    setView("signin");
    setEmail("");
    setPassword("");
    setConfirmation("");
    setShowPassword(false);
    setError("");
    setMessage("");
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
        })
        .finally(() => {
          if (active) setCheckingInvitation(false);
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
    setShowPassword(false);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || checkingInvitation) return;
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
            : "Check your email for the confirmation link. Confirm your email, then return to sign in and accept your invitation.",
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
      setError(authErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-panel" aria-label="Account access">
      <span className="auth-icon" aria-hidden="true">
        <LockKeyhole size={21} />
      </span>
      <h1>
        {recovery
          ? "Choose a new password"
          : view === "signup"
            ? "Accept your invitation"
            : view === "reset"
              ? "Reset your password"
              : "Sign in to Tenderdesk"}
      </h1>
      <p className="auth-description">
        {recovery
          ? "Choose a new password to get back to your workspace."
          : view === "signup"
            ? "Set your password to join your team’s workspace."
            : view === "reset"
              ? "Enter your account email and we’ll request a reset link."
              : "Welcome back. Use your email and password to continue."}
      </p>
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
      {checkingInvitation && (
        <p role="status" className="notice">
          Checking your invitation…
        </p>
      )}
      <form
        onSubmit={submit}
        className="auth-form"
        aria-busy={busy || checkingInvitation}
      >
        {!recovery && (
          <label className="field">
            Email address
            <input
              className="input"
              type="email"
              placeholder="you@company.com"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="username"
              value={email}
              readOnly={view === "signup" && invited}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
              disabled={busy || checkingInvitation}
            />
          </label>
        )}
        {(recovery || view !== "reset") && (
          <div className="field">
            <div className="auth-label-row">
              <label htmlFor="auth-password">
                {recovery ? "New password" : "Password"}
              </label>
              {!recovery && view === "signin" && (
                <button
                  type="button"
                  className="auth-text-button"
                  disabled={busy || checkingInvitation}
                  onClick={() => change("reset")}
                >
                  Forgot password?
                </button>
              )}
            </div>
            <div className="auth-password-input">
              <input
                id="auth-password"
                className="input"
                type={showPassword ? "text" : "password"}
                placeholder={
                  recovery || view === "signup"
                    ? "At least 12 characters"
                    : "Enter your password"
                }
                aria-describedby={
                  recovery || view === "signup"
                    ? "auth-password-help"
                    : undefined
                }
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
                disabled={busy || checkingInvitation}
              />
              <button
                type="button"
                className="auth-password-toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                disabled={busy || checkingInvitation}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {(recovery || view === "signup") && (
              <small id="auth-password-help">Use at least 12 characters.</small>
            )}
          </div>
        )}
        {(recovery || view === "signup") && (
          <label className="field">
            Confirm password
            <input
              className="input"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password again"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={12}
              maxLength={128}
              required
              disabled={busy || checkingInvitation}
            />
          </label>
        )}
        <button
          type="submit"
          className="btn btn-primary auth-submit"
          disabled={busy || checkingInvitation}
        >
          {busy
            ? "Please wait…"
            : recovery
              ? "Save new password"
              : view === "signup"
                ? "Create account"
                : view === "reset"
                  ? "Send reset link"
                  : "Sign in"}
          {!busy && <ArrowRight size={17} aria-hidden="true" />}
        </button>
      </form>
      {!recovery && (
        <div className="auth-navigation">
          {(invited || view !== "signin") && (
            <button
              className="auth-text-button"
              disabled={busy || checkingInvitation}
              onClick={() =>
                change(view === "signin" && invited ? "signup" : "signin")
              }
            >
              {view === "signin" ? "Create invited account" : "Back to sign in"}
            </button>
          )}
        </div>
      )}
      {!recovery && !invited && !checkingInvitation && view === "signin" && (
        <div className="auth-invitation-note">
          <strong>Joining for the first time?</strong>
          <p>
            Open the invitation link from your workspace administrator to create
            your account and choose your password.
          </p>
        </div>
      )}
    </section>
  );
}
