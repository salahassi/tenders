import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Inbox, X } from "lucide-react";
export function Button({
  variant = "secondary",
  size,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm";
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "green" | "amber" | "red" | "blue" | "purple" | "neutral";
}) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Inbox size={27} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" aria-describedby={undefined}>
          <div className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="Close dialog">
                <X size={19} />
              </Button>
            </Dialog.Close>
          </div>
          <div className="modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Tabs({
  items,
  active,
  onChange,
}: {
  items: { id: string; label: string; count?: number; tone?: "purple" }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" aria-label="View options">
      {items.map((i) => (
        <button
          type="button"
          key={i.id}
          className={[
            active === i.id ? "active" : "",
            i.tone ? `tab-${i.tone}` : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={active === i.id}
          onClick={() => onChange(i.id)}
        >
          {i.label}
          {i.count !== undefined && <span>{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        {icon}
      </div>
      <div className="metric-value">{value}</div>
      {detail && <div className="metric-detail">{detail}</div>}
    </div>
  );
}
export function Score({
  value,
  coverage,
}: {
  value: number | null;
  coverage?: number;
}) {
  return (
    <div className="score-cell">
      <div
        className={`score-value ${value !== null && value >= 80 ? "high" : value !== null && value < 60 ? "low" : ""}`}
      >
        {value ?? "—"}
        {value !== null && <span>/100</span>}
      </div>
      {coverage !== undefined && <small>{coverage}% evidence</small>}
    </div>
  );
}
export const statusLabel = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function StatusBadge({ status }: { status: string }) {
  const tone = [
    "approved",
    "completed",
    "shortlisted",
    "healthy",
    "ready",
    "submitted",
    "addressed",
  ].includes(status)
    ? "green"
    : ["in_progress", "in_review", "running", "new"].includes(status)
      ? "blue"
      : ["failed", "declined", "rejected", "error"].includes(status)
        ? "red"
        : ["deferred", "blocked", "proposed", "requested", "queued"].includes(
              status,
            )
          ? "amber"
          : "neutral";
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
}
