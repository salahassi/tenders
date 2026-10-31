import { createContext } from "react";
import type { AppState, StateMutation } from "../types";
import type { BackendClient } from "./backendClient";

export type ToastSeverity = "success" | "error";

export interface AppContextValue {
  state: AppState;
  update: (
    mutation: StateMutation,
    action?: string,
    target?: string,
  ) => Promise<boolean>;
  reset: () => void;
  restore: (backup: AppState) => void;
  ready: boolean;
  storageError: string | null;
  notify: (message: string, severity?: ToastSeverity) => void;
  toast: string | null;
  toastSeverity?: ToastSeverity;
  clearToast: () => void;
  mode: "DEMO" | "CONNECTED_FREE";
  saving: boolean;
  backend?: BackendClient;
  runCommand?: (
    operation: string,
    input: Record<string, unknown>,
    key?: string,
  ) => Promise<Record<string, unknown>>;
  userLabel?: string;
  refresh?: () => Promise<void>;
  signOut?: () => Promise<void>;
  operations?: {
    lastHeartbeat: string | null;
    lastCollection: string | null;
    schedulerEnabled: boolean;
  };
}

export const AppContext = createContext<AppContextValue | null>(null);
