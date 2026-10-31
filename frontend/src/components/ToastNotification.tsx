import { Check, CircleAlert, X } from "lucide-react";
import type { ToastSeverity } from "../lib/appContext";

export default function ToastNotification({
  message,
  severity = "success",
  onDismiss,
}: {
  message: string;
  severity?: ToastSeverity;
  onDismiss: () => void;
}) {
  const error = severity === "error";
  return (
    <div
      className={`toast${error ? " toast-error" : ""}`}
      role={error ? "alert" : "status"}
      aria-atomic="true"
    >
      {error ? (
        <CircleAlert size={18} role="img" aria-label="Error" />
      ) : (
        <Check size={18} role="img" aria-label="Success" />
      )}
      <span>{message}</span>
      <button aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
