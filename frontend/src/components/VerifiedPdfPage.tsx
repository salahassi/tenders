import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

/** Render only already hash-verified bytes; browser PDF plugins are not required. */
export default function VerifiedPdfPage({
  bytes,
  page,
  title,
  onReady,
  language,
}: {
  bytes: ArrayBuffer;
  page: number;
  title: string;
  language: "en" | "ar";
  onReady: (page: number | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    let render: RenderTask | undefined;
    setError("");
    setReady(false);
    onReady(null);
    const fail = () => {
      if (cancelled) return;
      setError(
        language === "ar"
          ? "تعذر عرض الصفحة. أعد تحميل المصدر قبل تأكيد مراجعتها."
          : "The page could not be displayed. Reload the source before confirming review.",
      );
      onReady(null);
    };
    const timer = setTimeout(() => {
      fail();
      cancelled = true;
      render?.cancel();
      void loading?.destroy();
    }, 30000);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loading = pdfjs.getDocument({
          data: bytes.slice(0),
          enableXfa: false,
          stopAtErrors: true,
          canvasMaxAreaInBytes: 32 * 1024 * 1024,
        });
        loading.onPassword = () => {
          fail();
          void loading?.destroy();
        };
        const pdf = await loading.promise;
        if (cancelled) return;
        if (pdf.numPages > 200 || page < 1 || page > pdf.numPages)
          throw new Error("PDF_PAGE_MISMATCH");
        const source = await pdf.getPage(page);
        if (cancelled || !canvas.current) return;
        const original = source.getViewport({ scale: 1 });
        const viewport = source.getViewport({
          scale: Math.min(2, 1800 / Math.max(original.width, original.height)),
        });
        if (
          !Number.isFinite(viewport.width + viewport.height) ||
          viewport.width <= 0 ||
          viewport.height <= 0
        )
          throw new Error("PDF_PAGE_INVALID");
        const target = canvas.current;
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        render = source.render({ canvas: target, viewport });
        await render.promise;
        if (cancelled) return;
        clearTimeout(timer);
        setReady(true);
        onReady(page);
      } catch {
        fail();
        clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      render?.cancel();
      void loading?.destroy();
    };
  }, [bytes, page, language, onReady]);
  return (
    <>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        !ready && (
          <p role="status">
            {language === "ar"
              ? "جارٍ عرض الصفحة الأصلية…"
              : "Displaying the original page…"}
          </p>
        )
      )}
      <label>
        {language === "ar" ? "تكبير الصفحة الأصلية" : "Original page zoom"}
        <select
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        >
          {[1, 1.5, 2, 3].map((value) => (
            <option key={value} value={value}>
              {value * 100}%
            </option>
          ))}
        </select>
      </label>
      <div className="extraction-original-scroll" tabIndex={ready ? 0 : -1}>
        <canvas
          ref={canvas}
          title={title}
          role="img"
          aria-label={title}
          hidden={!ready}
          style={{ width: `${zoom * 100}%` }}
        />
      </div>
    </>
  );
}
