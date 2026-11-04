import { useEffect, useRef, useState } from "react";
import type { BackendClient } from "../lib/backendClient";
import {
  canonicalSourceSpanId,
  sourceAuthorityFor,
  type SourceEvidenceContractV1,
  type SourceSpanV1,
  type ObligationTupleV1,
} from "../../../backend/supabase/functions/_shared/sourceEvidence";
import { Button } from "./ui";
export type SourceReviewContext = {
  source_evidence: SourceEvidenceContractV1;
  sources: unknown[];
};
const emptyTuple: ObligationTupleV1 = {
  modality: "unknown",
  actor: null,
  negated: null,
  conditions: [],
  exceptions: [],
  consequences: [],
  quantities: [],
  dates: [],
};
export default function SourceReviewEditor({
  client,
  opportunityId,
  ar,
  onChange,
}: {
  client: BackendClient;
  opportunityId: string;
  ar: boolean;
  onChange: (context: SourceReviewContext) => void;
}) {
  const [context, setContext] = useState<SourceReviewContext | null>(null),
    [selected, setSelected] = useState(""),
    [quote, setQuote] = useState(""),
    [role, setRole] = useState("unknown"),
    [tuple, setTuple] = useState<ObligationTupleV1>(emptyTuple),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const l = (en: string, arabic: string) => (ar ? arabic : en);
  const actionScope = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    actionScope.current = controller;
    return () => controller.abort();
  }, [client, opportunityId]);
  useEffect(() => {
    const controller = new AbortController();
    client
      .request<SourceReviewContext>(
        `/v1/opportunities/${opportunityId}/source-review`,
        { signal: controller.signal },
      )
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setContext(data);
          onChange(data);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [client, opportunityId, refresh]);
  const span = context?.source_evidence.spans.find((s) => s.id === selected);
  const command = async (operation: string, input: unknown) => {
    const controller = actionScope.current;
    if (!controller || controller.signal.aborted) return;
    setBusy(true);
    setError("");
    try {
      await client.request("/v1/commands", {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        signal: controller.signal,
        body: { commands: [{ operation, input }] },
      });
      if (controller.signal.aborted) return;
      setRefresh((v) => v + 1);
      setReason("");
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <details className="panel">
      <summary>
        {l(
          "Review source authority and obligations",
          "مراجعة صفة المصدر والتزاماته",
        )}
      </summary>
      <p>
        {l(
          "Identify who issued the source, then review an exact passage and its meaning. A document filename or upload category does not establish buyer authority.",
          "حدد الجهة التي أصدرت المصدر، ثم راجع المقطع الحرفي ومعناه. اسم الملف أو تصنيفه عند الرفع لا يثبت صدوره عن الجهة المشترية.",
        )}
      </p>
      <label>
        {l("Source passage", "مقطع المصدر")}
        <select
          value={selected}
          onChange={(e) => {
            const s = context?.source_evidence.spans.find(
              (x) => x.id === e.target.value,
            );
            setSelected(e.target.value);
            setQuote(s?.quote || "");
            setRole(s?.authority.role || "unknown");
            setTuple(emptyTuple);
          }}
        >
          <option value="">
            {l("Select a source passage", "اختر مقطعًا من المصدر")}
          </option>
          {context?.source_evidence.spans.map((s, i) => (
            <option key={s.id} value={s.id}>
              {i + 1}. {s.quote.slice(0, 120)}
            </option>
          ))}
        </select>
      </label>
      {span && (
        <>
          <blockquote style={{ whiteSpace: "pre-wrap" }}>
            {span.quote}
          </blockquote>
          <label>
            {l("Source authority", "صفة المصدر")}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {[
                ["unknown", l("Unknown", "غير معروفة")],
                ["buyer_rfp", l("Buyer RFP", "طلب صادر عن الجهة المشترية")],
                [
                  "buyer_addendum",
                  l("Buyer addendum", "ملحق صادر عن الجهة المشترية"),
                ],
                ["supplier_proposal", l("Supplier proposal", "عرض مورد")],
                [
                  "company_evidence",
                  l("Company evidence", "إثبات خاص بالشركة"),
                ],
                ["reference", l("Reference only", "مرجع فقط")],
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {l("Review reason", "سبب قرار المراجعة")}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={3000}
            />
          </label>
          <Button
            disabled={
              busy ||
              !reason.trim() ||
              !["notice", "document"].includes(span.entity_kind)
            }
            onClick={() =>
              void command("source.authority.review", {
                opportunity_id: opportunityId,
                entity_kind: span.entity_kind,
                entity_id: span.entity_id,
                content_hash: span.content_hash,
                expected_revision: span.authority.revision,
                role,
                status: "confirmed",
                supersedes: span.authority.supersedes,
                precedence: span.authority.precedence,
                reason,
              })
            }
          >
            {l("Save source authority review", "حفظ مراجعة صفة المصدر")}
          </Button>
          <label>
            {l(
              "Exact obligation passage (must occur once in the shown source)",
              "مقطع الالتزام الحرفي (يجب أن يظهر مرة واحدة في المصدر المعروض)",
            )}
            <textarea
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              maxLength={12000}
            />
          </label>
          <label>
            {l("Obligation meaning", "معنى الالتزام")}
            <select
              value={tuple.modality}
              onChange={(e) =>
                setTuple({
                  ...tuple,
                  modality: e.target.value as ObligationTupleV1["modality"],
                })
              }
            >
              {[
                ["unknown", l("Unresolved", "غير محسوم")],
                ["required", l("Required", "مطلوب")],
                ["permitted", l("Permitted", "مسموح")],
                ["prohibited", l("Prohibited", "ممنوع")],
                ["informational", l("Informational", "للعلم")],
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {l("Actor named in the passage", "الطرف المذكور في المقطع")}
            <input
              value={tuple.actor || ""}
              onChange={(e) =>
                setTuple({ ...tuple, actor: e.target.value || null })
              }
            />
          </label>
          <label>
            {l("Negation in source", "النفي في المصدر")}
            <select
              value={tuple.negated === null ? "unknown" : String(tuple.negated)}
              onChange={(e) =>
                setTuple({
                  ...tuple,
                  negated:
                    e.target.value === "unknown"
                      ? null
                      : e.target.value === "true",
                })
              }
            >
              <option value="unknown">{l("Unresolved", "غير محسوم")}</option>
              <option value="true">{l("Negated", "منفي")}</option>
              <option value="false">{l("Not negated", "غير منفي")}</option>
            </select>
          </label>
          {(["conditions", "exceptions", "consequences"] as const).map(
            (field, i) => (
              <label key={field}>
                {
                  [
                    l(
                      "Conditions — exact wording, one per line",
                      "الشروط — النص الحرفي، شرط في كل سطر",
                    ),
                    l(
                      "Exceptions — exact wording, one per line",
                      "الاستثناءات — النص الحرفي، استثناء في كل سطر",
                    ),
                    l(
                      "Consequences — exact wording, one per line",
                      "الآثار المترتبة — النص الحرفي، أثر في كل سطر",
                    ),
                  ][i]
                }
                <textarea
                  value={tuple[field].join("\n")}
                  onChange={(e) =>
                    setTuple({
                      ...tuple,
                      [field]: e.target.value.split("\n").filter(Boolean),
                    })
                  }
                />
              </label>
            ),
          )}
          {tuple.quantities.map((q, i) => (
            <fieldset key={i}>
              <legend>
                {l("Quantity or amount", "الكمية أو المبلغ")} {i + 1}
              </legend>
              {(["value", "unit", "currency"] as const).map((field, j) => (
                <label key={field}>
                  {
                    [
                      l("Value", "القيمة"),
                      l("Unit", "الوحدة"),
                      l("Currency, if applicable", "العملة عند انطباقها"),
                    ][j]
                  }
                  <input
                    value={q[field] || ""}
                    onChange={(e) =>
                      setTuple({
                        ...tuple,
                        quantities: tuple.quantities.map((x, n) =>
                          n === i
                            ? {
                                ...x,
                                [field]:
                                  e.target.value ||
                                  (field === "currency" ? null : ""),
                              }
                            : x,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <Button
                onClick={() =>
                  setTuple({
                    ...tuple,
                    quantities: tuple.quantities.filter((_, n) => n !== i),
                  })
                }
              >
                {l("Remove quantity", "حذف الكمية")}
              </Button>
            </fieldset>
          ))}
          <Button
            onClick={() =>
              setTuple({
                ...tuple,
                quantities: [
                  ...tuple.quantities,
                  { value: "", unit: "", currency: null },
                ],
              })
            }
          >
            {l("Add source quantity", "إضافة كمية واردة في المصدر")}
          </Button>
          {tuple.dates.map((d, i) => (
            <fieldset key={i}>
              <legend>{l("Source date", "تاريخ وارد في المصدر")}</legend>
              <label>
                {l("Date wording", "نص التاريخ")}
                <input
                  value={d.value}
                  onChange={(e) =>
                    setTuple({
                      ...tuple,
                      dates: tuple.dates.map((x, n) =>
                        n === i ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                {l("Related event", "الحدث المرتبط")}
                <input
                  value={d.event}
                  onChange={(e) =>
                    setTuple({
                      ...tuple,
                      dates: tuple.dates.map((x, n) =>
                        n === i ? { ...x, event: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <Button
                onClick={() =>
                  setTuple({
                    ...tuple,
                    dates: tuple.dates.filter((_, n) => n !== i),
                  })
                }
              >
                {l("Remove date", "حذف التاريخ")}
              </Button>
            </fieldset>
          ))}
          <Button
            onClick={() =>
              setTuple({
                ...tuple,
                dates: [...tuple.dates, { value: "", event: "" }],
              })
            }
          >
            {l("Add source date", "إضافة تاريخ وارد في المصدر")}
          </Button>
          <Button
            disabled={
              busy ||
              !quote.trim() ||
              !reason.trim() ||
              sourceAuthorityFor([span]).authority_status !== "confirmed"
            }
            onClick={() => {
              const offset = span.quote.indexOf(quote);
              if (offset < 0 || span.quote.indexOf(quote, offset + 1) >= 0) {
                setError(
                  l(
                    "Choose an exact, unambiguous passage from the displayed source.",
                    "اختر مقطعًا حرفيًا غير ملتبس من المصدر المعروض.",
                  ),
                );
                return;
              }
              const start =
                span.start + Array.from(span.quote.slice(0, offset)).length;
              const selectedSpan: SourceSpanV1 = {
                ...span,
                start,
                end: start + Array.from(quote).length,
                quote,
              };
              selectedSpan.id = canonicalSourceSpanId(selectedSpan);
              void command("source.obligation.review", {
                opportunity_id: opportunityId,
                review_id: null,
                expected_revision: 0,
                spans: [selectedSpan],
                semantics: tuple,
                status: "confirmed",
                reason,
              });
            }}
          >
            {l("Save reviewed obligation", "حفظ الالتزام المراجع")}
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{l("Saving review…", "جارٍ حفظ المراجعة…")}</p>}
    </details>
  );
}
