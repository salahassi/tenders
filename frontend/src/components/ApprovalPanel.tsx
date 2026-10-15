import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { Button, Field } from "./ui";
import CommercialReview from "./CommercialReview";
import type { Proposal } from "../types";
type Row = Record<string, any>;
export default function ApprovalPanel({ proposal }: { proposal: Proposal }) {
  const { backend, runCommand, state, refresh, notify } = useApp(),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState(""),
    [verdict, setVerdict] = useState("recommend"),
    [comment, setComment] = useState("");
  const owner = state.settings.role === "Owner";
  async function load() {
    if (!backend || !proposal.versionId) return;
    try {
      const v = await backend.request<Row>(
          `/v1/proposal-versions/${proposal.versionId}`,
        ),
        filter = { version: proposal.versionId };
      const [
        rates,
        estimates,
        deliveries,
        questions,
        compliance,
        reviews,
        sections,
        requirements,
        readiness,
        plan,
      ] = await Promise.all([
        backend.list<Row>("rates"),
        backend.list<Row>("estimates", filter),
        backend.list<Row>("deliveries", filter),
        backend.list<Row>("questions", filter),
        backend.list<Row>("compliance", filter),
        backend.list<Row>("reviews", filter),
        backend.list<Row>("proposal-sections", filter),
        backend.list<Row>("requirements", {
          opportunity: proposal.opportunityId,
        }),
        backend.request<Row>(
          `/v1/proposal-versions/${proposal.versionId}/readiness`,
        ),
        backend.request<Row>(`/v1/generation-plans/${v.data.plan_id}`),
      ]);
      setData({
        version: v.data,
        rates,
        estimates,
        deliveries,
        questions,
        compliance,
        reviews,
        sections: sections.sort((a, b) => a.ordinal - b.ordinal),
        requirements: requirements.filter((r) => r.plan_id === v.data.plan_id),
        readiness: readiness.data,
        plan: plan.data,
      });
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load approval records.",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [backend, proposal.versionId]);
  async function action(operation: string, input: Row) {
    if (!runCommand) return false;
    setBusy(true);
    setError("");
    try {
      await runCommand(operation, input);
      await load();
      notify("The server saved this review decision.");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The review decision failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!backend || !proposal.versionId) return null;
  return (
    <>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading commercial and approval records…</p>
      ) : (
        <>
          <CommercialReview
            key={proposal.versionId}
            version={data.version}
            rates={data.rates}
            estimates={data.estimates}
            deliveries={data.deliveries}
            requirements={data.requirements}
            sections={data.sections}
            onSaved={async () => {
              await load();
              await refresh?.();
            }}
          />
          <section className="panel commercial-panel">
            <h2>Requirement coverage and final review</h2>
            <p>
              Review the complete inventory against the original files. Model
              findings are advisory. Only the Owner can confirm compliance,
              resolve finalization decisions and approve this exact version.
            </p>
            <Button disabled={busy} onClick={load}>
              Refresh review records
            </Button>
            {owner && (
              <Button
                disabled={busy}
                onClick={() =>
                  action("inventory.confirm", {
                    proposal_version_id: data.version.id,
                    expected_revision: data.version.revision,
                  })
                }
              >
                I reviewed and confirm the complete requirement inventory
              </Button>
            )}
            <div className="stack">
              {data.requirements.map((r: Row) => (
                <ComplianceItem
                  key={r.id}
                  requirement={r}
                  current={data.compliance.find(
                    (c: Row) => c.requirement_id === r.id,
                  )}
                  suggested={data.version.review_result?.responses?.find(
                    (c: Row) => c.requirement_id === r.id,
                  )}
                  sections={data.sections}
                  sources={[
                    ...data.plan.frozen_context.blocks,
                    ...data.plan.frozen_context.knowledge,
                  ]}
                  versionId={data.version.id}
                  owner={owner}
                  busy={busy}
                  action={action}
                />
              ))}
            </div>
            {!data.requirements.length && (
              <p>
                No extracted requirements. Check the RFP and analysis before
                approving an inventory.
              </p>
            )}
            <h3>Questions and unresolved assumptions</h3>
            {data.questions.map((q: Row) => (
              <QuestionItem
                key={q.id}
                question={q}
                owner={owner}
                busy={busy}
                action={action}
              />
            ))}
            {!data.questions.length && (
              <p>No saved questions for this version.</p>
            )}
            <h3>Reviewer decisions</h3>
            {data.reviews.map((r: Row) => (
              <div className="commercial-card" key={r.id}>
                <strong>{r.verdict.replaceAll("_", " ")}</strong>
                <p dir="auto">{r.comment}</p>
                {r.resolution && <p>Owner resolution: {r.resolution}</p>}
                {owner &&
                  r.verdict === "changes_requested" &&
                  !r.resolved_by && (
                    <ResolveReview review={r} busy={busy} action={action} />
                  )}
              </div>
            ))}
            <Field label="Your recommendation">
              <select
                value={verdict}
                onChange={(e) => setVerdict(e.target.value)}
              >
                <option value="recommend">Recommend approval</option>
                <option value="changes_requested">Request changes</option>
              </select>
            </Field>
            <Field label="Your review comments">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>
            <Button
              disabled={busy || !comment.trim()}
              onClick={async () => {
                const { data: boot } =
                  await backend.request<Row>("/v1/bootstrap");
                const current = data.reviews.find(
                  (r: Row) => r.created_by === boot.membership.user_id,
                );
                await action("review.verdict", {
                  proposal_version_id: data.version.id,
                  expected_revision: current?.revision || 0,
                  verdict,
                  comment,
                });
              }}
            >
              Save my recommendation
            </Button>
            <div className="commercial-result">
              <h3>Approval readiness</h3>
              {data.readiness.blockers.length ? (
                <ul>
                  {data.readiness.blockers.map((b: string) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  No deterministic blockers remain. The Owner must still review
                  the exact proposal and supporting evidence.
                </p>
              )}
              {owner && (
                <>
                  <Field label="Owner approval rationale">
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      data.readiness.blockers.length > 0 ||
                      reason.trim().length < 10
                    }
                    onClick={() =>
                      action("proposal.approve", {
                        proposal_version_id: data.version.id,
                        expected_revision: data.version.revision,
                        reason,
                      })
                    }
                  >
                    Approve proposal version {proposal.version}
                  </Button>
                </>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
function ComplianceItem({
  requirement: r,
  current,
  suggested,
  sections,
  sources,
  versionId,
  owner,
  busy,
  action,
}: {
  requirement: Row;
  current?: Row;
  suggested?: Row;
  sections: Row[];
  sources: Row[];
  versionId: string;
  owner: boolean;
  busy: boolean;
  action: (op: string, input: Row) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(
      current?.status || suggested?.status || "missing",
    ),
    [keys, setKeys] = useState<string[]>(
      current?.section_keys || suggested?.section_ids || [],
    ),
    [rationale, setRationale] = useState(
      current?.rationale || suggested?.rationale || "",
    ),
    [evidence, setEvidence] = useState<Row[]>(
      current?.evidence_refs || suggested?.evidence_refs || [],
    ),
    [source, setSource] = useState(""),
    [quote, setQuote] = useState("");
  const selected = sources.find((s) => s.id === source);
  return (
    <details className="commercial-card">
      <summary>
        {r.mandatory ? "Mandatory" : "Optional"} · {r.text} ·{" "}
        {current?.confirmed_by ? "Owner confirmed" : "Needs review"}
      </summary>
      <p>{r.interpretation}</p>
      <p>Acceptance evidence: {r.acceptance_evidence || "Unspecified"}</p>
      {r.source_refs?.map((x: Row, i: number) => (
        <blockquote key={i} dir="auto">
          {x.quote}
          <br />
          <small>Source block: {x.id}</small>
        </blockquote>
      ))}
      <fieldset disabled={!owner || busy}>
        <Field label="Response status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="answered">Answered</option>
            <option value="partial">Partial</option>
            <option value="missing">Missing</option>
            <option value="clarification_required">
              Clarification required
            </option>
            <option value="not_applicable_approved">
              Not applicable with Owner rationale
            </option>
          </select>
        </Field>
        <Field label="Response sections">
          <select
            multiple
            value={keys}
            onChange={(e) =>
              setKeys(Array.from(e.target.selectedOptions, (x) => x.value))
            }
          >
            {sections.map((s) => (
              <option value={s.section_key} key={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rationale">
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
        </Field>
        <h4>Verbatim evidence</h4>
        {evidence.map((e, i) => (
          <div key={i}>
            <blockquote dir="auto">{e.quote}</blockquote>
            <small>{e.id}</small>
            <Button
              onClick={() => setEvidence(evidence.filter((_, n) => n !== i))}
            >
              Remove reference
            </Button>
          </div>
        ))}
        <Field label="Evidence block">
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setQuote("");
            }}
          >
            <option value="">Choose an exact source</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind} · {s.id}
              </option>
            ))}
          </select>
        </Field>
        {selected && (
          <pre className="commercial-evidence" dir="auto">
            {selected.text}
          </pre>
        )}
        <Field label="Exact quotation from the selected block">
          <textarea value={quote} onChange={(e) => setQuote(e.target.value)} />
        </Field>
        <Button
          disabled={
            !selected || !quote.trim() || !selected.text.includes(quote)
          }
          onClick={() => {
            setEvidence([...evidence, { id: source, quote }]);
            setQuote("");
          }}
        >
          Add this quotation
        </Button>
        <Button
          variant="primary"
          disabled={rationale.trim().length < 10}
          onClick={() =>
            action("compliance.save", {
              proposal_version_id: versionId,
              requirement_id: r.id,
              expected_revision: current?.revision || 0,
              status,
              section_keys: keys,
              evidence_refs: evidence,
              rationale,
            })
          }
        >
          Confirm this response
        </Button>
      </fieldset>
    </details>
  );
}
function QuestionItem({
  question: q,
  owner,
  busy,
  action,
}: {
  question: Row;
  owner: boolean;
  busy: boolean;
  action: (op: string, input: Row) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState(q.answer || ""),
    [source, setSource] = useState(q.answer_source || ""),
    [reason, setReason] = useState(""),
    [status, setStatus] = useState("resolved");
  return (
    <details className="commercial-card">
      <summary>
        {q.blocking_level} · {q.question} · {q.status.replaceAll("_", " ")}
      </summary>
      <p>{q.reason}</p>
      <fieldset disabled={!owner || busy}>
        <Field label="Answer / Owner decision">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </Field>
        <Field label="Evidence or decision source">
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </Field>
        <Field label="Resolution rationale">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="Resolution">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="resolved">Resolved</option>
            <option value="not_applicable_with_reason">
              Not applicable with reason
            </option>
          </select>
        </Field>
        <p>
          Resolving a question does not rewrite the proposal. Any missing-input
          markers in its text still require regeneration.
        </p>
        <Button
          disabled={
            !answer.trim() || !source.trim() || reason.trim().length < 10
          }
          onClick={() =>
            action("question.resolve", {
              id: q.id,
              expected_revision: q.revision,
              status,
              answer,
              answer_source: source,
              reason,
            })
          }
        >
          Record resolution
        </Button>
      </fieldset>
    </details>
  );
}
function ResolveReview({
  review,
  busy,
  action,
}: {
  review: Row;
  busy: boolean;
  action: (op: string, input: Row) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  return (
    <>
      <Field label="How the change request was resolved">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Button
        disabled={busy || reason.trim().length < 10}
        onClick={() =>
          action("review.resolve", {
            id: review.id,
            expected_revision: review.revision,
            reason,
          })
        }
      >
        Record Owner resolution
      </Button>
    </>
  );
}
