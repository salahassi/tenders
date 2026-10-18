import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { get, set } from "idb-keyval";
import { ConnectedProvider } from "./ConnectedProvider";
import { ConnectedRepository } from "./connectedRepository";
import { BackendClient, BackendRequestError } from "./backendClient";
import { useApp } from "./store";
import Settings from "../pages/Settings";
import Sources from "../pages/Sources";
import SourceDetail from "../pages/SourceDetail";
import Dashboard from "../pages/Dashboard";
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
  localStorage.clear();
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
function fixture(sourceRows?: Record<string, unknown>[]) {
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
          ? (sourceRows ?? [
              {
                id: source,
                revision: 1,
                name: "Manual",
                kind: "manual",
                approval: "approved",
                tags: [],
              },
            ])
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
  it("shows recorded source processing counts, including zero, without inventing an absent count", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    const ids = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
    ];
    f.request.mockImplementation(async (path, options) => {
      const table = path.split("?")[0];
      if (table === "/v1/jobs" || table === "/v1/source-runs") {
        const records = ids.map((id, i) =>
          table === "/v1/jobs"
            ? {
                id,
                revision: 1,
                type: "source_collect",
                entity_id: source,
                status: "succeeded",
                attempts: 1,
                created_at: "2026-10-18T00:00:00Z",
              }
            : {
                id,
                revision: 1,
                job_id: id,
                source_id: source,
                status: "succeeded",
                counts: i < 2 ? { processed: i === 0 ? 10 : 0 } : {},
              },
        );
        return {
          data: { records, next_cursor: null },
          meta: { request_id: "fixture" },
        };
      }
      return original(path, options);
    });
    const state = await new ConnectedRepository(f.client).load();
    expect(state.jobs.map((j) => j.message)).toEqual([
      "10 notices processed.",
      "0 notices processed.",
      "",
    ]);
  });
  it("does not attribute user-entered opportunities to a manual tender portal", async () => {
    const f = fixture([
      {
        id: source,
        revision: 1,
        name: "Synthetic official portal",
        kind: "manual",
        url: "https://example.test/tenders",
        approval: "proposed",
        adapter_required: true,
        tags: ["country:JO"],
      },
    ]);
    const repository = new ConnectedRepository(f.client);
    const previous = await repository.load(),
      next = structuredClone(previous);
    next.opportunities.push({
      ...next.opportunities[0],
      id: crypto.randomUUID(),
      sourceId: "manual",
      title: "New user entry",
    });
    await repository.save(previous, next);
    const request = f.commands[0] as {
      body: {
        commands: { operation: string; input: Record<string, unknown> }[];
      };
    };
    const createdSource = request.body.commands.find(
      (c) => c.operation === "source.create",
    )!;
    const createdOpportunity = request.body.commands.find(
      (c) => c.operation === "opportunity.create",
    )!;
    expect(createdSource.input).toMatchObject({
      name: "Added by you",
      kind: "manual",
      approved_hosts: [],
    });
    expect(createdSource.input.client_id).not.toBe(source);
    expect(createdOpportunity.input.source_id).toBe(
      createdSource.input.client_id,
    );
  });
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
  it("shows manual portal names, country filtering, and manual access without an Enable button", async () => {
    const f = fixture([
      {
        id: source,
        revision: 1,
        name: "بوابة عطاءات اختبارية",
        kind: "manual",
        url: "https://example.test/tenders",
        approval: "proposed",
        adapter_required: true,
        tags: ["country:JO", "الأردن", "بنك"],
      },
    ]);
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Sources />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", {
      name: "بوابة عطاءات اختبارية",
    });
    expect(link).toHaveAttribute("href", `/sources/${source}`);
    expect(
      screen.getByText("Manual review", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Built-in origin")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable" }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Filter source country"),
      "SA",
    );
    expect(
      screen.queryByRole("link", { name: "بوابة عطاءات اختبارية" }),
    ).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Filter source country"),
      "JO",
    );
    expect(
      screen.getByRole("link", { name: "بوابة عطاءات اختبارية" }),
    ).toBeInTheDocument();
  });

  it("opens manual portal details with the actual access note and no misleading collection action", async () => {
    const f = fixture([
      {
        id: source,
        revision: 1,
        name: "Synthetic supplier portal",
        kind: "manual",
        url: "https://example.test/suppliers",
        approval: "proposed",
        adapter_required: true,
        policy_note: "Synthetic registration instructions",
        tags: ["country:SA"],
      },
    ]);
    render(
      <MemoryRouter initialEntries={[`/sources/${source}`]}>
        <ConnectedProvider client={f.client}>
          <Routes>
            <Route path="/sources/:id" element={<SourceDetail />} />
          </Routes>
        </ConnectedProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Synthetic supplier portal" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /https:\/\/example.test\/suppliers/ }),
    ).toHaveAttribute("href", "https://example.test/suppliers");
    expect(
      screen.getByText("Synthetic registration instructions", {
        selector: "p",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Manual review — collection adapter required"),
    ).toBeInTheDocument();
  });
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
    expect(
      screen.getByRole("button", { name: "Check access again" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Opening your workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/server opportunities/)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
  it("shows the workspace skeleton while the session and workspace are loading", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.request.getMockImplementation();
    f.request.mockImplementation(async (path, options) => {
      await gate;
      return original!(path, options);
    });
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Probe />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Opening your workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your account and loading the workspace.",
    );
    expect(
      screen.queryByRole("button", { name: "Check access again" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Sign in to Tenderdesk" }),
    ).not.toBeInTheDocument();
    await act(async () => release());
    await screen.findByText("1 server opportunities");
    expect(
      screen.queryByRole("heading", { name: "Opening your workspace" }),
    ).not.toBeInTheDocument();
  });
  it("shows sign-in after the session check finds no account", async () => {
    const f = fixture();
    const auth = f.client.auth.auth as {
      getSession: () => Promise<{
        data: { session: Session | null };
        error: null;
      }>;
    };
    auth.getSession = async () => ({ data: { session: null }, error: null });
    render(
      <ConnectedProvider client={f.client}>
        <Probe />
      </ConnectedProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to Tenderdesk" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Opening your workspace" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Check access again" }),
    ).not.toBeInTheDocument();
  });
  it("lets the overview hide processing health and turn it back on", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Dashboard />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Processing health" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Hide processing health" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Processing health" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("tenderdesk:overview-processing-health")).toBe(
      "hidden",
    );
    await user.click(
      screen.getByRole("button", { name: "Show processing health" }),
    );
    expect(
      screen.getByRole("heading", { name: "Processing health" }),
    ).toBeInTheDocument();
    expect(
      localStorage.getItem("tenderdesk:overview-processing-health"),
    ).toBeNull();
  });
  it("keeps processing health off on the next overview visit", async () => {
    localStorage.setItem("tenderdesk:overview-processing-health", "hidden");
    const f = fixture();
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Dashboard />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("button", { name: "Show processing health" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Processing health" }),
    ).not.toBeInTheDocument();
  });
  it("turns overview processing health off from settings", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ConnectedProvider client={f.client}>
          <Settings />
        </ConnectedProvider>
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole("checkbox", {
      name: "Show on the overview",
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("tenderdesk:overview-processing-health")).toBe(
      "hidden",
    );
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
