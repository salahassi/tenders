import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { get, set } from "idb-keyval";
import { z } from "zod";
import type { AppState, StateMutation } from "../types";
import { createSeedState } from "./seed";
import {
  canApplyMutation,
  getApprovalBlockers,
  invalidateChangedApprovals,
} from "./domain";

export const STORAGE_KEY = "tender-desk-demo-state-v1";
const text = z.string().max(2_000_000),
  id = z.string().min(1).max(200);
const date = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date");
const count = z.number().int().nonnegative();
const optionalHttpsUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an HTTPS URL without embedded credentials");
const requirement = z.object({
  id,
  text,
  source: text,
  mandatory: z.boolean(),
  status: z.enum(["open", "addressed", "not_applicable"]),
  response: text,
});
const gap = z.object({
  id,
  question: text,
  answer: text,
  required: z.boolean(),
});
const documentRecord = z.object({
  id,
  name: text,
  size: count.max(10 * 1024 * 1024),
  uploadedAt: date,
  text,
  status: z.enum(["ready", "needs_ocr", "error"]),
  classification: z.enum(["synthetic", "public", "sanitized"]),
  hash: text,
});
const opportunity = z.object({
  id,
  reference: text,
  title: text,
  buyer: text,
  description: text,
  category: text,
  tags: z.array(text).max(100),
  deadline: z
    .string()
    .refine(
      (value) => !value || Number.isFinite(Date.parse(value)),
      "Invalid deadline",
    ),
  score: z.number().min(0).max(100).nullable(),
  coverage: z.number().min(0).max(100),
  status: z.enum([
    "new",
    "shortlisted",
    "deferred",
    "declined",
    "in_progress",
    "submitted",
  ]),
  sourceId: id,
  value: z.number().nonnegative().nullable(),
  saved: z.boolean(),
  createdAt: date,
  documents: z.array(documentRecord).max(10),
  requirements: z.array(requirement).max(3000),
  gaps: z.array(gap).max(3000),
  acquisition: z.enum([
    "not_requested",
    "requested",
    "approved",
    "document_available",
  ]),
  language: z.enum(["en", "ar"]),
  sourceUrl: optionalHttpsUrl,
});
const section = z.object({
  id,
  title: text,
  body: text,
  evidence: z.array(text).max(1000),
});
const proposal = z.object({
  id,
  opportunityId: id,
  title: text,
  status: z.enum(["draft", "in_review", "approved"]),
  version: z.number().int().min(1),
  sections: z.array(section).max(100),
  lines: z
    .array(
      z.object({
        id,
        description: text,
        quantity: text,
        unit: text,
        rate: text,
        optional: z.boolean(),
      }),
    )
    .max(1000),
  pricingMode: z.enum(["markup", "margin"]),
  percentage: text,
  contingency: text,
  tax: text,
  approvalVersion: z.number().int().min(1).nullable(),
  updatedAt: date,
  comments: z
    .array(z.object({ id, body: text, at: date, author: text }))
    .max(3000),
});
const source = z.object({
  id,
  name: text,
  type: z.enum(["rss", "json_feed", "link_directory", "manual"]),
  url: optionalHttpsUrl,
  status: z.enum(["proposed", "approved", "paused", "rejected"]),
  health: z.enum(["healthy", "unknown", "unavailable", "blocked"]),
  lastRun: date.nullable(),
  nextRun: date.nullable(),
  count,
  policy: text,
  tags: z.array(text).max(100),
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  opportunities: z.array(opportunity).max(2000),
  proposals: z.array(proposal).max(2000),
  sources: z.array(source).max(100),
  knowledge: z
    .array(
      z.object({
        id,
        category: z.enum([
          "capability",
          "company",
          "exclusion",
          "rate",
          "template",
        ]),
        title: text,
        content: text,
        verified: z.boolean(),
        evidence: text,
      }),
    )
    .max(3000),
  jobs: z
    .array(
      z.object({
        id,
        type: text,
        target: text,
        status: z.enum([
          "queued",
          "running",
          "completed",
          "failed",
          "blocked",
          "cancelled",
        ]),
        progress: z.number().min(0).max(100),
        attempt: count,
        message: text,
        createdAt: date,
      }),
    )
    .max(5000),
  notifications: z
    .array(
      z.object({
        id,
        title: text,
        body: text,
        href: z
          .string()
          .max(500)
          .refine(
            (value) =>
              value.startsWith("/") &&
              !value.startsWith("//") &&
              !value.includes("\\"),
            "Notifications must link to an internal route",
          ),
        read: z.boolean(),
        createdAt: date,
      }),
    )
    .max(5000),
  audit: z
    .array(z.object({ id, action: text, target: text, at: date, actor: text }))
    .max(10000),
  settings: z.object({
    role: z.enum(["Owner", "Editor", "Reviewer"]),
    companyName: text,
    dailyCallLimit: count.max(50),
    inputTokenLimit: count.max(250000),
    outputTokenLimit: count.max(50000),
    pollHours: z.number().min(1).max(168),
    retentionDays: z.number().int().min(1).max(365),
  }),
});

function validateState(input: unknown): AppState {
  const result = stateSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Backup is invalid: ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message ?? ""}`,
    );
  const state = result.data;
  for (const collection of [
    state.opportunities,
    state.proposals,
    state.sources,
    state.knowledge,
    state.jobs,
    state.notifications,
    state.audit,
  ]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length)
      throw new Error("Backup contains duplicate record IDs.");
  }
  for (const item of state.opportunities)
    for (const collection of [item.documents, item.requirements, item.gaps])
      if (
        new Set(collection.map((record) => record.id)).size !==
        collection.length
      )
        throw new Error("Backup contains duplicate evidence IDs.");
  for (const item of state.proposals)
    for (const collection of [item.sections, item.lines, item.comments])
      if (
        new Set(collection.map((record) => record.id)).size !==
        collection.length
      )
        throw new Error("Backup contains duplicate proposal item IDs.");
  const sources = new Set(state.sources.map((item) => item.id));
  const opportunities = new Set(state.opportunities.map((item) => item.id));
  if (state.opportunities.some((item) => !sources.has(item.sourceId)))
    throw new Error("Backup contains an opportunity with a missing source.");
  if (state.proposals.some((item) => !opportunities.has(item.opportunityId)))
    throw new Error("Backup contains a proposal with a missing opportunity.");
  if (
    state.proposals.some(
      (item) =>
        item.status === "approved" && item.approvalVersion !== item.version,
    )
  )
    throw new Error("Backup contains an approval for a different version.");
  return state;
}
export function serializeBackup(state: AppState): string {
  return JSON.stringify(
    {
      format: "tender-desk-demo-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      state: validateState(state),
    },
    null,
    2,
  );
}
export function parseBackup(raw: string): AppState {
  if (new TextEncoder().encode(raw).length > 25 * 1024 * 1024)
    throw new Error("Backup exceeds the 25 MiB import limit.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  const envelope = z
    .object({
      format: z.literal("tender-desk-demo-backup"),
      version: z.literal(1),
      exportedAt: date,
      state: z.unknown(),
    })
    .safeParse(value);
  if (!envelope.success)
    throw new Error("This is not a supported Tender Desk demo backup.");
  return validateState(envelope.data.state);
}

export interface AppContextValue {
  state: AppState;
  update: (mutation: StateMutation, action?: string, target?: string) => void;
  reset: () => void;
  restore: (backup: AppState) => void;
  ready: boolean;
  storageError: string | null;
  notify: (message: string) => void;
  toast: string | null;
  clearToast: () => void;
}
const AppContext = createContext<AppContextValue | null>(null);
const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown browser storage error";

export function AppProvider({ children }: { children: ReactNode }) {
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
    (mutation: StateMutation, action?: string, target?: string) => {
      if (!ready) {
        notify("Please wait for your saved workspace to load.");
        return;
      }
      const previous = stateRef.current;
      let next: AppState;
      try {
        next = invalidateChangedApprovals(
          previous,
          mutation(structuredClone(previous)),
        );
      } catch (error) {
        notify(`The change could not be applied: ${messageFor(error)}`);
        return;
      }
      if (!canApplyMutation(previous, next)) {
        notify("Your current demo role cannot perform this action.");
        return;
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
            return;
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
    },
    [notify, persist, ready],
  );

  const reset = useCallback(() => {
    if (!ready) return;
    if (stateRef.current.settings.role !== "Owner") {
      notify("Only the demo Owner can reset this workspace.");
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
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider.");
  return context;
}
