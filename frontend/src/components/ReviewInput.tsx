import { useContext, useEffect, useRef, useState } from "react";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { AppContext } from "../lib/appContext";
import { downloadOriginal } from "../lib/remoteFiles";
import type { DocumentRecord } from "../types";
import { getLocalFile } from "../lib/knowledgeFiles";
import {
  attachReviewFile,
  MAX_REVIEW_ATTACHMENTS,
  REVIEW_ATTACHMENT_ACCEPT,
} from "../lib/reviewAttachments";
import { Button } from "./ui";
import "./review-input.css";

export interface ReviewInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  attachments: DocumentRecord[];
  onAttachmentsChange: (files: DocumentRecord[]) => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  rows?: number;
  onBusyChange?: (busy: boolean) => void;
}

function attachmentStatus(file: DocumentRecord) {
  if (file.status === "ready") return "Original attached · text available";
  if (file.status === "needs_ocr")
    return "Original attached · OCR or text review needed";
  if (file.status === "needs_processing")
    return "Original attached · requires processing";
  return "Original attached · text extraction failed";
}

export default function ReviewInput(props: ReviewInputProps) {
  const app = useContext(AppContext);
  const {
    id,
    label,
    value,
    attachments,
    disabled = false,
    readOnly = false,
    placeholder,
    rows = 3,
  } = props;
  const current = useRef(props);
  current.current = props;
  const mounted = useRef(true);
  const uploading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [uploadingName, setUploadingName] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [originalsAvailable, setOriginalsAvailable] = useState<
    Record<string, boolean>
  >({});
  const attachmentIds = JSON.stringify(attachments.map((file) => file.id));
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(attachmentIds) as string[];
    void Promise.all(
      ids.map(async (fileId) => {
        try {
          return [
            fileId,
            !!attachments.find((d) => d.id === fileId)?.persisted ||
              !!(await getLocalFile(fileId)),
          ] as const;
        } catch {
          return [fileId, false] as const;
        }
      }),
    ).then((entries) => {
      if (active) setOriginalsAvailable(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [attachmentIds]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (uploading.current) current.current.onBusyChange?.(false);
    };
  }, []);

  async function upload(files: File[]) {
    if (
      !files.length ||
      uploading.current ||
      current.current.disabled ||
      current.current.readOnly
    )
      return;
    const remaining =
      MAX_REVIEW_ATTACHMENTS - current.current.attachments.length;
    if (files.length > remaining) {
      setErrors([
        `You can attach ${MAX_REVIEW_ATTACHMENTS} files per input. Choose ${Math.max(remaining, 0)} or fewer additional files.`,
      ]);
      return;
    }
    uploading.current = true;
    setBusy(true);
    setErrors([]);
    setAnnouncement("");
    current.current.onBusyChange?.(true);
    let added = 0;
    try {
      for (const file of files) {
        if (!mounted.current) break;
        setUploadingName(file.name);
        try {
          const document = await attachReviewFile(file);
          if (!mounted.current) break;
          // The callback and attachments may have changed while extracting.
          // Read the latest props so typing in another field is never undone.
          const next = [...current.current.attachments, document];
          current.current = { ...current.current, attachments: next };
          current.current.onAttachmentsChange(next);
          added++;
        } catch (error) {
          if (mounted.current)
            setErrors((previous) => [
              ...previous,
              `${file.name}: ${error instanceof Error ? error.message : "The file could not be attached. Try again."}`,
            ]);
        }
      }
    } finally {
      uploading.current = false;
      if (mounted.current) {
        setBusy(false);
        setUploadingName("");
        setAnnouncement(
          added
            ? `${added} file${added === 1 ? "" : "s"} attached. Text is optional.`
            : "No files were attached.",
        );
        current.current.onBusyChange?.(false);
      }
    }
  }

  async function download(file: DocumentRecord) {
    try {
      await downloadOriginal(
        file.persisted ? app?.backend : undefined,
        file.id,
        file.name,
      );
    } catch (error) {
      if (mounted.current)
        setErrors([
          `${file.name}: ${error instanceof Error ? error.message : "The original could not be downloaded."}`,
        ]);
    }
  }

  function remove(file: DocumentRecord) {
    if (
      uploading.current ||
      current.current.disabled ||
      current.current.readOnly
    )
      return;
    const next = current.current.attachments.filter(
      (item) => item.id !== file.id,
    );
    current.current = { ...current.current, attachments: next };
    current.current.onAttachmentsChange(next);
    setAnnouncement(`${file.name} removed from this input.`);
    // Do not delete the original: a saved review/request may still reference it.
  }

  return (
    <div className="review-input" role="group" aria-label={label}>
      <label className="review-input-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => current.current.onChange(event.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        rows={rows}
        placeholder={placeholder}
        dir="auto"
        aria-describedby={`${id}-hint`}
      />
      <p className="review-input-hint" id={`${id}-hint`}>
        Write a response, attach files, or do both.
      </p>
      {!readOnly && (
        <div className="review-input-upload">
          <label htmlFor={`${id}-files`}>
            <Paperclip size={15} aria-hidden="true" /> Attach files{" "}
            <span>(optional)</span>
          </label>
          <input
            id={`${id}-files`}
            aria-label={`Attach files to ${label}`}
            aria-describedby={`${id}-formats${errors.length ? ` ${id}-errors` : ""}`}
            type="file"
            multiple
            accept={REVIEW_ATTACHMENT_ACCEPT}
            disabled={
              disabled || busy || attachments.length >= MAX_REVIEW_ATTACHMENTS
            }
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = "";
              void upload(files);
            }}
          />
          <p id={`${id}-formats`} className="review-input-hint">
            PDF, DOCX, TXT, MD, CSV, PNG, JPG, WEBP, XLSX, or PPTX · up to 10
            MiB each · {attachments.length}/{MAX_REVIEW_ATTACHMENTS} files
            attached.
          </p>
        </div>
      )}
      {busy && (
        <p className="review-input-progress" role="status">
          Attaching <bdi>{uploadingName}</bdi>… Your text remains editable.
        </p>
      )}
      {!!attachments.length && (
        <ul className="review-input-files" aria-label={`Files for ${label}`}>
          {attachments.map((file) => (
            <li key={file.id}>
              <div className="review-input-file-info">
                <strong dir="auto">{file.name}</strong>
                <span>{attachmentStatus(file)}</span>
                <small>
                  {file.size < 1024 * 1024
                    ? `${Math.ceil(file.size / 1024)} KiB`
                    : `${(file.size / 1024 / 1024).toFixed(1)} MiB`}
                </small>
                {originalsAvailable[file.id] === false && (
                  <span className="review-input-original-missing">
                    Original unavailable in this browser. Attach it again if the
                    original is needed.
                  </span>
                )}
              </div>
              <div className="review-input-file-actions">
                <Button
                  size="sm"
                  onClick={() => void download(file)}
                  aria-label={`Download ${file.name}`}
                >
                  <Download size={14} aria-hidden="true" /> Download
                </Button>
                {!readOnly && (
                  <Button
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => remove(file)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {attachments.some((file) => file.status !== "ready") && (
        <p className="review-input-file-notice">
          Files marked for processing are attached, but their contents have not
          been fully read. They do not resolve a question until processed and
          reviewed.
        </p>
      )}
      {!!errors.length && (
        <div className="review-input-errors" id={`${id}-errors`} role="alert">
          <ul>
            {errors.map((error, index) => (
              <li key={`${index}-${error}`} dir="auto">
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}
