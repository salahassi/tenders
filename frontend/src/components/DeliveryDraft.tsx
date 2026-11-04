import { useLayoutEffect, useRef, useState } from "react";
import type { BackendClient } from "../lib/backendClient";
import {
  downloadDeliveryPackage,
  type DeliveryPackage,
} from "../lib/deliveryDownload";
import { Button } from "./ui";
import ProposalAuthoring from "./ProposalAuthoring";

export default function DeliveryDraft({
  client,
  snapshotId: initialSnapshotId,
}: {
  client: BackendClient;
  snapshotId: string;
}) {
  const [snapshotId, setSnapshotId] = useState(initialSnapshotId);
  const [authoring, setAuthoring] = useState(false);
  const [authoringStart, setAuthoringStart] = useState<{
    snapshotId: string;
    deliveryRevision: number;
    ar: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    setSnapshotId(initialSnapshotId);
    setAuthoring(false);
  }, [initialSnapshotId]);
  const [saved, setSaved] = useState<DeliveryPackage | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const scope = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSaved(null);
    setError("");
    setDownloaded(false);
    setBusy(false);
    const load = async () => {
      try {
        const { data } = await client.request<DeliveryPackage>(
          `/v1/delivery-snapshots/${snapshotId}/package`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (data.snapshot.id !== snapshotId)
          throw new Error(
            "The saved draft response does not match the selected version.",
          );
        setSaved(data);
        if (data.status === "preparing")
          timer = setTimeout(() => void load(), 5000);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The saved draft could not be loaded.",
          );
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (scope.current === controller) scope.current = null;
    };
  }, [client, snapshotId, attempt]);
  const ar = saved?.snapshot.language === "ar";
  const l = (en: string, arabic: string) => (ar ? arabic : en);
  return (
    <section
      className="panel"
      aria-label={l("Saved proposal draft", "مسودة العرض المحفوظة")}
      dir={ar ? "rtl" : undefined}
    >
      <h2>{l("Saved proposal draft", "مسودة العرض المحفوظة")}</h2>
      {saved && (
        <>
          <p>
            {l(
              `Draft ${saved.snapshot.ordinal} · ${saved.snapshot.gap_count} unresolved inputs`,
              `المسودة ${saved.snapshot.ordinal} · ${saved.snapshot.gap_count} مدخلات غير مكتملة`,
            )}
          </p>
          <p>
            {saved.snapshot.substantive_complete
              ? l(
                  "Substantive responses have a current human review. The draft still requires final approval before external use.",
                  "خضعت الاستجابات الفعلية لمراجعة بشرية مرتبطة بالمصادر الحالية. تحتاج المسودة إلى اعتماد نهائي قبل استخدامها خارجيًا.",
                )
              : saved.snapshot.input_state === "insufficient"
                ? l(
                    "Available scope information is insufficient. Missing inputs are highlighted yellow in the saved template.",
                    "معلومات النطاق المتاحة غير كافية. مواضع التعبئة الناقصة مظللة بالأصفر في القالب المحفوظ.",
                  )
                : l(
                    "Available source content and accepted progress are saved. The response is still incomplete; missing inputs are highlighted yellow. Model processing status is tracked separately.",
                    "حُفظ محتوى المصدر المتاح والتقدم المقبول. الاستجابة ما زالت غير مكتملة، والمدخلات الناقصة مظللة بالأصفر. تُعرض حالة معالجة النماذج بصورة مستقلة.",
                  )}
          </p>
          {Number.isSafeInteger(saved.snapshot.delivery_revision) &&
            !authoring && (
              <Button
                onClick={() => {
                  setAuthoringStart({
                    snapshotId,
                    deliveryRevision: saved.snapshot.delivery_revision!,
                    ar,
                  });
                  setAuthoring(true);
                }}
              >
                {l(
                  "Write and review the responses",
                  "كتابة الاستجابات ومراجعتها",
                )}
              </Button>
            )}

          {saved.status === "preparing" && (
            <p role="status">
              {l(
                "Preparing the saved Word file. You can close this page and return later.",
                "يجري إعداد ملف Word المحفوظ. يمكنك إغلاق الصفحة والعودة لاحقًا.",
              )}
            </p>
          )}
          {saved.status === "blocked" && (
            <p role="alert">
              {l(
                "Draft delivery needs attention. Saved content is retained; this does not mean the RFP is invalid.",
                "تسليم المسودة يحتاج إلى معالجة. المحتوى المحفوظ باقٍ؛ هذا لا يعني أن طلب تقديم العروض غير صالح.",
              )}
            </p>
          )}
          {saved.status === "blocked" &&
            Number.isSafeInteger(saved.snapshot.delivery_revision) && (
              <Button
                disabled={busy}
                onClick={async () => {
                  const controller = scope.current;
                  if (!controller || controller.signal.aborted) return;
                  const current = () =>
                    scope.current === controller && !controller.signal.aborted;
                  setBusy(true);
                  setError("");
                  try {
                    await client.request("/v1/commands", {
                      method: "POST",
                      idempotencyKey: crypto.randomUUID(),
                      signal: controller.signal,
                      body: {
                        commands: [
                          {
                            operation: "delivery.snapshot.retry",
                            input: {
                              snapshot_id: snapshotId,
                              expected_delivery_revision:
                                saved.snapshot.delivery_revision,
                            },
                          },
                        ],
                      },
                    });
                    if (current()) setAttempt((value) => value + 1);
                  } catch (failure) {
                    if (current())
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "Draft preparation could not resume.",
                      );
                  } finally {
                    if (current()) setBusy(false);
                  }
                }}
              >
                {l("Retry draft preparation", "إعادة محاولة إعداد المسودة")}
              </Button>
            )}
          <Button
            disabled={saved.status !== "ready" || busy}
            onClick={async () => {
              const controller = scope.current;
              if (!controller || controller.signal.aborted) return;
              const current = () =>
                scope.current === controller && !controller.signal.aborted;
              setBusy(true);
              setError("");
              setDownloaded(false);
              try {
                await downloadDeliveryPackage(client, saved, controller.signal);
                if (current()) setDownloaded(true);
              } catch (failure) {
                if (current())
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Draft download failed.",
                  );
              } finally {
                if (current()) setBusy(false);
              }
            }}
          >
            {busy
              ? l("Downloading…", "جارٍ التنزيل…")
              : l("Download saved draft", "تنزيل المسودة المحفوظة")}
          </Button>
          {downloaded && (
            <p role="status">
              {l(
                "Draft downloads started. Review all files before external use.",
                "بدأ تنزيل ملفات المسودة. راجع جميع الملفات قبل الاستخدام الخارجي.",
              )}
            </p>
          )}
        </>
      )}
      {!saved && !error && (
        <p role="status">
          {l("Loading saved draft…", "تحميل المسودة المحفوظة…")}
        </p>
      )}
      {authoring && authoringStart && (
        <ProposalAuthoring
          client={client}
          {...authoringStart}
          onPublished={setSnapshotId}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {(error || saved?.status === "blocked") && (
        <Button onClick={() => setAttempt((value) => value + 1)}>
          {l("Refresh saved draft status", "تحديث حالة المسودة المحفوظة")}
        </Button>
      )}
    </section>
  );
}
