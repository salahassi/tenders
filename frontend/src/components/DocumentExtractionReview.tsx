import { useLayoutEffect, useRef, useState } from "react";
import {
  BackendRequestError,
  type BackendClient,
  type DocumentExtractionCorrection,
  type DocumentExtractionReviewData,
} from "../lib/backendClient";
import { Button, Field } from "./ui";
import VerifiedPdfPage from "./VerifiedPdfPage";
import "./DocumentExtractionReview.css";

type PageEdit = { text: string; reviewed: boolean; blank: boolean };
async function boundedPdf(response: Response) {
  const maximum = 10485760;
  if (
    Number(response.headers.get("content-length")) > maximum ||
    !response.body
  )
    throw new Error(
      "The original PDF exceeds the preview limit or has no readable body.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum)
        throw new Error("The original PDF exceeds the preview limit.");
      chunks.push(value);
    }
  } catch (failure) {
    await reader.cancel().catch(() => {});
    throw failure;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
    throw new Error("The original is not a readable PDF.");
  return bytes.buffer;
}
export default function DocumentExtractionReview({
  client,
  documentId,
  canEdit,
  language = "en",
  onPublished,
}: {
  client: BackendClient;
  documentId: string;
  canEdit: boolean;
  language?: "en" | "ar";
  onPublished?: (successorId: string) => void;
}) {
  const [data, setData] = useState<DocumentExtractionReviewData | null>(null);
  const [edits, setEdits] = useState<Record<number, PageEdit>>({});
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState("");
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [load, setLoad] = useState(0);
  const scope = useRef<AbortController | null>(null);
  const correction = useRef<{ body: string; key: string } | null>(null);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const ar = language === "ar";
  const l = (en: string, arabic: string) => (ar ? arabic : en);
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    let objectUrl = "";
    setData(null);
    setEdits({});
    setPreview("");
    setPdfBytes(null);
    setRenderedPage(null);
    setError("");
    setNotice("");
    setBusy(false);
    correction.current = null;
    retry.current = null;
    void (async () => {
      try {
        const next = await client.documentExtraction(
          documentId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          next.document_id !== documentId ||
          !next.pages.length ||
          next.pages.length !== next.pdf_pages ||
          new Set(next.pages.map((p) => p.page)).size !== next.pdf_pages ||
          next.pages.some(
            (p) =>
              !Number.isInteger(p.page) ||
              p.page < 1 ||
              p.page > next.pdf_pages,
          )
        )
          throw new Error(
            "The source page response does not match this document.",
          );
        setData(next);
        setEdits(
          Object.fromEntries(
            next.pages.map((p) => [
              p.page,
              {
                text: p.candidate_text ?? p.text,
                reviewed: false,
                blank: false,
              },
            ]),
          ),
        );
        setPage(
          next.pages.find((p) => p.requires_review)?.page ?? next.pages[0].page,
        );
        const url = new URL(next.original_download_url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !(Date.parse(next.original_download_expires_at) > Date.now())
        )
          throw new Error(
            "The original preview link is unavailable. Reload the source.",
          );
        const previewController = new AbortController();
        const abortPreview = () => previewController.abort();
        controller.signal.addEventListener("abort", abortPreview, {
          once: true,
        });
        const timeout = setTimeout(abortPreview, 30000);
        let bytes: ArrayBuffer;
        try {
          const response = await fetch(url, {
            signal: previewController.signal,
            redirect: "error",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok)
            throw new Error("The original PDF could not be loaded.");
          bytes = await boundedPdf(response);
        } catch (failure) {
          if (previewController.signal.aborted && !controller.signal.aborted)
            throw new Error(
              language === "ar"
                ? "انتهت مهلة تحميل الأصل. أعد التحميل للمحاولة مجددًا."
                : "Loading the original timed out. Reload the source to try again.",
            );
          throw failure;
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abortPreview);
        }
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== next.original_hash)
          throw new Error(
            "The original PDF changed. Reload the source before reviewing.",
          );
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
        setPreview(objectUrl);
        setPdfBytes(bytes);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The source could not be loaded.",
          );
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (scope.current === controller) scope.current = null;
    };
  }, [client, documentId, load]);
  const selected = data?.pages.find((p) => p.page === page);
  const edit = edits[page];
  const reviewed = data?.pages.filter((p) => edits[p.page]?.reviewed) ?? [];
  const ready =
    !!preview &&
    canEdit &&
    reviewed.length > 0 &&
    reviewed.every((p) => edits[p.page].text.trim() || edits[p.page].blank);
  const change = (patch: Partial<PageEdit>) =>
    setEdits((current) => ({
      ...current,
      [page]: { ...current[page], ...patch },
    }));
  async function save() {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || !data || !ready || busy)
      return;
    const current = () =>
      scope.current === controller && !controller.signal.aborted;
    const input: DocumentExtractionCorrection = {
      id: documentId,
      expected_revision: data.document_revision,
      expected_original_hash: data.original_hash,
      expected_extraction_hash: data.extraction_hash,
      review_confirmed: true,
      pages: reviewed.map((p) => ({
        page: p.page,
        expected_page_text_hash: p.text_hash,
        text: edits[p.page].text.trim(),
        blank_confirmed: edits[p.page].blank,
      })),
    };
    const body = JSON.stringify(input);
    if (correction.current?.body !== body)
      correction.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await client.correctDocumentExtraction(
        input,
        correction.current.key,
        controller.signal,
      );
      if (!current()) return;
      setNotice(
        l(
          "Reviewed pages were saved. A new extraction is being prepared; the original and earlier proposals remain in history.",
          "حُفظت الصفحات التي راجعتها. يجري إعداد نسخة استخراج جديدة، مع الاحتفاظ بالأصل والعروض السابقة في السجل.",
        ),
      );
      setEdits((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([number, value]) => [
            number,
            { ...value, reviewed: false },
          ]),
        ),
      );
    } catch (failure) {
      if (current())
        setError(
          failure instanceof BackendRequestError &&
            ["STALE_INPUT", "REVISION_CONFLICT", "SOURCE_SPAN_STALE"].includes(
              failure.code,
            )
            ? l(
                "The source changed. Your edits are still here. Reload the current source before submitting again.",
                "تغير المصدر. تعديلاتك ما زالت ظاهرة؛ أعد تحميل المصدر الحالي قبل إرسالها مجددًا.",
              )
            : failure instanceof Error
              ? failure.message
              : l(
                  "Reviewed pages could not be saved.",
                  "تعذر حفظ الصفحات المراجعة.",
                ),
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section
      className="extraction-review"
      dir={ar ? "rtl" : undefined}
      aria-label={l(
        "Review original PDF and extracted pages",
        "مراجعة أصل الملف والصفحات المستخرجة",
      )}
    >
      <p>
        {l(
          "Compare each selected page with the original. Correct missing words, numbers, conditions and prohibitions before confirming. Recognition confidence does not prove accuracy.",
          "قارن كل صفحة تختارها بالأصل، وصحح الكلمات والأرقام والشروط والنفي قبل تأكيدها. درجة ثقة القراءة لا تثبت صحتها.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && (
        <p role="status">
          {l("Loading source pages…", "جارٍ تحميل صفحات المصدر…")}
        </p>
      )}
      <Button disabled={busy} onClick={() => setLoad((n) => n + 1)}>
        {l(
          "Reload source (discard unsaved edits)",
          "إعادة تحميل المصدر وإلغاء التعديلات غير المحفوظة",
        )}
      </Button>
      {data && (
        <>
          <p>
            {l(
              `${data.ocr.completed_pages} of ${data.ocr.total_pages} pages processed. Unreviewed pages remain unresolved.`,
              `عولجت ${data.ocr.completed_pages} من ${data.ocr.total_pages} صفحات. الصفحات غير المراجعة ما زالت بحاجة إلى تحقق.`,
            )}
          </p>
          {data.ocr.status === "blocked" && (
            <p role="alert">
              {l(
                "Automatic reading needs attention. This does not mean the original RFP is invalid.",
                "القراءة الآلية تحتاج إلى معالجة؛ هذا لا يعني أن أصل طلب تقديم العروض غير صالح.",
              )}
            </p>
          )}
          {["queued", "running", "retry_wait"].includes(
            data.ocr.status ?? "",
          ) && (
            <p role="status">
              {l(
                "Automatic reading is pending. Reload later to see its saved result.",
                "القراءة الآلية قيد المعالجة. أعد التحميل لاحقًا للاطلاع على نتيجتها المحفوظة.",
              )}
            </p>
          )}
          {data.ocr.successor_id && onPublished && (
            <Button onClick={() => onPublished(data.ocr.successor_id!)}>
              {l("Open newer extraction", "فتح نسخة الاستخراج الأحدث")}
            </Button>
          )}
          {canEdit && data.ocr.status === "blocked" && (
            <Button
              disabled={busy}
              onClick={async () => {
                const controller = scope.current;
                if (!controller || controller.signal.aborted) return;
                const current = () =>
                  scope.current === controller && !controller.signal.aborted;
                const input = {
                  id: documentId,
                  expected_revision: data.document_revision,
                };
                const body = JSON.stringify(input);
                if (retry.current?.body !== body)
                  retry.current = { body, key: crypto.randomUUID() };
                setBusy(true);
                setError("");
                try {
                  await client.request("/v1/commands", {
                    method: "POST",
                    signal: controller.signal,
                    idempotencyKey: retry.current.key,
                    body: {
                      commands: [{ operation: "document.ocr.retry", input }],
                    },
                  });
                  if (current())
                    setNotice(
                      l(
                        "Reading retry was queued. Your unsaved edits are retained.",
                        "أُضيفت إعادة القراءة إلى قائمة المعالجة. تعديلاتك غير المحفوظة ما زالت ظاهرة.",
                      ),
                    );
                } catch (failure) {
                  if (current())
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Reading could not resume.",
                    );
                } finally {
                  if (current()) setBusy(false);
                }
              }}
            >
              {l("Retry automatic reading", "إعادة محاولة القراءة الآلية")}
            </Button>
          )}
          <Field label={l("Page to review", "الصفحة المراد مراجعتها")}>
            <select
              value={page}
              disabled={busy}
              onChange={(e) => setPage(Number(e.target.value))}
            >
              {data.pages.map((p) => (
                <option key={p.page} value={p.page}>
                  {l(`Page ${p.page}`, `الصفحة ${p.page}`)}
                  {edits[p.page]?.reviewed ? " ✓" : ""}
                </option>
              ))}
            </select>
          </Field>
          <div className="extraction-review-grid">
            <div>
              {preview && pdfBytes ? (
                <>
                  <VerifiedPdfPage
                    title={l(
                      `Original PDF page ${page}`,
                      `أصل الملف، الصفحة ${page}`,
                    )}
                    bytes={pdfBytes}
                    page={page}
                    language={language}
                    onReady={setRenderedPage}
                  />
                  <a
                    href={`${preview}#page=${page}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {l(
                      "Open original PDF in a separate tab",
                      "فتح أصل الملف في تبويب مستقل",
                    )}
                  </a>
                </>
              ) : (
                <p>
                  {l(
                    "The verified original must load before a page can be confirmed.",
                    "يجب تحميل الأصل والتحقق منه قبل تأكيد أي صفحة.",
                  )}
                </p>
              )}
            </div>
            {selected && edit && (
              <div>
                <Field
                  label={l(
                    `Full text of page ${page}`,
                    `النص الكامل للصفحة ${page}`,
                  )}
                >
                  <textarea
                    dir="auto"
                    maxLength={20000}
                    value={edit.text}
                    disabled={!canEdit || busy}
                    onChange={(e) =>
                      change({
                        text: e.target.value,
                        reviewed: false,
                        blank: false,
                      })
                    }
                  />
                </Field>
                {!edit.text.trim() && (
                  <label>
                    <input
                      type="checkbox"
                      checked={edit.blank}
                      disabled={
                        !canEdit || !preview || renderedPage !== page || busy
                      }
                      onChange={(e) =>
                        change({ blank: e.target.checked, reviewed: false })
                      }
                    />
                    {l(
                      "I checked the original: this page is genuinely blank.",
                      "تحققت من الأصل: هذه الصفحة فارغة فعلًا.",
                    )}
                  </label>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={edit.reviewed}
                    disabled={
                      !canEdit ||
                      !preview ||
                      renderedPage !== page ||
                      busy ||
                      (!edit.text.trim() && !edit.blank)
                    }
                    onChange={(e) => change({ reviewed: e.target.checked })}
                  />
                  {l(
                    "I compared the entire page with the original and confirmed this text.",
                    "قارنت الصفحة كاملة بالأصل وتحققت من صحة هذا النص.",
                  )}
                </label>
                {edit.reviewed && (
                  <p>
                    {l(
                      "This page is selected for saving. Editing its text requires confirmation again.",
                      "هذه الصفحة محددة للحفظ. تعديل نصها يستلزم تأكيدها مجددًا.",
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
          {canEdit && (
            <Button
              variant="primary"
              disabled={!ready || busy}
              onClick={() => void save()}
            >
              {l(
                `Save ${reviewed.length} reviewed pages as a new extraction`,
                `حفظ ${reviewed.length} صفحات مراجعة في نسخة استخراج جديدة`,
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
