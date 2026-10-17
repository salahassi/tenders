import { useRef, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";

/** Tender-specific dated cost evidence uses the existing audited rate workflow. */
export default function TenderCostInput({
  description,
  currency,
  opportunityId,
  onSaved,
}: {
  description: string;
  currency: string;
  opportunityId: string;
  onSaved: (rate: Record<string, any>) => Promise<void>;
}) {
  const { runCommand, state } = useApp();
  const [open, setOpen] = useState(false),
    [cost, setCost] = useState(""),
    [unit, setUnit] = useState(""),
    [basis, setBasis] = useState(""),
    [until, setUntil] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{
    signature: string;
    saveKey: string;
    approveKey: string;
    record?: Record<string, any>;
  } | null>(null);
  if (!runCommand || state.settings.role !== "Owner") return null;
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (
        !description.trim() ||
        !/^[A-Z]{3}$/.test(currency) ||
        !unit.trim() ||
        !basis.trim() ||
        !confirmed
      )
        throw Error(
          "Provide the scope, currency, unit and cost basis, then confirm this tender cost.",
        );
      const input = {
        expected_revision: 0,
        title: `${description} [${opportunityId.slice(0, 8)}]`.slice(0, 200),
        unit,
        currency,
        unit_cost: cost,
        zero_confirmed: cost.trim() !== "" && Number(cost) === 0,
        valid_from: new Date().toISOString().slice(0, 10),
        valid_until: until,
        source_reference: `Tender ${opportunityId}: ${basis}`,
        public_approved: true,
      };
      const signature = JSON.stringify(input);
      if (pending.current?.signature !== signature)
        pending.current = {
          signature,
          saveKey: crypto.randomUUID(),
          approveKey: crypto.randomUUID(),
        };
      const attempt = pending.current;
      const record =
        attempt.record ||
        (await runCommand!("rate.save", input, attempt.saveKey));
      attempt.record = record;
      await runCommand!(
        "rate.approve",
        { id: record.id, expected_revision: record.revision },
        attempt.approveKey,
      );
      await onSaved({ ...record, approved: true });
      pending.current = null;
      setOpen(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The tender cost could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <Button variant="secondary" onClick={() => setOpen(!open)}>
        Set cost for this tender
      </Button>
      {open && (
        <div className="stack">
          <p className="muted small">
            Price this scope from its effort, supplier quotation or documented
            estimate. No fixed company price list is required.
          </p>
          <Field label={`Unit cost (${currency || "choose offer currency"})`}>
            <input
              value={cost}
              inputMode="decimal"
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
          <Field label="Cost unit">
            <input
              value={unit}
              placeholder="day, device, licence, project"
              onChange={(e) => setUnit(e.target.value)}
            />
          </Field>
          <Field label="Cost basis / quotation reference">
            <textarea
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
            />
          </Field>
          <Field label="Cost valid through">
            <input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I approve this tender cost, including zero if entered, and confirm
            the basis is eligible for this workspace.
          </label>
          {error && <p role="alert">{error}</p>}
          <Button disabled={busy || !confirmed} onClick={() => void save()}>
            Save and approve tender cost
          </Button>
        </div>
      )}
    </div>
  );
}
