import { useEffect, useRef, useState } from "react";
import type { BackendClient } from "../lib/backendClient";
import type {
  AuthoringBody,
  AuthoringContext,
} from "../../../backend/supabase/functions/_shared/proposalAuthoring";
import { sourceAuthorityFor } from "../../../backend/supabase/functions/_shared/sourceEvidence";
import SourceReviewEditor, {
  type SourceReviewContext,
} from "./SourceReviewEditor";
import { Button } from "./ui";
import { Link } from "react-router-dom";
export default function ProposalAuthoring({
  client,
  snapshotId,
  deliveryRevision,
  ar,
  onPublished,
}: {
  client: BackendClient;
  snapshotId: string;
  deliveryRevision: number;
  ar: boolean;
  onPublished: (id: string) => void;
}) {
  const [context, setContext] = useState<AuthoringContext | null>(null),
    [body, setBody] = useState<AuthoringBody | null>(null),
    [catalog, setCatalog] = useState<SourceReviewContext | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [reviewReason, setReviewReason] = useState(""),
    [coverage, setCoverage] = useState(""),
    [reviews, setReviews] = useState<Record<string, string>>({}),
    [report, setReport] = useState<{
      substantive_complete: boolean;
      diagnostics: { code: string; detail: string }[];
    } | null>(null),
    [claimNote, setClaimNote] = useState(""),
    [pending, setPending] = useState("");
  const scope = useRef<AbortController | null>(null),
    l = (en: string, arabic: string) => (ar ? arabic : en);
  const [refreshTarget, setRefreshTarget] = useState<{
      session_id: string;
      revision: number;
      delivery_revision: number;
    } | null>(null),
    [reviewId, setReviewId] = useState<string | null>(null),
    [adopted, setAdopted] = useState<string | null>(null);
  const [qualifierHashes, setQualifierHashes] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    let live = true;
    const quotes = [
      ...new Set(
        body?.requirements.flatMap((r) => [
          ...r.source_semantics.conditions,
          ...r.source_semantics.exceptions,
          ...r.source_semantics.consequences,
        ]) || [],
      ),
    ];
    void Promise.all(
      quotes.map(
        async (quote) =>
          [
            quote,
            [
              ...new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(quote),
                ),
              ),
            ]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          ] as const,
      ),
    ).then((entries) => {
      if (live) setQualifierHashes(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [body?.requirements]);
  const loadRecovery = async () => {
    try {
      const { data } = await client.request<{
        session_id: string;
        revision: number;
        delivery_revision: number;
      }>(`/v1/delivery-snapshots/${snapshotId}/authoring-status`, {
        signal: scope.current?.signal,
      });
      if (!scope.current?.signal.aborted && data.session_id)
        setRefreshTarget(data);
    } catch {
      /* Current authority is required even for metadata recovery. */
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    setBusy(true);
    client
      .request<AuthoringContext>("/v1/proposal-authoring/open", {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        signal: controller.signal,
        body: {
          snapshot_id: snapshotId,
          expected_delivery_revision: deliveryRevision,
        },
      })
      .then(({ data }) => {
        if (!controller.signal.aborted) {
          setContext(data);
          setBody(data.revision.body);
          setSaved(true);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          void loadRecovery();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [client]);
  const edit = (next: AuthoringBody) => {
    setBody(next);
    setSaved(false);
    setReport(null);
  };
  const run = async (action: string, input: unknown) => {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || !context) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await client.request<any>(
        `/v1/proposal-authoring/${context.session.id}/${action}`,
        {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
          signal: controller.signal,
          body: input,
        },
      );
      if (controller.signal.aborted) return;
      if (data.session) {
        setContext(data);
        setBody(data.revision.body);
        setSaved(true);
        setReviewId(null);
      }
      if (data.published_snapshot) onPublished(data.published_snapshot.id);
      if (data.snapshot) {
        onPublished(data.snapshot.id);
        setReport(data.report);
        setReviewId(data.snapshot.payload.authoring.review_id);
      }
      if (data.proposal_version_id) setAdopted(data.proposal_id);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        void loadRecovery();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const updateResponse = (
    requirement: AuthoringBody["requirements"][number],
    patch: Partial<AuthoringBody["fulfillment"][number]>,
  ) => {
    if (!body) return;
    const prior = body.fulfillment.find(
        (f) => f.requirement_id === requirement.id,
      ),
      key = prior?.response_section_key || `response-${requirement.id}`;
    const f = {
      requirement_id: requirement.id,
      response_section_key: key,
      response_excerpt: "",
      method: "",
      deliverable: "",
      acceptance_evidence: "",
      conditions_preserved: [],
      exceptions_preserved: [],
      consequences_preserved: [],
      facts: [],
      ...prior,
      ...patch,
    };
    const section = body.sections.find((s) => s.key === key) || {
      key,
      title: requirement.text.slice(0, 200),
      volume: "technical" as const,
      content_blocks: [],
      requirement_ids: [requirement.id],
      evidence_refs: [],
      company_claims: [],
      assumptions: [],
      questions: [],
    };
    const sections = body.sections.filter((s) => s.key !== key);
    if (f.response_excerpt.trim())
      sections.push({
        ...section,
        content_blocks: [{ type: "paragraph", text: f.response_excerpt }],
      });
    edit({
      ...body,
      sections,
      fulfillment: [
        ...body.fulfillment.filter((x) => x.requirement_id !== requirement.id),
        f,
      ],
    });
  };
  return (
    <section
      className="stack"
      aria-label={l("Write and review responses", "كتابة الاستجابات ومراجعتها")}
      dir={ar ? "rtl" : undefined}
    >
      <h3>
        {l(
          "Complete the response with authorized input",
          "استكمال الاستجابة بمدخلات مخولة",
        )}
      </h3>
      <p>
        {l(
          "You can write and save actual responses while models are unavailable. A current Owner or Editor must review their meaning against the complete source inventory. This does not grant final approval or promise an assigned team's availability.",
          "يمكنك كتابة الاستجابات الفعلية وحفظها عند تعطل النماذج. يجب أن يراجع مالك أو محرر مخول معناها مقابل كامل المصادر. هذا لا يمنح اعتمادًا نهائيًا ولا يعد بتوفر فريق للتنفيذ.",
        )}
      </p>
      {refreshTarget && (
        <div>
          <p>
            {l(
              "Refresh the source context explicitly. Saved response text is retained in a new unreviewed revision with its original history; requirement links and assurance must be reviewed again.",
              "حدّث سياق المصادر صراحةً. سيبقى نص الاستجابة في نسخة جديدة غير مراجعة مع حفظ تاريخه الأصلي؛ يجب مراجعة روابط المتطلبات وضمان المحتوى مجددًا.",
            )}
          </p>
          <Button
            disabled={busy}
            onClick={async () => {
              const controller = scope.current;
              if (!controller) return;
              setBusy(true);
              try {
                const { data } = await client.request<
                  AuthoringContext & { published_snapshot: { id: string } }
                >(
                  `/v1/proposal-authoring/${refreshTarget.session_id}/refresh`,
                  {
                    method: "POST",
                    idempotencyKey: crypto.randomUUID(),
                    signal: controller.signal,
                    body: {
                      expected_revision: refreshTarget.revision,
                      expected_delivery_revision:
                        refreshTarget.delivery_revision,
                    },
                  },
                );
                if (controller.signal.aborted) return;
                setContext(data);
                setBody(data.revision.body);
                setSaved(true);
                setRefreshTarget(null);
                setError("");
                setReport(null);
                setReviewId(null);
                onPublished(data.published_snapshot.id);
              } catch (e) {
                if (!controller.signal.aborted)
                  setError(e instanceof Error ? e.message : String(e));
              } finally {
                if (!controller.signal.aborted) setBusy(false);
              }
            }}
          >
            {l(
              "Keep responses and refresh sources",
              "الاحتفاظ بالاستجابات وتحديث المصادر",
            )}
          </Button>
        </div>
      )}
      {context && body && (
        <>
          <p>
            {context.session.responsible_actor_id
              ? l(
                  "A workspace member has explicitly taken responsibility for this response.",
                  "تولى عضو في مساحة العمل مسؤولية هذه الاستجابة صراحةً.",
                )
              : l(
                  "No responsible editor has accepted this work yet. Ask an authorized workspace member to take responsibility here; no notification has been sent.",
                  "لم يتولَّ محرر مسؤولية هذا العمل بعد. اطلب من عضو مخول تولي المسؤولية هنا؛ لم تُرسل أي رسالة تنبيه.",
                )}
          </p>
          <label>
            {l("My responsibility note", "ملاحظتي عند تولي المسؤولية")}
            <input
              value={claimNote}
              onChange={(e) => setClaimNote(e.target.value)}
              maxLength={3000}
            />
          </label>
          <Button
            disabled={busy || !claimNote.trim()}
            onClick={() =>
              void run("claim", {
                expected_revision: context.session.revision,
                note: claimNote,
              })
            }
          >
            {l(
              "I take responsibility for the response",
              "أتولى مسؤولية الاستجابة",
            )}
          </Button>
          <SourceReviewEditor
            client={client}
            opportunityId={context.session.opportunity_id}
            ar={ar}
            onChange={setCatalog}
          />
          <h4>
            {l("Reviewed source obligations", "التزامات المصدر المراجعة")}
          </h4>
          {body.sections
            .filter((section) => !section.requirement_ids.length)
            .map((section) => (
              <details key={section.key}>
                <summary>
                  {l(
                    "Retained earlier response — requires current review: ",
                    "استجابة سابقة محفوظة — تتطلب مراجعة حالية: ",
                  )}
                  {section.title}
                </summary>
                <p>
                  {l(
                    "Its original history is retained. Copy and adapt useful content into a current obligation response below; resolve the changed-source gap only after reviewing it.",
                    "تاريخها الأصلي محفوظ. انسخ المحتوى الملائم وكيّفه ضمن الاستجابة لالتزام حالي أدناه؛ عالج فجوة تغير المصدر بعد مراجعته.",
                  )}
                </p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {section.content_blocks
                    .map((b) =>
                      b.type === "table"
                        ? b.rows.map((row) => row.join(" | ")).join("\n")
                        : b.text,
                    )
                    .join("\n")}
                </pre>
                <Button
                  onClick={() =>
                    edit({
                      ...body,
                      sections: body.sections.filter(
                        (s) => s.key !== section.key,
                      ),
                    })
                  }
                >
                  {l(
                    "Remove from this draft after reconciliation",
                    "حذفها من هذه المسودة بعد تسوية محتواها",
                  )}
                </Button>
              </details>
            ))}
          {!catalog?.source_evidence.reviews.length && (
            <p>
              {l(
                "Review the source authority and its obligations above before completing the inventory.",
                "راجع صفة المصدر والتزاماته أعلاه قبل استكمال قائمة المتطلبات.",
              )}
            </p>
          )}
          {catalog?.source_evidence.reviews
            .filter(
              (r) =>
                r.status === "confirmed" &&
                !body.requirements.some((q) => q.id === r.id),
            )
            .map((review) => (
              <div key={review.id}>
                <blockquote>
                  {review.spans.map((s) => s.quote).join("\n")}
                </blockquote>
                <Button
                  disabled={busy}
                  onClick={() =>
                    edit({
                      ...body,
                      requirements: [
                        ...body.requirements,
                        {
                          id: review.id,
                          text: review.spans.map((s) => s.quote).join("\n"),
                          mandatory: ["required", "prohibited"].includes(
                            review.semantics.modality,
                          ),
                          source_review_reason: review.reason,
                        source_refs: review.spans.map((s) => ({
                            id: s.id,
                            quote: s.quote,
                          })),
                          source_semantics: {
                            ...review.semantics,
                            ...sourceAuthorityFor(review.spans),
                            version: 1,
                            source_span_ids: review.spans.map((s) => s.id),
                            review_status: "confirmed",
                            review_id: review.id,
                          },
                        },
                      ],
                    })
                  }
                >
                  {l("Include obligation", "إضافة الالتزام")}
                </Button>
              </div>
            ))}
          {body.requirements.map((requirement) => {
            const fulfillment = body.fulfillment.find(
              (f) => f.requirement_id === requirement.id,
            );
            return (
              <fieldset key={requirement.id}>
                <legend>
                  {l(
                    "Source obligation and response",
                    "التزام المصدر والاستجابة",
                  )}
                </legend>
                <blockquote>{requirement.text}</blockquote>
                <label>
                  {l("Actual proposed response", "الاستجابة المقترحة الفعلية")}
                  <textarea
                    value={fulfillment?.response_excerpt || ""}
                    onChange={(e) =>
                      updateResponse(requirement, {
                        response_excerpt: e.target.value,
                      })
                    }
                    maxLength={20000}
                  />
                </label>
                {(
                  ["method", "deliverable", "acceptance_evidence"] as const
                ).map((field, i) => (
                  <label key={field}>
                    {
                      [
                        l(
                          "Implementation method — copy the relevant wording from your response",
                          "طريقة التنفيذ — انسخ العبارة ذات الصلة من استجابتك",
                        ),
                        l(
                          "Deliverable — wording in the response",
                          "المخرج المطلوب — عبارته في الاستجابة",
                        ),
                        l(
                          "Acceptance evidence — wording in the response",
                          "دليل قبول المخرج — عبارته في الاستجابة",
                        ),
                      ][i]
                    }
                    <textarea
                      value={fulfillment?.[field] || ""}
                      onChange={(e) =>
                        updateResponse(requirement, { [field]: e.target.value })
                      }
                      maxLength={3000}
                    />
                  </label>
                ))}
                {(
                  ["conditions", "exceptions", "consequences"] as const
                ).flatMap((field) =>
                  requirement.source_semantics[field].map(
                    (qualifier, index) => {
                      const binding = `${field}_preserved` as
                        | "conditions_preserved"
                        | "exceptions_preserved"
                        | "consequences_preserved";
                      return (
                        <div key={field + qualifier}>
                          <label>
                            <input
                              type="checkbox"
                              checked={
                                fulfillment?.[binding].includes(qualifier) ||
                                false
                              }
                              onChange={(e) =>
                                updateResponse(requirement, {
                                  [binding]: e.target.checked
                                    ? [
                                        ...(fulfillment?.[binding] || []),
                                        qualifier,
                                      ]
                                    : (fulfillment?.[binding] || []).filter(
                                        (q) => q !== qualifier,
                                      ),
                                })
                              }
                            />
                            {l(
                              "My response preserves: ",
                              "تحافظ استجابتي على: ",
                            )}
                            {qualifier}
                          </label>
                          <label>
                            {l(
                              "Equivalent wording in my response, if paraphrased — subject to explicit human review",
                              "العبارة المكافئة في استجابتي عند إعادة الصياغة — تخضع لمراجعة بشرية صريحة",
                            )}
                            <textarea
                              disabled={!qualifierHashes[qualifier]}
                              value={
                                fulfillment?.qualifier_equivalences?.find(
                                  (q) =>
                                    q.kind === field &&
                                    q.source_index === index,
                                )?.response_quote || ""
                              }
                              onChange={(e) => {
                                const rest = (
                                  fulfillment?.qualifier_equivalences || []
                                ).filter(
                                  (q) =>
                                    q.kind !== field ||
                                    q.source_index !== index,
                                );
                                updateResponse(requirement, {
                                  qualifier_equivalences: e.target.value.trim()
                                    ? [
                                        ...rest,
                                        {
                                          kind: field,
                                          source_index: index,
                                          source_quote: qualifier,
                                          source_hash:
                                            qualifierHashes[qualifier],
                                          response_quote: e.target.value,
                                        },
                                      ]
                                    : rest,
                                });
                              }}
                              maxLength={3000}
                            />
                          </label>
                        </div>
                      );
                    },
                  ),
                )}
                {(fulfillment?.facts || []).map((fact, i) => (
                  <fieldset key={i}>
                    <legend>
                      {l("Declared response fact", "حقيقة محددة في الاستجابة")}
                    </legend>
                    {(
                      ["key", "value", "unit", "currency", "quote"] as const
                    ).map((field, j) => (
                      <label key={field}>
                        {
                          [
                            l(
                              "Shared meaning identifier",
                              "اسم المعنى المشترك",
                            ),
                            l(
                              "Value (empty means unknown)",
                              "القيمة (الفراغ يعني غير معروفة)",
                            ),
                            l("Unit", "الوحدة"),
                            l("Currency", "العملة"),
                            l(
                              "Exact wording from response",
                              "النص الحرفي من الاستجابة",
                            ),
                          ][j]
                        }
                        <input
                          value={fact[field] || ""}
                          onChange={(e) =>
                            updateResponse(requirement, {
                              facts: fulfillment!.facts.map((x, n) =>
                                n === i
                                  ? {
                                      ...x,
                                      [field]:
                                        e.target.value ||
                                        (["value", "unit", "currency"].includes(
                                          field,
                                        )
                                          ? null
                                          : ""),
                                    }
                                  : x,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                    <label>
                      {l("Fact type", "نوع الحقيقة")}
                      <select
                        value={fact.kind}
                        onChange={(e) =>
                          updateResponse(requirement, {
                            facts: fulfillment!.facts.map((x, n) =>
                              n === i
                                ? {
                                    ...x,
                                    kind: e.target.value as typeof fact.kind,
                                  }
                                : x,
                            ),
                          })
                        }
                      >
                        {["quantity", "money", "date", "decision"].map((v) => (
                          <option key={v} value={v}>
                            {
                              {
                                quantity: l("Quantity", "كمية"),
                                money: l("Amount", "مبلغ"),
                                date: l("Date", "تاريخ"),
                                decision: l("Shared decision", "قرار مشترك"),
                              }[v]
                            }
                          </option>
                        ))}
                      </select>
                    </label>
                  </fieldset>
                ))}
                <Button
                  onClick={() =>
                    updateResponse(requirement, {
                      facts: [
                        ...(fulfillment?.facts || []),
                        {
                          key: "",
                          kind: "quantity",
                          value: null,
                          unit: null,
                          currency: null,
                          quote: "",
                        },
                      ],
                    })
                  }
                >
                  {l(
                    "Add quantity, amount or date evidence",
                    "إضافة دليل كمية أو مبلغ أو تاريخ",
                  )}
                </Button>
                <label>
                  {l(
                    "Why this response adequately meets the obligation",
                    "لماذا تحقق هذه الاستجابة الالتزام بصورة كافية",
                  )}
                  <textarea
                    value={reviews[requirement.id] || ""}
                    onChange={(e) =>
                      setReviews({
                        ...reviews,
                        [requirement.id]: e.target.value,
                      })
                    }
                    maxLength={3000}
                  />
                </label>
              </fieldset>
            );
          })}
          <h4>
            {l("Pending input and escalation", "المدخلات المعلقة والتصعيد")}
          </h4>
          {body.pending_inputs.map((g) => (
            <p key={g.id}>
              {g.question}{" "}
              <Button
                onClick={() =>
                  edit({
                    ...body,
                    pending_inputs: body.pending_inputs.filter(
                      (x) => x.id !== g.id,
                    ),
                  })
                }
              >
                {l(
                  "Mark input resolved in saved response",
                  "تسجيل معالجة المدخل في الاستجابة المحفوظة",
                )}
              </Button>
            </p>
          ))}
          <label>
            {l(
              "Missing information to request from an authorized person",
              "المعلومات الناقصة المطلوب طلبها من شخص مخول",
            )}
            <textarea
              value={pending}
              onChange={(e) => setPending(e.target.value)}
              maxLength={3000}
            />
          </label>
          <Button
            disabled={!pending.trim()}
            onClick={() => {
              edit({
                ...body,
                pending_inputs: [
                  ...body.pending_inputs,
                  {
                    id: crypto.randomUUID(),
                    question: pending,
                    required_for: "substantive_completion",
                    requirement_ids: [],
                  },
                ],
              });
              setPending("");
            }}
          >
            {l("Save as pending input", "إضافتها إلى المدخلات المعلقة")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run("save", {
                expected_revision: context.session.revision,
                body,
              })
            }
          >
            {l("Save response draft", "حفظ مسودة الاستجابة")}
          </Button>
          <label>
            {l(
              "Complete source inventory review — explain the coverage",
              "مراجعة كامل مصادر المتطلبات — وضّح ما شملته المراجعة",
            )}
            <textarea
              value={coverage}
              onChange={(e) => setCoverage(e.target.value)}
              maxLength={3000}
            />
          </label>
          <label>
            {l("Overall review rationale", "مبرر نتيجة المراجعة")}
            <textarea
              value={reviewReason}
              onChange={(e) => setReviewReason(e.target.value)}
              maxLength={3000}
            />
          </label>
          <Button
            disabled={
              busy ||
              !saved ||
              !coverage.trim() ||
              !reviewReason.trim() ||
              !body.requirements.length ||
              body.requirements.some((r) => !reviews[r.id]?.trim())
            }
            onClick={() =>
              void run("review", {
                expected_revision: context.session.revision,
                reason: reviewReason,
                inventory_review: {
                  source_ids: [
                    ...new Set(
                      (
                        context.source_manifest ||
                        context.snapshot.payload.source_manifest
                      ).map((s) => s.entity_id),
                    ),
                  ],
                  coverage_statement: coverage,
                },
                responses: body.requirements.map((r) => ({
                  requirement_id: r.id,
                  response_excerpt:
                    body.fulfillment.find((f) => f.requirement_id === r.id)
                      ?.response_excerpt || "",
                  rationale: reviews[r.id],
                })),
              })
            }
          >
            {l(
              "Review saved responses against current sources",
              "مراجعة الاستجابات المحفوظة مقابل المصادر الحالية",
            )}
          </Button>
          {report && (
            <div role="status">
              <p>
                {report.substantive_complete
                  ? l(
                      "Substantive responses reviewed. Final approval remains required.",
                      "روجع المحتوى الفعلي للاستجابات. يبقى الاعتماد النهائي مطلوبًا.",
                    )
                  : l(
                      "The draft remains incomplete. Resolve the findings below and review again.",
                      "ما زالت المسودة غير مكتملة. عالج الملاحظات أدناه ثم أعد المراجعة.",
                    )}
              </p>
              {report.diagnostics.map((d, i) => (
                <p key={i}>{d.detail}</p>
              ))}
            </div>
          )}
          {report?.substantive_complete && reviewId && (
            <Button
              disabled={busy || !saved}
              onClick={async () => {
                try {
                  const { data } = await client.request<{ revision: number }>(
                    `/v1/proposals/${context.session.proposal_id}`,
                    { signal: scope.current?.signal },
                  );
                  if (!scope.current?.signal.aborted)
                    await run("adopt", {
                      expected_revision: context.session.revision,
                      expected_proposal_revision: data.revision,
                      review_id: reviewId,
                    });
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {l(
                "Adopt reviewed responses into final review workflow",
                "نقل الاستجابات المراجعة إلى مسار المراجعة النهائية",
              )}
            </Button>
          )}
          {adopted && (
            <p>
              {l(
                "A new proposal version is saved for normal compliance, commercial and final reviews. It is not approved.",
                "حُفظت نسخة جديدة للعرض لاستكمال مراجعة الامتثال والجوانب التجارية والاعتماد النهائي. لم يُعتمد العرض.",
              )}{" "}
              <Link to={`/proposals/${adopted}`}>
                {l("Open proposal review", "فتح مراجعة العرض")}
              </Link>
            </p>
          )}
        </>
      )}
      {busy && <p role="status">{l("Saving…", "جارٍ الحفظ…")}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
