import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import "./commercial.css";
type Rate = Record<string, any>;
const blank = {
  title: "",
  unit: "",
  currency: "SAR",
  unit_cost: "",
  valid_from: "",
  valid_until: "",
  source_reference: "",
  zero_confirmed: false,
  public_approved: false,
};
export default function RateCatalog() {
  const { backend, runCommand, state, saving, notify } = useApp(),
    [rates, setRates] = useState<Rate[]>([]),
    [form, setForm] = useState(blank),
    [editing, setEditing] = useState<Rate | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend) return;
    try {
      setRates(await backend.list<Rate>("rates"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load rates.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [backend]);
  async function command(operation: string, input: Record<string, unknown>) {
    try {
      setError("");
      await runCommand!(operation, input);
      await load();
      notify(
        "Rate catalog saved. Changes invalidate prior proposal approvals.",
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rate could not be saved.");
      return false;
    }
  }
  if (!backend) return null;
  return (
    <section className="panel admin-section">
      <h2>Approved rate catalog</h2>
      <p>
        Use only rates suitable for this shared trial workspace. Rates are
        dated, versioned and require Owner approval. A blank cost is unknown;
        zero requires explicit confirmation.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading rates…</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Unit cost</th>
                <th>Validity</th>
                <th>Approval</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.title}
                    <br />
                    <small>{r.source_reference}</small>
                  </td>
                  <td dir="ltr">
                    {r.currency} {r.unit_cost} / {r.unit}
                  </td>
                  <td>
                    {r.valid_from} – {r.valid_until}
                  </td>
                  <td>{r.approved ? "Owner approved" : "Needs approval"}</td>
                  <td>
                    <Button
                      disabled={!owner || saving}
                      onClick={() => {
                        setEditing(r);
                        setForm(
                          Object.fromEntries(
                            Object.keys(blank).map((k) => [k, r[k]]),
                          ) as typeof blank,
                        );
                      }}
                    >
                      Edit
                    </Button>
                    {!r.approved && (
                      <Button
                        disabled={!owner || saving || !r.public_approved}
                        onClick={() =>
                          command("rate.approve", {
                            id: r.id,
                            expected_revision: r.revision,
                          })
                        }
                      >
                        Approve rate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rates.length && <p>No rates recorded.</p>}
        </div>
      )}
      {owner && (
        <details>
          <summary>{editing ? "Edit rate" : "Add a rate"}</summary>
          <div className="form-grid">
            {(
              [
                "title",
                "unit",
                "currency",
                "unit_cost",
                "valid_from",
                "valid_until",
                "source_reference",
              ] as const
            ).map((k) => (
              <Field
                key={k}
                label={
                  {
                    title: "Item / role",
                    unit: "Pricing unit",
                    currency: "Currency code",
                    unit_cost: "Unit cost",
                    valid_from: "Valid from",
                    valid_until: "Valid through",
                    source_reference: "Source and evidence reference",
                  }[k]
                }
              >
                <input
                  type={k.startsWith("valid_") ? "date" : "text"}
                  inputMode={k === "unit_cost" ? "decimal" : undefined}
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={form.zero_confirmed}
              onChange={(e) =>
                setForm({ ...form, zero_confirmed: e.target.checked })
              }
            />{" "}
            If the cost is zero, I have verified that it is genuinely free.
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.public_approved}
              onChange={(e) =>
                setForm({ ...form, public_approved: e.target.checked })
              }
            />{" "}
            This rate and its source contain no personal or confidential
            information and are suitable for the shared trial.
          </label>
          <Button
            disabled={saving}
            onClick={async () => {
              if (
                await command("rate.save", {
                  ...form,
                  ...(editing ? { id: editing.id } : {}),
                  expected_revision: editing?.revision || 0,
                })
              ) {
                setEditing(null);
                setForm(blank);
              }
            }}
          >
            Save for approval
          </Button>
          {editing && (
            <Button
              onClick={() => {
                setEditing(null);
                setForm(blank);
              }}
            >
              Cancel edit
            </Button>
          )}
        </details>
      )}
    </section>
  );
}
