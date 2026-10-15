import { useEffect, useRef, useState } from "react";
import { Modal, Button } from "./ui";
import {
  registerOriginalReviewer,
  type OriginalReview,
} from "../lib/contentEligibility";
export default function OriginalEligibility() {
  const [request, setRequest] = useState<OriginalReview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    pending = useRef<((value: boolean) => void) | null>(null);
  function finish(value: boolean) {
    pending.current?.(value);
    pending.current = null;
    setRequest(null);
    setConfirmed(false);
  }
  useEffect(() => {
    const remove = registerOriginalReviewer(
      (r) =>
        new Promise((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setConfirmed(false);
          setRequest(r);
        }),
    );
    return () => {
      pending.current?.(false);
      remove();
    };
  }, []);
  return (
    <Modal
      open={!!request}
      onClose={() => finish(false)}
      title="Review the original before upload"
    >
      {request && (
        <>
          <p>
            <strong>{request.document.name}</strong> ·{" "}
            {Math.ceil(request.document.size / 1024)} KB
          </p>
          <p>
            The shared free trial accepts only nonconfidential, nonpersonal
            business content. This review covers the entire original and its
            metadata. No original bytes have been uploaded. Automated checks can
            miss names, signatures and hidden metadata. If these are present,
            cancel and sanitize a separate copy locally before attaching it.
          </p>
          <Button
            onClick={() => {
              const url = URL.createObjectURL(request.original);
              const a = document.createElement("a");
              a.href = url;
              a.download = request.document.name;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Inspect local original
          </Button>
          <details>
            <summary>Extracted text preview</summary>
            <pre className="commercial-evidence" dir="auto">
              {request.document.text ||
                "No readable text extracted. Review the original directly."}
            </pre>
          </details>
          <label className="commercial-card">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I reviewed this exact original, including metadata, and confirm it
            contains no personal, confidential or secret information and may be
            shared in this trial.
          </label>
          <div className="modal-actions">
            <Button onClick={() => finish(false)}>Cancel upload</Button>
            <Button
              variant="primary"
              disabled={!confirmed}
              onClick={() => finish(true)}
            >
              Confirm and upload
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
