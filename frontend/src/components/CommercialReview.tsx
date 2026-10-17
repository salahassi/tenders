import { useRef, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import { tenderCurrency } from "../lib/tenderCurrency";
import TenderCostInput from "./TenderCostInput";
import "./commercial.css";
type Row = Record<string, any>;
const line = () => ({
  id: crypto.randomUUID(),
  description: "",
  quantity: "",
  rate_id: "",
  period_count: "",
  unit: "",
  included_in_base: true,
  charge_group: "one_time",
  tax_category: "Unconfirmed",
  requirement_ids: [],
  section_ids: [],
  deliverable: "",
  basis: "",
  duration_basis: "",
});
export default function CommercialReview({
  version,
  opportunityId,
  rates,
  estimates,
  deliveries,
  requirements,
  sections,
  onSaved,
}: {
  version: Row;
  opportunityId: string;
  rates: Row[];
  estimates: Row[];
  deliveries: Row[];
  requirements: Row[];
  sections: Row[];
  onSaved: () => Promise<void>;
}) {
  const { backend, runCommand, state, notify } = useApp(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    pending = useRef<{ signature: string; key: string } | null>(null);
  const owner = state.settings.role === "Owner",
    editor = state.settings.role !== "Reviewer";
  const latest = estimates.slice().sort((a, b) => b.ordinal - a.ordinal)[0],
    latestDelivery = deliveries
      .slice()
      .sort((a, b) => b.ordinal - a.ordinal)[0];
  const [estimate, setEstimate] = useState<Row>(
    () =>
      latest?.input || {
        currency: tenderCurrency(state, opportunityId),
        precision: tenderCurrency(state, opportunityId) === "JOD" ? 3 : 2,
        method: "markup",
        percentage: "",
        contingency: "",
        taxes: [],
        fx: [],
        lines: version.commercial_draft?.lines?.length
          ? version.commercial_draft.lines.map((l: Row) => ({
              ...line(),
              ...l,
              id: crypto.randomUUID(),
              quantity: l.quantity ?? "",
              rate_id: l.rate_id ?? "",
              period_count: l.period_count ?? "",
              duration_basis:
                l.charge_group === "recurring" ? "" : "One-time delivery",
            }))
          : [line()],
        payment_basis: "base_gross",
        payment_basis_confirmed: false,
        payments: [{ title: "Acceptance", percent: "100" }],
        validity_date: "",
        commercial_terms: "",
        assumptions_confirmed: false,
      },
  );
  const [delivery, setDelivery] = useState<Row>(
    () =>
      latestDelivery?.input || {
        roles: [],
        tasks: version.commercial_draft?.tasks?.length
          ? version.commercial_draft.tasks.map((t: Row) => ({
              ...t,
              effort_days: t.effort_days ?? "",
              allocation: t.allocation ?? "",
              duration_days: t.duration_days ?? "",
              confirmed: false,
            }))
          : [
              {
                key: "task-1",
                title: "",
                predecessors: [],
                role: "",
                effort_days: "",
                allocation: "",
                duration_days: "",
                basis: "",
                confirmed: false,
              },
            ],
      },
  );
  const patchLine = (index: number, patch: Row) =>
    setEstimate({
      ...estimate,
      lines: estimate.lines.map((l: Row, i: number) =>
        i === index ? { ...l, ...patch } : l,
      ),
    });
  const patchTask = (index: number, patch: Row) =>
    setDelivery({
      ...delivery,
      tasks: delivery.tasks.map((t: Row, i: number) =>
        i === index ? { ...t, ...patch } : t,
      ),
    });
  const categories = [
    ...new Set<string>(
      estimate.lines.map((l: Row) => l.tax_category).filter(Boolean),
    ),
  ];
  const foreign = [
    ...new Set<string>(
      estimate.lines
        .map((l: Row) => rates.find((r) => r.id === l.rate_id)?.currency)
        .filter((c: string | undefined) => c && c !== estimate.currency),
    ),
  ];
  const roles = [
    ...new Set<string>(delivery.tasks.map((t: Row) => t.role).filter(Boolean)),
  ];
  async function save(kind: "estimate" | "delivery") {
    if (!backend) return;
    setBusy(true);
    setError("");
    try {
      const input =
        kind === "estimate"
          ? {
              ...estimate,
              taxes: categories.map(
                (category) =>
                  estimate.taxes.find((t: Row) => t.category === category) || {
                    category,
                    rate: "",
                    confirmed: false,
                  },
              ),
              fx: foreign.map(
                (currency) =>
                  estimate.fx.find((x: Row) => x.currency === currency) || {
                    currency,
                    rate: "",
                    effective_date: "",
                    source: "",
                    confirmed: false,
                  },
              ),
            }
          : {
              ...delivery,
              roles: roles.map(
                (role) =>
                  delivery.roles.find((r: Row) => r.role === role) || {
                    role,
                    available_fte: "",
                    confirmed: false,
                    basis: "",
                  },
              ),
            };
      const body = {
          proposal_version_id: version.id,
          expected_revision: version.revision,
          input,
        },
        signature = kind + JSON.stringify(body);
      if (pending.current?.signature !== signature)
        pending.current = { signature, key: crypto.randomUUID() };
      await backend.request(
        kind === "estimate" ? "/v1/estimates" : "/v1/deliveries",
        { method: "POST", body, idempotencyKey: pending.current.key },
      );
      await onSaved();
      pending.current = null;
      notify("A new calculated version is saved. Owner approval is separate.");
    } catch (e) {
      const issues =
        e && typeof e === "object" && "details" in e
          ? (e.details as { issues?: string[] })?.issues
          : null;
      setError(
        issues?.join("\n") ||
          (e instanceof Error ? e.message : "Calculation failed."),
      );
    } finally {
      setBusy(false);
    }
  }
  async function approve(kind: string, row: Row) {
    setBusy(true);
    setError("");
    try {
      await runCommand!(kind + ".approve", {
        id: row.id,
        expected_revision: row.revision,
      });
      await onSaved();
      notify("This exact calculation version is approved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }
  const taxPatch = (category: string, patch: Row) =>
    setEstimate({
      ...estimate,
      taxes: [
        ...estimate.taxes.filter((t: Row) => t.category !== category),
        {
          category,
          rate: "",
          confirmed: false,
          ...estimate.taxes.find((t: Row) => t.category === category),
          ...patch,
        },
      ],
    });
  const fxPatch = (currency: string, patch: Row) =>
    setEstimate({
      ...estimate,
      fx: [
        ...estimate.fx.filter((x: Row) => x.currency !== currency),
        {
          currency,
          rate: "",
          effective_date: "",
          source: "",
          confirmed: false,
          ...estimate.fx.find((x: Row) => x.currency === currency),
          ...patch,
        },
      ],
    });
  const rolePatch = (role: string, patch: Row) =>
    setDelivery({
      ...delivery,
      roles: [
        ...delivery.roles.filter((r: Row) => r.role !== role),
        {
          role,
          available_fte: "",
          confirmed: false,
          basis: "",
          ...delivery.roles.find((r: Row) => r.role === role),
          ...patch,
        },
      ],
    });
  return (
    <section className="panel commercial-panel">
      <h2>Commercial and delivery review</h2>
      <p>
        Review the proposed quantities and workload against the RFP. Only
        approved catalog rates can be calculated. Missing costs, tax decisions,
        periods or availability remain blockers.
      </p>
      {error && (
        <p
          role="alert"
          className="admin-error"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {error}
        </p>
      )}
      <details open>
        <summary>Financial estimate</summary>
        <fieldset disabled={!editor || busy}>
          <div className="form-grid">
            <Field label="Offer currency">
              <input
                value={estimate.currency}
                maxLength={3}
                onChange={(e) =>
                  setEstimate({
                    ...estimate,
                    currency: e.target.value.toUpperCase(),
                  })
                }
              />
            </Field>
            <Field label="Displayed decimal places">
              <input
                type="number"
                min={0}
                max={6}
                value={estimate.precision}
                onChange={(e) =>
                  setEstimate({
                    ...estimate,
                    precision: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Commercial method">
              <select
                value={estimate.method}
                onChange={(e) =>
                  setEstimate({ ...estimate, method: e.target.value })
                }
              >
                <option value="markup">Markup on cost</option>
                <option value="margin">Margin on selling price</option>
              </select>
            </Field>
            <Field
              label={
                estimate.method === "markup"
                  ? "Markup %"
                  : "Margin % (below 100)"
              }
            >
              <input
                inputMode="decimal"
                value={estimate.percentage}
                onChange={(e) =>
                  setEstimate({ ...estimate, percentage: e.target.value })
                }
              />
            </Field>
            <Field label="Contingency %">
              <input
                inputMode="decimal"
                value={estimate.contingency}
                onChange={(e) =>
                  setEstimate({ ...estimate, contingency: e.target.value })
                }
              />
            </Field>
            <Field label="Offer valid through">
              <input
                type="date"
                value={estimate.validity_date}
                onChange={(e) =>
                  setEstimate({ ...estimate, validity_date: e.target.value })
                }
              />
            </Field>
          </div>
          {estimate.lines.map((l: Row, index: number) => (
            <details
              className="commercial-card"
              key={l.id}
              open={estimate.lines.length < 4}
            >
              <summary>
                {index + 1}. {l.description || "Unspecified pricing line"}
              </summary>
              <div className="form-grid">
                <Field label="Description">
                  <input
                    value={l.description}
                    onChange={(e) =>
                      patchLine(index, { description: e.target.value })
                    }
                  />
                </Field>
                <Field label="Approved rate">
                  <select
                    value={l.rate_id}
                    onChange={(e) => {
                      const rate = rates.find((r) => r.id === e.target.value);
                      patchLine(index, {
                        rate_id: e.target.value,
                        unit: rate?.unit || "",
                      });
                    }}
                  >
                    <option value="">Select an approved rate</option>
                    {rates
                      .filter((r) => r.approved)
                      .map((r) => (
                        <option value={r.id} key={r.id}>
                          {r.title} · {r.currency} {r.unit_cost} / {r.unit}
                        </option>
                      ))}
                  </select>
                </Field>
                {owner && runCommand && (
                  <TenderCostInput
                    description={l.description}
                    currency={estimate.currency}
                    opportunityId={opportunityId}
                    onSaved={async (rate) => {
                      patchLine(index, { rate_id: rate.id, unit: rate.unit });
                      await onSaved();
                    }}
                  />
                )}
                <Field label={`Quantity (${l.unit || "unit not selected"})`}>
                  <input
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) =>
                      patchLine(index, { quantity: e.target.value })
                    }
                  />
                </Field>
                <Field label="Charge group">
                  <select
                    value={l.charge_group}
                    onChange={(e) =>
                      patchLine(index, { charge_group: e.target.value })
                    }
                  >
                    <option value="one_time">One-time</option>
                    <option value="recurring">Recurring</option>
                    <option value="optional">Optional</option>
                  </select>
                </Field>
                <Field label="Confirmed period count">
                  <input
                    inputMode="decimal"
                    value={l.period_count}
                    onChange={(e) =>
                      patchLine(index, { period_count: e.target.value })
                    }
                  />
                </Field>
                <Field label="Duration / period basis">
                  <input
                    value={l.duration_basis}
                    onChange={(e) =>
                      patchLine(index, { duration_basis: e.target.value })
                    }
                  />
                </Field>
                <Field label="Tax category">
                  <input
                    value={l.tax_category}
                    onChange={(e) =>
                      patchLine(index, { tax_category: e.target.value })
                    }
                  />
                </Field>
                <Field label="Deliverable">
                  <input
                    value={l.deliverable}
                    onChange={(e) =>
                      patchLine(index, { deliverable: e.target.value })
                    }
                  />
                </Field>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={l.included_in_base}
                  onChange={(e) =>
                    patchLine(index, { included_in_base: e.target.checked })
                  }
                />{" "}
                Include in the base contract total
              </label>
              <Field label="Estimate basis and dependencies">
                <textarea
                  value={l.basis}
                  onChange={(e) => patchLine(index, { basis: e.target.value })}
                />
              </Field>
              <div className="form-grid">
                <Field label="Linked requirements (select all that apply)">
                  <select
                    multiple
                    value={l.requirement_ids}
                    onChange={(e) =>
                      patchLine(index, {
                        requirement_ids: Array.from(
                          e.target.selectedOptions,
                          (x) => x.value,
                        ),
                      })
                    }
                  >
                    {requirements.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.text}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Linked proposal sections">
                  <select
                    multiple
                    value={l.section_ids}
                    onChange={(e) =>
                      patchLine(index, {
                        section_ids: Array.from(
                          e.target.selectedOptions,
                          (x) => x.value,
                        ),
                      })
                    }
                  >
                    {sections.map((s) => (
                      <option key={s.id} value={s.section_key}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button
                onClick={() =>
                  setEstimate({
                    ...estimate,
                    lines: estimate.lines.filter(
                      (_: Row, i: number) => i !== index,
                    ),
                  })
                }
              >
                Remove line
              </Button>
            </details>
          ))}
          <Button
            onClick={() =>
              setEstimate({ ...estimate, lines: [...estimate.lines, line()] })
            }
          >
            Add pricing line
          </Button>
          <h3>Tax decisions</h3>
          {categories.map((category) => {
            const tax = estimate.taxes.find(
              (t: Row) => t.category === category,
            );
            return (
              <div className="commercial-card" key={category}>
                <Field
                  label={`${category} · tax rate % (enter 0 only if confirmed)`}
                >
                  <input
                    inputMode="decimal"
                    value={tax?.rate || ""}
                    onChange={(e) =>
                      taxPatch(category, { rate: e.target.value })
                    }
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={tax?.confirmed || false}
                    onChange={(e) =>
                      taxPatch(category, { confirmed: e.target.checked })
                    }
                  />{" "}
                  Tax treatment for this category has been verified.
                </label>
              </div>
            );
          })}
          {foreign.length > 0 && (
            <h3>Exchange rates into {estimate.currency}</h3>
          )}
          {foreign.map((currency) => {
            const fx = estimate.fx.find((x: Row) => x.currency === currency);
            return (
              <div className="commercial-card" key={currency}>
                <div className="form-grid">
                  <Field
                    label={`One ${currency} equals how many ${estimate.currency}?`}
                  >
                    <input
                      inputMode="decimal"
                      value={fx?.rate || ""}
                      onChange={(e) =>
                        fxPatch(currency, { rate: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Effective date">
                    <input
                      type="date"
                      value={fx?.effective_date || ""}
                      onChange={(e) =>
                        fxPatch(currency, { effective_date: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Exchange rate source">
                    <input
                      value={fx?.source || ""}
                      onChange={(e) =>
                        fxPatch(currency, { source: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={fx?.confirmed || false}
                    onChange={(e) =>
                      fxPatch(currency, { confirmed: e.target.checked })
                    }
                  />{" "}
                  This dated exchange rate is confirmed.
                </label>
              </div>
            );
          })}
          <h3>Payment schedule</h3>
          <Field label="Payment percentage basis">
            <select
              value={estimate.payment_basis}
              onChange={(e) =>
                setEstimate({
                  ...estimate,
                  payment_basis: e.target.value,
                  payment_basis_confirmed: false,
                })
              }
            >
              <option value="base_net">Base net price</option>
              <option value="base_gross">
                Base gross price, including tax
              </option>
            </select>
          </Field>
          {estimate.payments.map((p: Row, i: number) => (
            <div className="form-grid" key={i}>
              <Field label={`Milestone ${i + 1}`}>
                <input
                  value={p.title}
                  onChange={(e) =>
                    setEstimate({
                      ...estimate,
                      payments: estimate.payments.map((x: Row, n: number) =>
                        n === i ? { ...x, title: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="Percentage">
                <input
                  inputMode="decimal"
                  value={p.percent}
                  onChange={(e) =>
                    setEstimate({
                      ...estimate,
                      payments: estimate.payments.map((x: Row, n: number) =>
                        n === i ? { ...x, percent: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Button
                onClick={() =>
                  setEstimate({
                    ...estimate,
                    payments: estimate.payments.filter(
                      (_: Row, n: number) => n !== i,
                    ),
                  })
                }
              >
                Remove milestone
              </Button>
            </div>
          ))}
          <Button
            onClick={() =>
              setEstimate({
                ...estimate,
                payments: [...estimate.payments, { title: "", percent: "" }],
              })
            }
          >
            Add milestone
          </Button>
          <label>
            <input
              type="checkbox"
              checked={estimate.payment_basis_confirmed}
              onChange={(e) =>
                setEstimate({
                  ...estimate,
                  payment_basis_confirmed: e.target.checked,
                })
              }
            />{" "}
            I confirm this basis; separately priced options are excluded.
          </label>
          <Field label="Commercial terms, inclusions, exclusions and durations">
            <textarea
              value={estimate.commercial_terms}
              onChange={(e) =>
                setEstimate({ ...estimate, commercial_terms: e.target.value })
              }
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={estimate.assumptions_confirmed}
              onChange={(e) =>
                setEstimate({
                  ...estimate,
                  assumptions_confirmed: e.target.checked,
                })
              }
            />{" "}
            I checked the scope, quantities, periods and commercial assumptions
            against the proposal and required terms.
          </label>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => save("estimate")}
          >
            Calculate and save a new estimate version
          </Button>
        </fieldset>
        {latest && (
          <div className="commercial-result">
            <h3>
              Saved estimate v{latest.ordinal} · {latest.status}
            </h3>
            {latest.calculated ? (
              <>
                <dl>
                  <dt>Direct cost</dt>
                  <dd>{latest.calculated.direct_cost}</dd>
                  <dt>Net price</dt>
                  <dd>{latest.calculated.net_price}</dd>
                  <dt>Tax</dt>
                  <dd>{latest.calculated.tax}</dd>
                  <dt>Total {latest.currency}</dt>
                  <dd>{latest.calculated.display_gross}</dd>
                  <dt>Unselected options</dt>
                  <dd>{latest.calculated.optional_gross}</dd>
                  <dt>Rounding adjustment</dt>
                  <dd>{latest.calculated.rounding_adjustment}</dd>
                </dl>
                <ul>
                  {latest.calculated.payments.map((p: Row, i: number) => (
                    <li key={i}>
                      {p.title}: {p.percent}% · {p.amount} {latest.currency}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>This version has not passed calculation.</p>
            )}
            {owner && latest.status === "ready" && (
              <Button
                disabled={busy}
                onClick={() => approve("estimate", latest)}
              >
                Approve this exact estimate
              </Button>
            )}
          </div>
        )}
      </details>
      <details>
        <summary>Delivery effort, dependencies and availability</summary>
        <fieldset disabled={!editor || busy}>
          {delivery.tasks.map((t: Row, index: number) => (
            <div className="commercial-card" key={index}>
              <div className="form-grid">
                {(
                  [
                    "key",
                    "title",
                    "role",
                    "effort_days",
                    "allocation",
                    "duration_days",
                    "basis",
                  ] as const
                ).map((k) => (
                  <Field
                    key={k}
                    label={
                      {
                        key: "Task key",
                        title: "Task title",
                        role: "Assigned role",
                        effort_days: "Effort in person-days",
                        allocation: "Allocated full-time equivalents",
                        duration_days: "Duration in working days",
                        basis: "Basis and dependencies",
                      }[k]
                    }
                  >
                    <input
                      value={t[k]}
                      onChange={(e) =>
                        patchTask(index, { [k]: e.target.value })
                      }
                    />
                  </Field>
                ))}
                <Field label="Predecessor task keys, separated by commas">
                  <input
                    value={t.predecessors.join(", ")}
                    onChange={(e) =>
                      patchTask(index, {
                        predecessors: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={t.confirmed}
                  onChange={(e) =>
                    patchTask(index, { confirmed: e.target.checked })
                  }
                />{" "}
                Task effort, allocation and duration have been reviewed.
              </label>
              <Button
                onClick={() =>
                  setDelivery({
                    ...delivery,
                    tasks: delivery.tasks.filter(
                      (_: Row, i: number) => i !== index,
                    ),
                  })
                }
              >
                Remove task
              </Button>
            </div>
          ))}
          <Button
            onClick={() =>
              setDelivery({
                ...delivery,
                tasks: [
                  ...delivery.tasks,
                  {
                    key: `task-${delivery.tasks.length + 1}`,
                    title: "",
                    predecessors: [],
                    role: "",
                    effort_days: "",
                    allocation: "",
                    duration_days: "",
                    basis: "",
                    confirmed: false,
                  },
                ],
              })
            }
          >
            Add delivery task
          </Button>
          {roles.map((role) => {
            const r = delivery.roles.find((r: Row) => r.role === role);
            return (
              <div className="commercial-card" key={role}>
                <h4>{role}</h4>
                <Field label="Available full-time equivalents">
                  <input
                    value={r?.available_fte || ""}
                    onChange={(e) =>
                      rolePatch(role, { available_fte: e.target.value })
                    }
                  />
                </Field>
                <Field label="Availability evidence and assumptions">
                  <input
                    value={r?.basis || ""}
                    onChange={(e) => rolePatch(role, { basis: e.target.value })}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={r?.confirmed || false}
                    onChange={(e) =>
                      rolePatch(role, { confirmed: e.target.checked })
                    }
                  />{" "}
                  Availability is confirmed for the proposed work.
                </label>
              </div>
            );
          })}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => save("delivery")}
          >
            Validate and save a new delivery version
          </Button>
        </fieldset>
        {latestDelivery && (
          <div className="commercial-result">
            <h3>
              Saved delivery v{latestDelivery.ordinal} · {latestDelivery.status}
            </h3>
            {latestDelivery.calculated && (
              <p>
                {latestDelivery.calculated.effort_person_days} person-days of
                effort · {latestDelivery.calculated.duration_workdays} working
                days along the dependency path. Calendar dates require a
                confirmed working calendar.
              </p>
            )}
            {owner && latestDelivery.status === "ready" && (
              <Button
                disabled={busy}
                onClick={() => approve("delivery", latestDelivery)}
              >
                Approve this exact delivery plan
              </Button>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
