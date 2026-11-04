import { useLayoutEffect, useRef, useState } from "react";
import type { BackendClient } from "../lib/backendClient";
import { Button, Field } from "./ui";

type Fact = {
  key: string;
  kind: "quantity" | "money" | "date" | "decision";
  value: string | null;
  unit: string | null;
  currency: string | null;
  quote: string;
  decision_id?: string;
};
type Fulfillment = {
  requirement_id: string;
  response_section_key: string;
  response_excerpt: string;
  method: string;
  deliverable: string;
  acceptance_evidence: string;
  conditions_preserved: string[];
  exceptions_preserved: string[];
  consequences_preserved: string[];
  facts: Fact[];
  qualifier_equivalences?: {
    kind: "conditions" | "exceptions" | "consequences";
    source_index: number;
    source_quote: string;
    source_hash: string;
    response_quote: string;
  }[];
};
type Row = Record<string, any>;
const sectionText = (s: Row) =>
  s.content_blocks
    .map((b: Row) =>
      b.type === "table"
        ? [b.headers, ...b.rows].map((r: string[]) => r.join(" | ")).join("\n")
        : b.text || "",
    )
    .join("\n");
const blank = (id: string): Fulfillment => ({
  requirement_id: id,
  response_section_key: "",
  response_excerpt: "",
  method: "",
  deliverable: "",
  acceptance_evidence: "",
  conditions_preserved: [],
  exceptions_preserved: [],
  consequences_preserved: [],
  facts: [],
});
export default function ProposalConsistencyReview({
  client,
  versionId,
  onSaved,
}: {
  client: BackendClient;
  versionId: string;
  onSaved: () => Promise<void>;
}) {
  const [data, setData] = useState<Row | null>(null),
    [forms, setForms] = useState<Record<string, Fulfillment>>({}),
    [reviewed, setReviewed] = useState<string[]>([]),
    [decisions, setDecisions] = useState<string[]>([]),
    [sectionFacts, setSectionFacts] = useState<Record<string, Fact[]>>({}),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0);
  const scope = useRef<AbortController | null>(null),
    receipt = useRef<{ body: string; key: string } | null>(null);
  useLayoutEffect(() => {
    const c = new AbortController();
    scope.current = c;
    setData(null);
    setError("");
    setBusy(false);
    receipt.current = null;
    void client
      .request<Row>(`/v1/proposal-versions/${versionId}/consistency`, {
        signal: c.signal,
      })
      .then(({ data: d }) => {
        if (c.signal.aborted) return;
        if (d.version_id !== versionId)
          throw new Error(
            "The review does not belong to this proposal version.",
          );
        setData(d);
        setForms(
          Object.fromEntries(
            d.input.requirements.map((r: Row) => [
              r.id,
              d.review?.fulfillment?.find(
                (f: Fulfillment) => f.requirement_id === r.id,
              ) || blank(r.id),
            ]),
          ),
        );
        setSectionFacts(
          Object.fromEntries(
            (d.review?.section_facts || []).map((f: Row) => [
              f.section_key,
              f.facts,
            ]),
          ),
        );
        setReviewed([]);
        setDecisions([]);
        setReason("");
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : "Unable to load the response review.",
          );
      });
    return () => {
      c.abort();
      if (scope.current === c) scope.current = null;
    };
  }, [client, versionId, epoch]);
  const setForm = (id: string, change: Partial<Fulfillment>) =>
    setForms((all) => ({ ...all, [id]: { ...all[id], ...change } }));
  async function save() {
    const c = scope.current;
    if (!data || !c || c.signal.aborted) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        expected_revision: data.version_revision,
        binding_hash: data.binding_hash,
        reason,
        reviewed_requirement_ids: reviewed,
        confirmed_decision_ids: decisions,
        fulfillment: await Promise.all(
          Object.values(forms)
            .filter((f) => f.response_section_key && f.response_excerpt)
            .map(async (f) => ({
              ...f,
              qualifier_equivalences: await Promise.all(
                (f.qualifier_equivalences || [])
                  .filter((q) => q.response_quote.trim())
                  .map(async (q) => ({
                    ...q,
                    source_hash: [
                      ...new Uint8Array(
                        await crypto.subtle.digest(
                          "SHA-256",
                          new TextEncoder().encode(q.source_quote),
                        ),
                      ),
                    ]
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join(""),
                  })),
              ),
            })),
        ),
        section_facts: Object.entries(sectionFacts)
          .filter(([, facts]) => facts.length)
          .map(([section_key, facts]) => ({ section_key, facts })),
      };
      const serialized = JSON.stringify(body);
      if (receipt.current?.body !== serialized)
        receipt.current = { body: serialized, key: crypto.randomUUID() };
      if (c.signal.aborted) return;
      const result = await client.request<Row>(
        `/v1/proposal-versions/${versionId}/consistency`,
        {
          method: "POST",
          body,
          idempotencyKey: receipt.current.key,
          signal: c.signal,
        },
      );
      if (c.signal.aborted) return;
      setData((d) =>
        d
          ? {
              ...d,
              version_revision: result.data.version_revision,
              report: result.data.report,
            }
          : d,
      );
      receipt.current = null;
      await onSaved();
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : "The response review was not saved.",
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="panel commercial-panel">
      <h2>Substantive response and consistency review</h2>
      <p>
        Check what the proposal actually commits to deliver. Quote the response
        that explains the method, deliverable and acceptance evidence for each
        buyer requirement. Missing information keeps the proposal in draft; its
        saved files remain available.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      <Button disabled={busy} onClick={() => setEpoch((x) => x + 1)}>
        Reload current response review
      </Button>
      {!data ? (
        <p>Loading the current proposal and source review…</p>
      ) : (
        <>
          {data.report && (
            <div role="status">
              <strong>
                {data.report.substantive_complete
                  ? "Response review passed for this saved content. Final approval checks still apply."
                  : "Response review has unresolved gaps."}
              </strong>
              <ul>
                {data.report.coverage
                  ?.filter((c: Row) => c.status !== "answered")
                  .map((c: Row) => (
                    <li key={c.requirement_id}>
                      {
                        data.input.requirements.find(
                          (r: Row) => r.id === c.requirement_id,
                        )?.text
                      }
                      :{" "}
                      {c.missing_fields
                        .map((x: string) => x.replaceAll("_", " "))
                        .join(", ")}
                    </li>
                  ))}
                {data.report.diagnostics
                  ?.filter(
                    (d: Row) => d.code !== "REQUIREMENT_RESPONSE_INCOMPLETE",
                  )
                  .map((d: Row) => (
                    <li key={d.id}>{d.detail}</li>
                  ))}
              </ul>
            </div>
          )}
          {!data.input.input_complete && (
            <p role="alert">
              Some source material remains unread. Complete its reading and
              refresh the proposal before final approval.
            </p>
          )}
          {data.input.requirements.map((r: Row) => {
            const f = forms[r.id] || blank(r.id),
              sem = r.source_semantics || {};
            return (
              <details className="commercial-card" key={r.id}>
                <summary dir="auto">{r.text}</summary>
                <p>
                  {sem.review_status === "confirmed" &&
                  sem.authority_status === "confirmed"
                    ? "Buyer meaning has a current source review."
                    : "The source meaning or buyer authority still needs review on the opportunity before a refreshed proposal can be approved."}
                </p>
                {(r.source_refs || []).map((ref: Row) => (
                  <blockquote dir="auto" key={ref.id}>
                    {ref.quote}
                  </blockquote>
                ))}
                <Field label="Section containing the primary response">
                  <select
                    value={f.response_section_key}
                    onChange={(e) =>
                      setForm(r.id, {
                        response_section_key: e.target.value,
                        response_excerpt: sectionText(
                          data.input.sections.find(
                            (s: Row) => s.key === e.target.value,
                          ) || { content_blocks: [] },
                        ),
                      })
                    }
                  >
                    <option value="">Select a section</option>
                    {data.input.sections
                      .filter((s: Row) => s.requirement_ids?.includes(r.id))
                      .map((s: Row) => (
                        <option key={s.key} value={s.key}>
                          {s.title || s.key}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Exact response excerpt">
                  <textarea
                    dir="auto"
                    value={f.response_excerpt}
                    onChange={(e) =>
                      setForm(r.id, { response_excerpt: e.target.value })
                    }
                  />
                </Field>
                {(
                  ["method", "deliverable", "acceptance_evidence"] as const
                ).map((field) => (
                  <Field
                    key={field}
                    label={
                      field === "method"
                        ? "Implementation method from the response"
                        : field === "deliverable"
                          ? "Deliverable from the response"
                          : "Acceptance evidence from the response"
                    }
                  >
                    <textarea
                      dir="auto"
                      value={f[field]}
                      onChange={(e) =>
                        setForm(r.id, { [field]: e.target.value })
                      }
                    />
                  </Field>
                ))}
                {(["conditions", "exceptions", "consequences"] as const).map(
                  (field) => (
                    <div key={field}>
                      {(sem[field] || []).map((q: string, index: number) => (
                        <div key={q}>
                          <label>
                            <input
                              type="checkbox"
                              checked={f[`${field}_preserved`].includes(q)}
                              onChange={(e) =>
                                setForm(r.id, {
                                  [`${field}_preserved`]: e.target.checked
                                    ? [...f[`${field}_preserved`], q]
                                    : f[`${field}_preserved`].filter(
                                        (v) => v !== q,
                                      ),
                                })
                              }
                            />
                            Preserved exact {field.slice(0, -1)}:{" "}
                            <span dir="auto">{q}</span>
                          </label>
                          <Field
                            label={`Equivalent response wording for this ${field.slice(0, -1)} (if translated or paraphrased)`}
                            hint="Supply the exact response wording only after checking it preserves the same meaning. Your scoped review confirms this equivalence."
                          >
                            <textarea
                              dir="auto"
                              value={
                                f.qualifier_equivalences?.find(
                                  (x) =>
                                    x.kind === field &&
                                    x.source_index === index,
                                )?.response_quote || ""
                              }
                              onChange={(e) =>
                                setForm(r.id, {
                                  qualifier_equivalences: [
                                    ...(f.qualifier_equivalences || []).filter(
                                      (x) =>
                                        x.kind !== field ||
                                        x.source_index !== index,
                                    ),
                                    {
                                      kind: field,
                                      source_index: index,
                                      source_quote: q,
                                      source_hash: "",
                                      response_quote: e.target.value,
                                    },
                                  ],
                                })
                              }
                            />
                          </Field>
                        </div>
                      ))}
                    </div>
                  ),
                )}
                <FactEditor
                  facts={f.facts}
                  onChange={(facts) => setForm(r.id, { facts })}
                  decisions={data.shared_decisions}
                  financial={data.financial_truth}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed.includes(r.id)}
                    onChange={(e) =>
                      setReviewed((all) =>
                        e.target.checked
                          ? [...all, r.id]
                          : all.filter((id) => id !== r.id),
                      )
                    }
                  />
                  I reviewed this response against the source, including who
                  must act, obligations, negation, conditions, quantities and
                  dates.
                </label>
              </details>
            );
          })}
          <details>
            <summary>
              Numbers, dates and shared commitments elsewhere in the proposal
            </summary>
            <p>
              Give repeated commitments the same meaning label across sections.
              Unknown values stay unknown. For a calculated price, use the
              matching calculated value below.
            </p>
            {data.financial_truth?.calculated && (
              <ul>
                {["gross_total", "net_price", "tax", "direct_cost"].map(
                  (key) => (
                    <li key={key}>
                      {key.replaceAll("_", " ")}:{" "}
                      {data.financial_truth.calculated[key]}{" "}
                      {data.financial_truth.currency}
                    </li>
                  ),
                )}
              </ul>
            )}
            {data.input.sections.map((s: Row) => (
              <details key={s.key}>
                <summary>{s.title || s.key}</summary>
                <p dir="auto" style={{ whiteSpace: "pre-wrap" }}>
                  {sectionText(s)}
                </p>
                <FactEditor
                  facts={sectionFacts[s.key] || []}
                  onChange={(facts) =>
                    setSectionFacts((all) => ({ ...all, [s.key]: facts }))
                  }
                  decisions={data.shared_decisions}
                  financial={data.financial_truth}
                />
              </details>
            ))}
          </details>
          {data.shared_decisions.length > 0 && (
            <fieldset>
              <legend>Shared design decisions reviewed</legend>
              {data.shared_decisions.map((d: Row) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={decisions.includes(d.id)}
                    onChange={(e) =>
                      setDecisions((all) =>
                        e.target.checked
                          ? [...all, d.id]
                          : all.filter((id) => id !== d.id),
                      )
                    }
                  />
                  <span dir="auto">{d.statement}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Field label="What you checked and why the response is sufficient">
            <textarea
              value={reason}
              dir="auto"
              onChange={(e) => setReason(e.target.value)}
              minLength={30}
            />
          </Field>
          <Button
            disabled={busy || reason.trim().length < 30 || !reviewed.length}
            onClick={() => void save()}
          >
            {busy
              ? "Saving response review…"
              : "Check and save my scoped review"}
          </Button>
        </>
      )}
    </section>
  );
}
function FactEditor({
  facts,
  onChange,
  decisions,
  financial,
}: {
  facts: Fact[];
  onChange: (facts: Fact[]) => void;
  decisions: Row[];
  financial?: Row;
}) {
  const change = (i: number, patch: Partial<Fact>) =>
    onChange(facts.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend>Reviewed quantities, prices, dates and shared commitments</legend>
      {facts.map((f, i) => (
        <div className="commercial-card" key={i}>
          {f.kind === "money" && financial?.calculated && (
            <Field label="Calculated price this quote describes">
              <select
                value={f.key.startsWith("estimate.") ? f.key : ""}
                onChange={(e) => change(i, { key: e.target.value })}
              >
                <option value="">Select the calculated price</option>
                {["gross_total", "net_price", "tax", "direct_cost"].map(
                  (key) => (
                    <option key={key} value={`estimate.${key}`}>
                      {key.replaceAll("_", " ")}: {financial.calculated[key]}{" "}
                      {financial.currency}
                    </option>
                  ),
                )}
              </select>
            </Field>
          )}
          <Field label="Shared meaning label">
            <input
              value={f.key}
              onChange={(e) => change(i, { key: e.target.value })}
            />
          </Field>
          <Field label="Value type">
            <select
              value={f.kind}
              onChange={(e) =>
                change(i, { kind: e.target.value as Fact["kind"] })
              }
            >
              <option value="quantity">Quantity</option>
              <option value="money">Price</option>
              <option value="date">Date (YYYY-MM-DD)</option>
              <option value="decision">Shared decision</option>
            </select>
          </Field>
          <label>
            <input
              type="checkbox"
              checked={f.value === null}
              onChange={(e) =>
                change(i, { value: e.target.checked ? null : "" })
              }
            />
            Value is unknown
          </label>
          {f.value !== null && (
            <Field label="Exact value">
              <input
                value={f.value}
                onChange={(e) => change(i, { value: e.target.value })}
              />
            </Field>
          )}
          <Field label="Unit">
            <input
              value={f.unit || ""}
              onChange={(e) => change(i, { unit: e.target.value || null })}
            />
          </Field>
          {f.kind === "money" && (
            <Field label="Currency">
              <input
                placeholder="SAR"
                value={f.currency || ""}
                onChange={(e) =>
                  change(i, { currency: e.target.value.toUpperCase() || null })
                }
              />
            </Field>
          )}
          <Field label="Exact quotation containing this value">
            <textarea
              dir="auto"
              value={f.quote}
              onChange={(e) => change(i, { quote: e.target.value })}
            />
          </Field>
          {decisions.length > 0 && (
            <Field label="Related shared decision">
              <select
                value={f.decision_id || ""}
                onChange={(e) =>
                  change(i, { decision_id: e.target.value || undefined })
                }
              >
                <option value="">No shared decision</option>
                {decisions.map((d: Row) => (
                  <option value={d.id} key={d.id}>
                    {d.statement}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button onClick={() => onChange(facts.filter((_, n) => n !== i))}>
            Remove value
          </Button>
        </div>
      ))}
      <Button
        onClick={() =>
          onChange([
            ...facts,
            {
              key: "",
              kind: "quantity",
              value: null,
              unit: null,
              currency: null,
              quote: "",
            },
          ])
        }
      >
        Add a reviewed value
      </Button>
    </fieldset>
  );
}
