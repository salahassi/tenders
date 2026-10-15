import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import "./commercial.css";
type Row = Record<string, any>;
const label = (value: string) => value.replaceAll("_", " ");
const timestamp = (value: string) => new Date(value).toISOString();
export default function ProcurementHistory({
  opportunityId,
}: {
  opportunityId: string;
}) {
  const { backend, state } = useApp(),
    owner = state.settings.role === "Owner",
    editor = owner || state.settings.role === "Editor";
  const [acquisition, setAcquisition] = useState<Row | null>(null),
    [submissions, setSubmissions] = useState<Row[]>([]),
    [events, setEvents] = useState<Row[]>([]),
    [versions, setVersions] = useState<Row[]>([]),
    [exports, setExports] = useState<Row[]>([]),
    [artifacts, setArtifacts] = useState<Row[]>([]),
    [relations, setRelations] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [note, setNote] = useState(""),
    [method, setMethod] = useState("manual_upload"),
    [fee, setFee] = useState(""),
    [currency, setCurrency] = useState(""),
    [instructions, setInstructions] = useState(""),
    [reference, setReference] = useState("");
  const [version, setVersion] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [submitted, setSubmitted] = useState(""),
    [channel, setChannel] = useState(""),
    [submissionRef, setSubmissionRef] = useState(""),
    [receipt, setReceipt] = useState("");
  const [historyId, setHistoryId] = useState(""),
    [eventType, setEventType] = useState("won"),
    [occurred, setOccurred] = useState(""),
    [reason, setReason] = useState(""),
    [correctionRef, setCorrectionRef] = useState(""),
    [related, setRelated] = useState(""),
    [relationReason, setRelationReason] = useState("");
  const currentOpportunity = state.opportunities.find(
    (o) => o.id === opportunityId,
  );
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const duplicateCandidates = currentOpportunity
    ? state.opportunities.filter(
        (o) =>
          o.id !== opportunityId &&
          o.sourceId !== currentOpportunity.sourceId &&
          ((normalize(o.reference) &&
            normalize(o.reference) ===
              normalize(currentOpportunity.reference)) ||
            (normalize(o.title) &&
              normalize(o.title) === normalize(currentOpportunity.title)) ||
            (normalize(o.buyer) &&
              normalize(o.buyer) === normalize(currentOpportunity.buyer))),
      )
    : [];
  async function load() {
    if (!backend) return;
    const [a, s, h, v, p, e, f, r] = await Promise.all([
      backend.list<Row>("acquisitions", { opportunity: opportunityId }),
      backend.list<Row>("submissions", { opportunity: opportunityId }),
      backend.list<Row>("submission-events", { opportunity: opportunityId }),
      backend.list<Row>("proposal-versions"),
      backend.list<Row>("proposals"),
      backend.list<Row>("exports"),
      backend.list<Row>("export-artifacts"),
      backend.list<Row>("opportunity-relations"),
    ]);
    setAcquisition(a[0] || null);
    setSubmissions(s);
    setEvents(h);
    setVersions(
      v.filter((x) =>
        p.some(
          (y) => y.id === x.proposal_id && y.opportunity_id === opportunityId,
        ),
      ),
    );
    setExports(e);
    setArtifacts(f);
    setRelations(
      r.filter(
        (x) =>
          x.opportunity_id === opportunityId ||
          x.related_opportunity_id === opportunityId,
      ),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [backend, opportunityId]);
  async function act(operation: string, input: Row) {
    if (!backend) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await backend.request("/v1/commands", {
        method: "POST",
        body: { commands: [{ operation, input }] },
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
      setSuccess("Saved to your workspace.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  const current = acquisition?.state || "not_started",
    next =
      current === "not_started" || current === "failed"
        ? ["requested"]
        : current === "requested"
          ? ["approved"]
          : current === "approved"
            ? ["awaiting_document"]
            : [];
  const files = artifacts.filter(
    (a) =>
      a.status === "ready" &&
      exports.some(
        (e) =>
          e.id === a.export_id &&
          e.mode === "final" &&
          e.proposal_version_id === version,
      ),
  );
  if (!backend) return null;
  return (
    <section className="panel commercial-panel">
      <h2>Acquisition and manual submission</h2>
      <p>
        Approval records a decision to obtain the RFP manually. No payment or
        external portal action is performed.
      </p>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {success && <p role="status">{success}</p>}
      <h3>RFP acquisition: {label(current)}</h3>
      {acquisition && (
        <p>
          {label(acquisition.method)} ·{" "}
          {acquisition.fee === null
            ? "Fee unknown"
            : `${acquisition.fee} ${acquisition.currency}`}{" "}
          · {acquisition.note}
        </p>
      )}
      {editor && current !== "document_available" && (
        <div className="commercial-grid">
          {!acquisition && (
            <>
              <Field label="Acquisition method">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option value="manual_upload">Manual upload</option>
                  <option value="free_public">Free public document</option>
                  <option value="paid_manual">Paid, obtained manually</option>
                </select>
              </Field>
              <Field label="Known fee (blank means unknown)">
                <input
                  inputMode="decimal"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                />
              </Field>
              <Field label="Fee currency (three letters)">
                <input
                  maxLength={3}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Source instructions">
                <textarea
                  maxLength={5000}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field label="Reason or note">
            <textarea
              minLength={5}
              maxLength={3000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Field label="Optional payment or download reference">
            <input
              maxLength={1000}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          {[...next, ...(current !== "failed" ? ["failed"] : [])].map(
            (target) => (
              <Button
                key={target}
                disabled={
                  busy ||
                  note.trim().length < 5 ||
                  (target === "approved" && !owner)
                }
                onClick={() =>
                  act("acquisition.transition", {
                    opportunity_id: opportunityId,
                    expected_revision: acquisition?.revision || 0,
                    state: target,
                    note,
                    external_reference: reference,
                    ...(!acquisition
                      ? {
                          method,
                          fee: fee || null,
                          currency: fee ? currency : null,
                          instructions,
                        }
                      : {}),
                  })
                }
              >
                {target === "approved"
                  ? "Owner: approve manual acquisition"
                  : `Record ${label(target)}`}
              </Button>
            ),
          )}
          <p>
            Accepting a readable, eligible RFP records “document available.” It
            does not start analysis.
          </p>
        </div>
      )}
      <h3>Manual submission records</h3>
      <p>
        Exporting a file does not submit a bid. Record only a submission already
        made through the buyer’s channel.
      </p>
      {submissions.map((s) => (
        <article key={s.id}>
          <h4>
            {label(s.state)} · version{" "}
            {versions.find((v) => v.id === s.proposal_version_id)?.ordinal ||
              "historical"}
          </h4>
          <p>
            {new Date(s.submitted_at).toLocaleString()} · {s.channel} ·{" "}
            {s.external_reference}
          </p>
          <p>
            Artifact:{" "}
            {s.artifact_verification === "reviewed"
              ? "Owner-reviewed final files"
              : "Final file not registered as reviewed"}
          </p>
          <ul>
            {events
              .filter((e) => e.submission_id === s.id)
              .map((e) => (
                <li key={e.id}>
                  {new Date(e.occurred_at).toLocaleString()} —{" "}
                  {label(e.event_type)}: {e.reason}
                  {e.event_type === "correction" && (
                    <span>
                      {" "}
                      · Corrected external reference:{" "}
                      {e.correction.external_reference ||
                        "See correction record"}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </article>
      ))}
      {!submissions.length && <p>No submission has been recorded.</p>}
      {owner && (
        <details>
          <summary>Record a manual submission</summary>
          <Field label="Approved proposal version">
            <select
              value={version}
              onChange={(e) => {
                setVersion(e.target.value);
                setSelected([]);
              }}
            >
              <option value="">Choose version</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.ordinal}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend>Final export files for this version</legend>
            {files.map((a) => {
              const r = exports.find((e) => e.id === a.export_id);
              return (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, a.id]
                          : selected.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.original_name} · {r?.volume} ·{" "}
                  {a.kind === "reviewed"
                    ? "reviewed"
                    : "not registered as reviewed"}
                </label>
              );
            })}
            {!files.length && (
              <p>Authorize a final export from the proposal first.</p>
            )}
          </fieldset>
          <Field label="Actual submission time (your device timezone)">
            <input
              type="datetime-local"
              value={submitted}
              onChange={(e) => setSubmitted(e.target.value)}
            />
          </Field>
          <Field label="Channel">
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="External submission reference">
            <input
              value={submissionRef}
              onChange={(e) => setSubmissionRef(e.target.value)}
              maxLength={1000}
            />
          </Field>
          <Field label="Sanitized receipt reference (optional)">
            <input
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              maxLength={1000}
            />
          </Field>
          <Button
            disabled={
              busy ||
              !version ||
              !selected.length ||
              !submitted ||
              channel.length < 2 ||
              !submissionRef
            }
            onClick={() =>
              act("submission.record", {
                proposal_version_id: version,
                expected_revision: versions.find((v) => v.id === version)
                  ?.revision,
                artifact_ids: selected,
                submitted_at: timestamp(submitted),
                channel,
                external_reference: submissionRef,
                sanitized_receipt: receipt,
              })
            }
          >
            Record completed manual submission
          </Button>
        </details>
      )}
      {owner && !!submissions.length && (
        <details>
          <summary>Record a result or correction</summary>
          <Field label="Submission">
            <select
              value={historyId}
              onChange={(e) => setHistoryId(e.target.value)}
            >
              <option value="">Choose submission</option>
              {submissions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.external_reference} · {label(s.state)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Event">
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            >
              {["won", "lost", "withdrawn", "canceled", "correction"].map(
                (x) => (
                  <option key={x}>{x}</option>
                ),
              )}
            </select>
          </Field>
          <Field label="Event time (your device timezone)">
            <input
              type="datetime-local"
              value={occurred}
              onChange={(e) => setOccurred(e.target.value)}
            />
          </Field>
          <Field label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={3000}
            />
          </Field>
          {eventType === "correction" && (
            <Field label="Corrected external reference (original remains in history)">
              <input
                value={correctionRef}
                onChange={(e) => setCorrectionRef(e.target.value)}
                maxLength={1000}
              />
            </Field>
          )}
          <Button
            disabled={
              busy ||
              !historyId ||
              !occurred ||
              reason.length < 10 ||
              (eventType === "correction" && !correctionRef)
            }
            onClick={() =>
              act("submission.event", {
                id: historyId,
                expected_revision: submissions.find((s) => s.id === historyId)
                  ?.revision,
                event_type: eventType,
                occurred_at: timestamp(occurred),
                reason,
                ...(eventType === "correction"
                  ? { correction: { external_reference: correctionRef } }
                  : {}),
              })
            }
          >
            Append event
          </Button>
        </details>
      )}
      <details>
        <summary>Related advertisements from other sources</summary>
        {duplicateCandidates.length > 0 && (
          <>
            <p>
              Possible related advertisements match the buyer, procurement
              reference or normalized title. Review their evidence before
              linking; both records are preserved.
            </p>
            <ul>
              {duplicateCandidates.map((o) => (
                <li key={o.id}>
                  {o.title} · {o.reference} · {o.buyer}
                  {editor && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setRelated(o.id);
                        setRelationReason("");
                      }}
                    >
                      Review relationship
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {relations.map((r) => (
          <p key={r.id}>
            {state.opportunities.find(
              (o) =>
                o.id ===
                (r.opportunity_id === opportunityId
                  ? r.related_opportunity_id
                  : r.opportunity_id),
            )?.title || "Related opportunity"}{" "}
            — {r.reason}
          </p>
        ))}
        {editor && (
          <>
            <Field label="Related opportunity">
              <select
                value={related}
                onChange={(e) => setRelated(e.target.value)}
              >
                <option value="">Choose opportunity</option>
                {state.opportunities
                  .filter((o) => o.id !== opportunityId)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Evidence for the relationship">
              <textarea
                value={relationReason}
                onChange={(e) => setRelationReason(e.target.value)}
                maxLength={3000}
              />
            </Field>
            <Button
              disabled={busy || !related || relationReason.length < 10}
              onClick={() =>
                act("opportunity.relate", {
                  opportunity_id: opportunityId,
                  related_opportunity_id: related,
                  reason: relationReason,
                })
              }
            >
              Link while preserving both records
            </Button>
          </>
        )}
      </details>
    </section>
  );
}
