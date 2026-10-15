import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import type { StateMutation } from "../types";
import { AppContext } from "./appContext";
import { BackendClient, BackendRequestError } from "./backendClient";
import {
  ConnectedRepository,
  emptyConnectedState,
} from "./connectedRepository";
import { AuthPanel } from "./AuthPanel";
import { AccessLayout } from "./AccessLayout";
import { pendingInvitation, clearPendingInvitation } from "./invitations";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The workspace request failed.";
export function ConnectedProvider({
  client,
  children,
}: {
  client: BackendClient;
  children: ReactNode;
}) {
  const [repository] = useState(() => new ConnectedRepository(client));
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [state, setState] = useState(emptyConnectedState);
  const stateRef = useRef(state);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "pending">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const generation = useRef(0);
  const [retry, setRetry] = useState(0);
  const [invitation, setInvitation] = useState(pendingInvitation);
  const [recovery, setRecovery] = useState(
    () =>
      new URLSearchParams(window.location.search).get("auth") === "recovery",
  );
  const refresh = async () => {
    if (phase !== "ready") {
      setRetry((n) => n + 1);
      return;
    }
    const current = generation.current;
    const next = await repository.refresh();
    if (current === generation.current) {
      stateRef.current = next;
      setState(next);
      setError(null);
    }
  };
  const runCommand = async (
    operation: string,
    input: Record<string, unknown>,
    key: string = crypto.randomUUID(),
  ) => {
    if (savingRef.current)
      throw new Error("Wait for the current save to finish.");
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const { data } = await client.request<Record<string, unknown>[]>(
        "/v1/commands",
        {
          method: "POST",
          body: { commands: [{ operation, input }] },
          idempotencyKey: key,
        },
      );
      await refresh();
      return data[0];
    } catch (error) {
      setError(message(error));
      throw error;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const signOut = async () => {
    generation.current++;
    stateRef.current = emptyConnectedState();
    setState(stateRef.current);
    setPhase("loading");
    const { error } = await client.auth.auth.signOut();
    if (error) setError(message(error));
    setSession(null);
  };
  useEffect(() => {
    let active = true;
    let authEvents = 0;
    let identity: string | null | undefined = undefined;
    const receive = (next: Session | null) => {
      if (identity !== next?.user.id) {
        generation.current++;
        setPhase("loading");
        setError(null);
        setToast(null);
        stateRef.current = emptyConnectedState();
        setState(stateRef.current);
      }
      identity = next?.user.id ?? null;
      setSession(next);
    };
    void client.auth.auth.getSession().then(({ data, error }) => {
      if (!active || authEvents) return;
      if (error) setError(message(error));
      receive(data.session);
    });
    const {
      data: { subscription },
    } = client.auth.auth.onAuthStateChange((event, next) => {
      // Keep Supabase calls outside this synchronous Auth callback.
      authEvents++;
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (active) receive(next);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);
  useEffect(() => {
    const current = ++generation.current;
    setError(null);
    setPhase("loading");
    if (!session) {
      stateRef.current = emptyConnectedState();
      setState(stateRef.current);
      return;
    }
    const open = async () => {
      if (invitation) {
        await client.request("/v1/invitations/accept", {
          method: "POST",
          body: { token: invitation },
        });
        clearPendingInvitation();
      }
      return repository.refresh();
    };
    void open()
      .then((next) => {
        if (current !== generation.current) return;
        stateRef.current = next;
        setState(next);
        setPhase("ready");
        if (invitation) setInvitation("");
      })
      .catch((cause) => {
        if (current !== generation.current) return;
        setError(message(cause));
        setPhase(
          cause instanceof BackendRequestError &&
            cause.code === "ACCESS_PENDING"
            ? "pending"
            : "error",
        );
      });
    return () => {
      generation.current++;
    };
  }, [repository, session?.access_token, retry, invitation]);
  useEffect(() => {
    if (phase !== "ready" || !session) return;
    let active = true,
      busy = false,
      changeToken: string | null = null;
    const poll = async () => {
      if (!active || busy || savingRef.current || document.hidden) return;
      busy = true;
      try {
        const { data } = await client.request<{
          change_token: string;
          last_heartbeat_at: string | null;
          last_source_success_at: string | null;
          scheduler_enabled: boolean;
        }>("/v1/status");
        if (!active || savingRef.current) return;
        repository.operations = {
          lastHeartbeat: data.last_heartbeat_at,
          lastCollection: data.last_source_success_at,
          schedulerEnabled: data.scheduler_enabled,
        };
        if (changeToken !== data.change_token) {
          const next = await repository.load();
          if (active && !savingRef.current) {
            stateRef.current = next;
            setState(next);
          }
          changeToken = data.change_token;
        } else setState((current) => ({ ...current }));
      } catch (cause) {
        if (
          active &&
          cause instanceof BackendRequestError &&
          (cause.status === 401 || cause.code === "ACCESS_PENDING")
        ) {
          setError(message(cause));
          setPhase("pending");
        }
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(
      () => void poll(),
      window.location.hash.includes("/jobs") ? 10000 : 60000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, repository, phase, session?.user.id]);
  const update = async (mutation: StateMutation): Promise<boolean> => {
    if (savingRef.current || phase !== "ready" || !session) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setToast(null);
    const current = generation.current;
    try {
      const previous = stateRef.current;
      const next = mutation(structuredClone(previous));
      const saved = await repository.save(previous, next);
      if (current !== generation.current) return false;
      stateRef.current = saved;
      setState(saved);
      return true;
    } catch (cause) {
      if (current === generation.current) {
        if (
          cause instanceof BackendRequestError &&
          (cause.status === 401 ||
            cause.code === "ACCESS_PENDING" ||
            cause.code === "WORKSPACE_MISMATCH")
        ) {
          stateRef.current = emptyConnectedState();
          setState(stateRef.current);
          setPhase(cause.status === 401 ? "error" : "pending");
          setError(message(cause));
        } else
          setError(
            `${message(cause)} Your entered values have not been replaced. Retry the same save or refresh to check the latest server state.`,
          );
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  if (session && recovery)
    return (
      <AccessLayout>
        <AuthPanel
          client={client}
          recovery
          onRecoveryDone={() => {
            setRecovery(false);
            const url = new URL(window.location.href);
            url.searchParams.delete("auth");
            window.history.replaceState(null, "", url.href);
            void refresh();
          }}
        />
      </AccessLayout>
    );
  if (!session || phase !== "ready")
    return (
      <AccessLayout>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {session === null ? (
          <AuthPanel client={client} invitationToken={invitation} />
        ) : (
          <section className="access-state" aria-live="polite">
            <h1>
              {session === undefined || phase === "loading"
                ? "Opening your workspace"
                : phase === "pending"
                  ? "Workspace access pending"
                  : "Workspace unavailable"}
            </h1>
            <p>
              {session === undefined || phase === "loading"
                ? "Checking your account and workspace access…"
                : phase === "pending"
                  ? "You’re signed in, but this account doesn’t have workspace access yet. Open your invitation link or contact your workspace administrator."
                  : "We couldn’t open your workspace. Please try again. Your saved data has not been changed."}
            </p>
            {session && (
              <div className="access-state-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => void refresh()}
                >
                  Check access again
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </div>
            )}
          </section>
        )}
      </AccessLayout>
    );
  return (
    <AppContext.Provider
      value={{
        state,
        update,
        ready: true,
        mode: "CONNECTED_FREE",
        saving,
        backend: client,
        runCommand,
        storageError: error,
        toast,
        notify: setToast,
        clearToast: () => setToast(null),
        userLabel: session.user.email || "Signed-in user",
        refresh,
        signOut,
        operations: repository.operations,
        reset: () =>
          setError(
            "Workspace reset is not available. No server data was changed.",
          ),
        restore: () =>
          setError(
            "Connected restore needs a validated empty-target backup workflow. No data was changed.",
          ),
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
