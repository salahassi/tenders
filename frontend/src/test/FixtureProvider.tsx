// Test-only provider: never imported by the application entry point.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { get, set } from "idb-keyval";
import type { AppState, StateMutation } from "../types";
import { createSeedState } from "./fixtures/workspace";
import { clearLocalFiles } from "../lib/knowledgeFiles";
import { AppContext } from "../lib/appContext";
import { validateState } from "../lib/legacyBackup";
import {
  canApplyMutation,
  getApprovalBlockers,
  invalidateChangedApprovals,
} from "../lib/domain";
export const STORAGE_KEY = "tender-desk-demo-state-v1";

const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown browser storage error";

export function FixtureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => createSeedState());
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const notify = useCallback((message: string) => setToast(message), []);
  const clearToast = useCallback(() => setToast(null), []);
  const persist = useCallback((next: AppState) => {
    const snapshot = structuredClone(next);
    writes.current = writes.current.then(async () => {
      try {
        await set(STORAGE_KEY, snapshot);
        setStorageError(null);
      } catch (error) {
        setStorageError(
          `Your changes could not be saved in this browser. Keep this tab open and export a backup. ${messageFor(error)}`,
        );
      }
    });
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const saved = await get<unknown>(STORAGE_KEY);
        if (!active) return;
        if (saved !== undefined) {
          const restored = validateState(saved);
          stateRef.current = restored;
          setState(restored);
        } else persist(stateRef.current);
      } catch (error) {
        if (active)
          setStorageError(
            `Saved data could not be loaded. The demo is available in memory; existing browser data was not replaced. ${messageFor(error)}`,
          );
      } finally {
        if (active) setReady(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [persist]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const update = useCallback(
    async (
      mutation: StateMutation,
      action?: string,
      target?: string,
    ): Promise<boolean> => {
      if (!ready) {
        notify("Please wait for your saved workspace to load.");
        return false;
      }
      const previous = stateRef.current;
      let next: AppState;
      try {
        next = validateState(
          invalidateChangedApprovals(
            previous,
            mutation(structuredClone(previous)),
          ),
        );
      } catch (error) {
        notify(`The change could not be applied: ${messageFor(error)}`);
        return false;
      }
      if (!canApplyMutation(previous, next)) {
        notify("Your current demo role cannot perform this action.");
        return false;
      }
      for (const proposal of next.proposals) {
        const before = previous.proposals.find(
          (item) => item.id === proposal.id,
        );
        if (
          proposal.status === "approved" &&
          (before?.status !== "approved" ||
            before.approvalVersion !== proposal.approvalVersion)
        ) {
          const blockers = getApprovalBlockers(next, proposal);
          if (
            proposal.approvalVersion !== proposal.version ||
            blockers.length
          ) {
            notify(
              `Approval blocked: ${blockers[0] ?? "The approved version must match the current content version."}`,
            );
            return false;
          }
        }
      }
      if (action)
        next = {
          ...next,
          audit: [
            {
              id: crypto.randomUUID(),
              action,
              target: target ?? "Workspace",
              at: new Date().toISOString(),
              actor: `Demo ${previous.settings.role}`,
            },
            ...next.audit,
          ].slice(0, 10000),
        };
      stateRef.current = next;
      setState(next);
      persist(next);
      return true;
    },
    [notify, persist, ready],
  );

  const reset = useCallback(async () => {
    if (!ready) return;
    if (stateRef.current.settings.role !== "Owner") {
      notify("Only the demo Owner can reset this workspace.");
      return;
    }
    try {
      await clearLocalFiles();
    } catch (error) {
      notify(
        `Workspace reset could not remove local files: ${messageFor(error)}`,
      );
      return;
    }
    const next = createSeedState();
    stateRef.current = next;
    setState(next);
    persist(next);
    notify("The synthetic demo workspace has been reset.");
  }, [notify, persist, ready]);

  const restore = useCallback(
    (backup: AppState) => {
      if (!ready) return;
      if (stateRef.current.settings.role !== "Owner") {
        notify("Only the demo Owner can restore a backup.");
        return;
      }
      try {
        const next = validateState(backup);
        for (const proposal of next.proposals)
          if (
            proposal.status === "approved" &&
            getApprovalBlockers(next, proposal).length
          )
            throw new Error(
              "An approved backup proposal still contains unresolved blockers.",
            );
        next.audit = [
          {
            id: crypto.randomUUID(),
            action: "Demo backup restored",
            target: "Validated local backup",
            at: new Date().toISOString(),
            actor: "Demo Owner",
          },
          ...next.audit,
        ].slice(0, 10000);
        stateRef.current = next;
        setState(next);
        persist(next);
        notify("Your demo backup has been restored.");
      } catch (error) {
        notify(`Backup could not be restored: ${messageFor(error)}`);
      }
    },
    [notify, persist, ready],
  );

  return (
    <AppContext.Provider
      value={{
        state,
        update,
        reset,
        restore,
        ready,
        storageError,
        notify,
        toast,
        clearToast,
        mode: "DEMO",
        saving: false,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
