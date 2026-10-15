import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { get, set } from "idb-keyval";
import { ConnectedProvider } from "./ConnectedProvider";
import { ConnectedRepository } from "./connectedRepository";
import { BackendClient, BackendRequestError } from "./backendClient";
import { useApp } from "./store";
import Settings from "../pages/Settings";
import Sources from "../pages/Sources";
import type { Session } from "@supabase/supabase-js";
vi.mock("idb-keyval", () => ({
  get: vi.fn(() => {
    throw Error("Connected mode read local demo data");
  }),
  set: vi.fn(() => {
    throw Error("Connected mode wrote local demo data");
  }),
  del: vi.fn(),
  keys: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const workspace = "00000000-0000-4000-8000-000000000010";
const source = "00000000-0000-4000-8000-000000000011";
const opportunity = "00000000-0000-4000-8000-000000000012";
const session = {
  access_token: "fixture-token",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
  },
} as Session;
function fixture() {
  let authListener: (
    _event: string,
    session: Session | null,
  ) => void = () => {};
  let name = "Connected fixture workspace";
  let revision = 1;
  let role = "Owner";
  let beforeWrite: (() => Promise<void>) | null = null;
  let loadError: Error | null = null;
  const commands: unknown[] = [];
  const opportunityRow = {
    id: opportunity,
    revision: 1,
    title: "Server opportunity",
    reference: "TEST-1",
    source_id: source,
    decision: "undecided",
    language: "ar",
    created_at: "2026-10-14T00:00:00Z",
  };
  const request = vi.fn(
    async (
      path: string,
      options?: { method?: string; body?: unknown; idempotencyKey?: string },
    ): Promise<{ data: unknown; meta: { request_id: string } }> => {
      if (path === "/v1/commands") {
        commands.push(options);
        await beforeWrite?.();
        const body = options!.body as {
          commands: { operation: string; input: Record<string, unknown> }[];
        };
        for (const command of body.commands)
          if (command.operation === "workspace.settings") {
            name = String(command.input.name);
            revision++;
          }
        return { data: [], meta: { request_id: "fixture" } };
      }
      if (loadError) throw loadError;
      if (path === "/v1/bootstrap")
        return {
          data: {
            membership: { workspace_id: workspace, role },
            workspace: { id: workspace, revision, name, settings: {} },
            operations: null,
          },
          meta: { request_id: "fixture" },
        };
      const table = path.split("?")[0];
      const records =
        table === "/v1/sources"
          ? [
              {
                id: source,
                revision: 1,
                name: "Manual",
                kind: "manual",
                approval: "approved",
                tags: [],
              },
            ]
          : table === "/v1/opportunities"
            ? [opportunityRow]
            : [];
      return {
        data: { records, next_cursor: null },
        meta: { request_id: "fixture" },
      };
    },
  );
  const signOut = vi.fn(async () => {
    authListener("SIGNED_OUT", null);
    return { error: null };
  });
  const client = {
    request,
    enabledLoginProviders: async () => [],
    auth: {
      rpc: async () => ({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        onAuthStateChange: (cb: typeof authListener) => {
          authListener = cb;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        },
        signOut,
      },
    },
  } as unknown as BackendClient;
  return {
    client,
    request,
    commands,
    signOut,
    setRole: (value: string) => {
      role = value;
    },
    failLoad: (error: Error) => {
      loadError = error;
    },
    beforeWrite: (fn: () => Promise<void>) => {
      beforeWrite = fn;
    },
    signOutEvent: () => authListener("SIGNED_OUT", null),
  };
}
function Probe() {
  const { state, mode, storageError, update, signOut } = useApp();
  return (
    <>
      <p>{mode}</p>
      <p>{state.settings.companyName}</p>
      <p>{state.opportunities.length} server opportunities</p>
      {storageError && <p role="alert">{storageError}</p>}
      <button
        onClick={() =>
          void update((s) => ({
            ...s,
            opportunities: s.opportunities.map((o) => ({
              ...o,
              status: "shortlisted",
            })),
          }))
        }
      >
        Select opportunity
      </button>
      <button onClick={() => void signOut?.()}>Exit</button>
    </>
  );
}

describe("connected repository", () => {
  it("loads only server records, maps decision to status and submits the expected revision", async () => {
    const f = fixture(),
      r = new ConnectedRepository(f.client),
      previous = await r.load();
    expect(previous.opportunities).toHaveLength(1);
    expect(previous.opportunities[0].status).toBe("new");
    expect(previous.settings.role).toBe("Owner");
    const next = structuredClone(previous);
    next.opportunities[0].status = "shortlisted";
    await r.save(previous, next);
    expect(f.request).toHaveBeenCalledWith(
      "/v1/commands",
      expect.objectContaining({
        body: {
          commands: [
            {
              operation: "opportunity.decision",
              input: {
                id: opportunity,
                target_state: "shortlisted",
                reason: "Opportunity shortlisted",
                expected_revision: 1,
              },
            },
          ],
        },
      }),
    );
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it("never accepts a local role switch or unsupported file mutation", async () => {
    const f = fixture(),
      r = new ConnectedRepository(f.client),
      previous = await r.load();
    await expect(
      r.save(previous, {
        ...previous,
        settings: { ...previous.settings, role: "Editor" },
      }),
    ).rejects.toThrow("Roles are assigned");
    const next = structuredClone(previous);
    next.opportunities[0].acquisition = "requested";
    await expect(r.save(previous, next)).rejects.toThrow(
      "separate connected workflow",
    );
    expect(f.commands).toHaveLength(0);
  });
  it("retains the same body and idempotency key after an uncertain network result", async () => {
    const f = fixture(),
      r = new ConnectedRepository(f.client),
      previous = await r.load(),
      next = structuredClone(previous);
    next.opportunities[0].status = "shortlisted";
    f.beforeWrite(async () => {
      throw new TypeError("Network interrupted");
    });
    await expect(r.save(previous, next)).rejects.toThrow("Network interrupted");
    f.beforeWrite(async () => {});
    await r.save(previous, next);
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]).toEqual(f.commands[1]);
  });
  it("validates every page and refuses a repeated cursor instead of showing partial data", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, options) =>
      path.startsWith("/v1/sources?")
        ? {
            data: { records: [], next_cursor: source },
            meta: { request_id: "fixture" },
          }
        : original(path, options),
    );
    await expect(new ConnectedRepository(f.client).load()).rejects.toThrow(
      "boundary",
    );
  });
});

describe("connected screens", () => {
  it("keeps the source dialog and entered details open after a rejected save", async () => {
    const f = fixture();
    f.beforeWrite(async () => {
      throw new BackendRequestError(
        "ROLE_FORBIDDEN",
        "Source save denied",
        403,
      );
    });
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Sources />
          <Probe />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add source" }));
    await user.type(screen.getByLabelText("Source name"), "Keep this source");
    await user.type(
      screen.getByLabelText(/^Source URL/),
      "https://example.test/feed",
    );
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await screen.findByText(/Source save denied/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Source name")).toHaveValue(
      "Keep this source",
    );
    expect(screen.getByLabelText(/^Source URL/)).toHaveValue(
      "https://example.test/feed",
    );
  });

  it("keeps entered values and reports failure without a successful-save toast or local storage", async () => {
    const f = fixture();
    f.beforeWrite(async () => {
      throw new BackendRequestError(
        "REVISION_CONFLICT",
        "A newer revision exists",
        409,
      );
    });
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Settings />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText("Workspace / company name");
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "Keep my changes");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText(/A newer revision exists/);
    expect(input).toHaveValue("Keep my changes");
    expect(
      screen.queryByText("Workspace preferences saved to your account."),
    ).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
  it("waits for the server and disables repeat saving until confirmation", async () => {
    const f = fixture();
    let release!: () => void;
    f.beforeWrite(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Settings />
          <Probe />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText("Workspace / company name");
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "Confirmed workspace");
    const button = screen.getByRole("button", { name: "Save preferences" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText("Connected fixture workspace")).toBeInTheDocument();
    await act(async () => release());
    await screen.findByText("Confirmed workspace");
    expect(button).toBeEnabled();
    expect(f.commands).toHaveLength(1);
  });
  it("never opens sample records when membership is pending", async () => {
    const f = fixture();
    f.failLoad(
      new BackendRequestError("ACCESS_PENDING", "Await Owner approval", 403),
    );
    render(
      <ConnectedProvider client={f.client}>
        <Probe />
      </ConnectedProvider>,
    );
    await screen.findByText("Workspace access pending");
    expect(screen.queryByText(/server opportunities/)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
  it("removes workspace data immediately on sign out and on revoked membership", async () => {
    const f = fixture();
    f.beforeWrite(async () => {
      throw new BackendRequestError(
        "ACCESS_PENDING",
        "Membership revoked",
        403,
      );
    });
    render(
      <ConnectedProvider client={f.client}>
        <Probe />
      </ConnectedProvider>,
    );
    await screen.findByText("1 server opportunities");
    await userEvent.click(
      screen.getByRole("button", { name: "Select opportunity" }),
    );
    await screen.findByText("Workspace access pending");
    expect(
      screen.queryByText("Connected fixture workspace"),
    ).not.toBeInTheDocument();
    act(() => f.signOutEvent());
    await screen.findByText("Sign in to Tenderdesk");
  });
});
