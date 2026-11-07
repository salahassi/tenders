import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import {
  sourceReadingSummary,
  modelRoutingSummary,
} from "../lib/connectedRepository";
import { Button } from "./ui";

/** Fetch the full checkpoint only for an explicitly opened job. */
export default function JobDetails({ id }: { id: string }) {
  const { backend } = useApp();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setResult(null);
    setError("");
    if (!open || !backend) return;
    const abort = new AbortController();
    backend
      .request<{ id: string; checkpoint?: unknown }>(`/v1/jobs/${id}`, {
        signal: abort.signal,
      })
      .then(({ data }) => {
        if (abort.signal.aborted) return;
        if (data.id !== id)
          throw new Error("The job response did not match the selected task.");
        setResult(
          (
            sourceReadingSummary(data.checkpoint) +
            modelRoutingSummary(data.checkpoint)
          ).trim() || "No additional source or routing details recorded.",
        );
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Job details could not be loaded.",
          );
      });
    return () => abort.abort();
  }, [backend, id, open, retry]);
  if (!backend) return null;
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide task details" : "Show task details"}
      </Button>
      {open &&
        (error ? (
          <div role="alert">
            {error}{" "}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry details
            </Button>
          </div>
        ) : (
          <p role="status">{result ?? "Loading task details…"}</p>
        ))}
    </div>
  );
}
