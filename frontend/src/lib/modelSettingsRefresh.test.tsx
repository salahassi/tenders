import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HashRouter, Link } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { ConnectedProvider } from "./ConnectedProvider";
import { BackendClient, BackendRequestError } from "./backendClient";
import { useApp } from "./store";
import ModelCatalogControls from "../components/ModelCatalogControls";

const wid = "00000000-0000-4000-8000-000000000010";
const session = { access_token: "fixture", user: { id: wid } } as Session;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function Probe() {
  const { state, runCommand, storageError } = useApp();
  return (
    <>
      <p>{state.settings.companyName}</p>
      <Link to="/jobs">Jobs navigation</Link>
      {storageError && <p role="alert">{storageError}</p>}
      <button
        onClick={() =>
          void runCommand!("workspace.settings", {}).catch(() => {})
        }
      >
        Business save
      </button>
      <ModelCatalogControls legacy={null} />
    </>
  );
}
async function setup() {
  window.history.replaceState(null, "", "/#/settings?section=models");
  let poll: () => void = () => {},
    token = "initial",
    company = "Initial workspace";
  const realInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((fn, delay, ...args) => {
    if (delay === 60000 || delay === 10000) {
      poll = fn as () => void;
      return -1 as unknown as ReturnType<typeof setInterval>;
    }
    return realInterval(fn, delay, ...args) as unknown as ReturnType<
      typeof setInterval
    >;
  });
  const connection = {
    id: wid,
    provider: "openai",
    label: "Fixture",
    credential_alias: "APP_MODEL_OPENAI_KEY",
    project_ref: "default",
    enabled: true,
    revision: 1,
  };
  const model = {
    id: wid,
    connection_id: wid,
    label: "Fixture model",
    model: "fixture-model",
    enabled: true,
    revision: 1,
    capabilities: {
      revision: 1,
      background: false,
      streaming: true,
      output: "validated_json",
      reasoning: "none",
      reasoning_values: [],
      max_output_tokens: null,
    },
  };
  let commandError = false,
    duringLoad: (() => void) | null = null;
  const request = vi.fn(async (path: string, options?: any): Promise<any> => {
    const resource = path.split("?")[0].split("/").at(-1);
    let data: any;
    if (resource === "status")
      data = {
        change_token: token,
        last_heartbeat_at: null,
        last_source_success_at: null,
        scheduler_enabled: false,
      };
    else if (resource === "bootstrap") {
      duringLoad?.();
      data = {
        membership: { workspace_id: wid, role: "Owner" },
        workspace: { id: wid, revision: 1, name: company, settings: {} },
        operations: null,
      };
    } else if (resource === "commands") {
      if (commandError)
        throw new BackendRequestError(
          "REVISION_CONFLICT",
          "Changed on server",
          409,
        );
      const { operation, input } = options.body.commands[0];
      if (operation === "workspace.settings") company = "Saved workspace";
      const row = operation === "model.configuration.save" ? model : connection;
      Object.assign(row, input, { revision: row.revision + 1 });
      token = `change-${row.revision}`;
      data = [{ ...row }];
    } else if (resource === "model-catalog-status")
      data = { connections: [{ id: wid, key_configured: true }], tasks: [] };
    else
      data = {
        records:
          resource === "model-connections"
            ? [{ ...connection }]
            : resource === "model-configurations"
              ? [{ ...model }]
              : [],
        next_cursor: null,
      };
    return { data, meta: { request_id: "fixture" } };
  });
  const client = {
    request,
    auth: {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe() {} } },
        }),
      },
    },
  } as unknown as BackendClient;
  render(
    <HashRouter>
      <ConnectedProvider client={client}>
        <Probe />
      </ConnectedProvider>
    </HashRouter>,
  );
  await screen.findByText("fixture-model");
  request.mockClear();
  return {
    request,
    connection,
    model,
    poll: async () => {
      await act(async () => poll());
    },
    change: () => {
      token += "-external";
      company = "External workspace";
    },
    failCommand: () => {
      commandError = true;
    },
    duringLoad: (fn: () => void) => {
      duringLoad = fn;
    },
  };
}
const paths = (f: Awaited<ReturnType<typeof setup>>) =>
  f.request.mock.calls.map(([p]) => p);
const businessReads = (f: Awaited<ReturnType<typeof setup>>) =>
  paths(f).filter(
    (p) =>
      p !== "/v1/status" && p !== "/v1/commands" && !p.startsWith("/v1/model-"),
  );
it.each(["connection", "model"])(
  "%s disable/enable uses one command and five catalog reads, preserving server revisions",
  async (kind) => {
    const f = await setup();
    for (const enabled of [false, true]) {
      f.request.mockClear();
      await userEvent.click(
        screen.getAllByRole("button", { name: "Edit" })[
          kind === "connection" ? 0 : 1
        ],
      );
      await userEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
      await userEvent.click(
        screen.getByRole("button", { name: `Save ${kind}` }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: `Save ${kind}` }),
        ).not.toBeInTheDocument(),
      );
      expect(f[kind as "connection" | "model"].enabled).toBe(enabled);
      expect(paths(f)).toHaveLength(6);
      expect(businessReads(f)).toEqual([]);
    }
  },
);
it("first and unchanged polls read only status; changed models defer business reads until navigation", async () => {
  const f = await setup();
  await f.poll();
  expect(paths(f)).toEqual(["/v1/status"]);
  f.request.mockClear();
  f.change();
  await f.poll();
  expect(paths(f)).toHaveLength(6);
  expect(businessReads(f)).toEqual([]);
  expect(screen.getByText("Initial workspace")).toBeInTheDocument();
  f.request.mockClear();
  await f.poll();
  expect(paths(f)).toEqual(["/v1/status"]);
  f.request.mockClear();
  await userEvent.click(screen.getByText("Jobs navigation"));
  await screen.findByText("External workspace");
  expect(paths(f).filter((p) => p === "/v1/bootstrap")).toHaveLength(1);
  expect(
    paths(f).filter((p) => p.startsWith("/v1/job-summaries?")),
  ).toHaveLength(1);
});
it("business commands still refresh authoritative workspace rows", async () => {
  const f = await setup();
  await userEvent.click(screen.getByText("Business save"));
  await screen.findByText("Saved workspace");
  await waitFor(() =>
    expect(businessReads(f), JSON.stringify(paths(f))).toContain(
      "/v1/bootstrap",
    ),
  );
});
it("failed catalog writes show server errors without refreshing or claiming success", async () => {
  const f = await setup();
  f.failCommand();
  await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  await userEvent.click(
    screen.getByRole("button", { name: "Save connection" }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Changed on server").length).toBeGreaterThan(0),
  );
  expect(paths(f)).toEqual(["/v1/commands"]);
  expect(f.connection.revision).toBe(1);
});
it("a change during a business load remains detectable on the following poll", async () => {
  const f = await setup();
  await act(async () => {
    window.history.replaceState(null, "", "/#/jobs");
  });
  f.duringLoad(f.change);
  await userEvent.click(screen.getByText("Business save"));
  await screen.findByText("External workspace");
  f.request.mockClear();
  await f.poll();
  await waitFor(() =>
    expect(businessReads(f), JSON.stringify(paths(f))).toContain(
      "/v1/bootstrap",
    ),
  );
});
