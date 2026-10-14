import { createContext } from "react";
import type { AppState, StateMutation } from "../types";
import type { BackendClient } from "./backendClient";

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
  notify: (message: string) => void;
  toast: string | null;
  clearToast: () => void;
  mode: "DEMO" | "CONNECTED_FREE";
  saving: boolean;
  backend?: BackendClient;
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
