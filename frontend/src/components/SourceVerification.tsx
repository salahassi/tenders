import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button } from "./ui";
import { dateTime } from "../lib/format";
type Challenge = {
  id: string;
  challenge_id: string;
  image: string;
  expires_at: string;
  url: string;
};
export default function SourceVerification({
  sourceId,
  revision,
  needsRetry = false,
}: {
  sourceId: string;
  revision?: number;
  needsRetry?: boolean;
}) {
  const { backend, runCommand, notify } = useApp();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!backend || document.hidden) return;
      try {
        const result = await backend.request<Challenge | null>(
          `/v1/sources/${sourceId}/verification`,
        );
        const value = result.data;
        if (
          value !== null &&
          (!value ||
            typeof value.id !== "string" ||
            typeof value.challenge_id !== "string" ||
            typeof value.image !== "string" ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.image) ||
            typeof value.expires_at !== "string" ||
            !Number.isFinite(Date.parse(value.expires_at)))
        )
          throw new Error(
            "The source returned an invalid verification prompt.",
          );
        if (active) {
          setChallenge(result.data);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Cannot load verification.",
          );
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [backend, sourceId]);
  useEffect(() => {
    setAnswer("");
    setSubmitted(false);
  }, [challenge?.challenge_id]);
  if (!challenge && !needsRetry) return null;
  async function submit() {
    if (!challenge || !runCommand) return;
    setBusy(true);
    setError("");
    try {
      await runCommand("source.verification.answer", {
        id: challenge.id,
        challenge_id: challenge.challenge_id,
        answer: answer.trim(),
      });
      setSubmitted(true);
      setAnswer("");
      notify(
        "Verification sent. Collection continues in the saved browser session.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Verification could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!runCommand || revision === undefined) return;
    setBusy(true);
    setError("");
    try {
      await runCommand("source.collect", {
        id: sourceId,
        expected_revision: revision,
      });
      notify(
        "Browser collection requested. Keep this page open for any verification prompt.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Collection could not be requested.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel admin-section"
      aria-labelledby="source-verification-title"
    >
      <h2 id="source-verification-title">Verify access to the source</h2>
      {error && <p role="alert">{error}</p>}
      {challenge ? (
        <>
          <p>
            The official source asks for human verification. Enter the code
            shown below to continue collection. The browser session is saved
            securely for reuse while the source accepts it.
          </p>
          {/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(challenge.image) && (
            <img
              src={challenge.image}
              alt="Live human verification challenge from the official source"
              style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain" }}
            />
          )}
          <p className="admin-help">
            This code expires at {dateTime(challenge.expires_at)}.
          </p>
          <label className="field">
            Verification code
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              disabled={submitted || busy}
            />
          </label>
          <Button
            onClick={submit}
            disabled={busy || submitted || !answer.trim()}
          >
            {submitted
              ? "Waiting for verification result"
              : "Verify and continue"}
          </Button>
        </>
      ) : (
        <>
          <p>
            The previous verification window closed. Request a new collection
            and keep this page open; a new challenge will appear here when the
            browser reaches it.
          </p>
          <Button onClick={retry} disabled={busy || revision === undefined}>
            Request a new verification
          </Button>
        </>
      )}
    </section>
  );
}
