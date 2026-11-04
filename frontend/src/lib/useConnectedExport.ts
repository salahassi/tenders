import { useLayoutEffect, useRef, useState } from "react";
import type { BackendClient } from "./backendClient";
import {
  createConnectedExport,
  retryConnectedExport,
  ExportPackageBlockedError,
  type DurableExportPackage,
} from "./connectedExport";

export function useConnectedExport(
  client: BackendClient | null | undefined,
  afterDownload?: () => void | Promise<void>,
  onError?: (message: string) => void,
  scope?: string,
) {
  const active = useRef<AbortController | null>(null),
    complete = useRef(afterDownload);
  complete.current = afterDownload;
  const failed = useRef(onError);
  failed.current = onError;
  const [busy, setBusy] = useState(false),
    [versionId, setVersionId] = useState<string | null>(null),
    [saved, setSaved] = useState<DurableExportPackage | null>(null),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false);
  useLayoutEffect(() => {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setVersionId(null);
    setSaved(null);
    setError("");
    setPaused(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [client, scope]);
  async function execute(
    version: string,
    mode: "draft" | "final",
    retry?: DurableExportPackage,
  ) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setVersionId(version);
    setSaved(null);
    setError("");
    setPaused(false);
    try {
      if (!client)
        throw Error(
          "The workspace connection is unavailable. Refresh and try again.",
        );
      const options = {
        signal: controller.signal,
        onProgress: (value: DurableExportPackage) => {
          if (!controller.signal.aborted) setSaved(value);
        },
      };
      if (retry) await retryConnectedExport(client, retry, options);
      else await createConnectedExport(client, version, mode, options);
      if (!controller.signal.aborted) await complete.current?.();
    } catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof ExportPackageBlockedError) setSaved(e.saved);
        const message =
          e instanceof Error
            ? e.message
            : "The saved export could not be downloaded.";
        setError(message);
        failed.current?.(message);
      }
    } finally {
      if (active.current === controller && !controller.signal.aborted) {
        setBusy(false);
        active.current = null;
      }
    }
  }
  function stopWaiting() {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setPaused(true);
  }
  return {
    busy,
    versionId,
    saved,
    error,
    paused,
    start: (version: string, mode: "draft" | "final") => execute(version, mode),
    retry: () =>
      saved
        ? execute(saved.proposal_version_id, saved.mode, saved)
        : Promise.resolve(),
    stopWaiting,
  };
}
export type ConnectedExportFlow = ReturnType<typeof useConnectedExport>;
