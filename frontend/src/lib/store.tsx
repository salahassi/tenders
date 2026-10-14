import { useContext, useState, type ReactNode } from "react";
import { AppContext, type AppContextValue } from "./appContext";
import { ConnectedProvider } from "./ConnectedProvider";
import { configuredBackend } from "./backendClient";
import { AccessLayout } from "./AccessLayout";

export function AppProvider({ children }: { children: ReactNode }) {
  const [configuration] = useState(() => {
    try {
      return { client: configuredBackend(), error: null };
    } catch (error) {
      return {
        client: null,
        error:
          error instanceof Error
            ? error.message
            : "The workspace connection could not be configured.",
      };
    }
  });
  if (!configuration.client)
    return (
      <AccessLayout>
        <h1>Workspace connection unavailable</h1>
        <p role="alert">{configuration.error}</p>
        <p>Please contact your workspace administrator.</p>
      </AccessLayout>
    );
  return (
    <ConnectedProvider client={configuration.client}>
      {children}
    </ConnectedProvider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider.");
  return context;
}
