import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import ModelControls from "./ModelControls";
import { DEFAULT_PROVIDER_ORDER } from "../lib/modelProviders";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(
  options: {
    role?: string;
    enabled?: boolean;
    policies?: any[];
    fail?: boolean;
  } = {},
) {
  let routing = {
    enabled: options.enabled ?? true,
    revision: 7,
    strategy: "priority",
    provider_order: [...DEFAULT_PROVIDER_ORDER],
  };
  const servers = [
    {
      provider: "gemini_free",
      model: "owner-gemini-model",
      project_ref: "test-project",
      key_configured: true,
    },
    {
      provider: "groq_free",
      model: "owner-groq-model",
      project_ref: "test-groq-account",
      key_configured: true,
    },
    {
      provider: "openai",
      model: "owner-openai-model",
      project_ref: "default",
      key_configured: true,
    },
    {
      provider: "anthropic",
      model: "owner-claude-model",
      project_ref: "default",
      key_configured: true,
    },
    {
      provider: "cloudflare_free",
      model: "@cf/owner/chosen-model",
      project_ref: "syntheticaccount",
      key_configured: true,
    },
  ];
  const runCommand = vi.fn(async (op, input) => {
    if (options.fail) throw new Error("A newer revision exists");
    if (op === "model.routing")
      routing = { ...routing, ...input, revision: routing.revision + 1 };
    return { ...input, revision: (input.expected_revision || 0) + 1 };
  });
  const request = vi.fn(async (path: string) => ({
    data:
      path === "/v1/model-routing"
        ? { records: [routing] }
        : path === "/v1/model-environment"
          ? { providers: servers }
          : { records: options.policies || [] },
  }));
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: options.role || "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: { request },
  } as any);
  const view = render(<ModelControls />);
  return { view, runCommand, request };
}
const panel = (name: string) =>
  within(screen.getByRole("article", { name: `${name} provider` }));
const openPolicy = async (name: string) =>
  userEvent.click(
    panel(name).getByText("Connection setup and advanced policy"),
  );
it("shows actual server identity read-only and one card per automatic provider without ineffective toggles", async () => {
  const f = setup();
  await screen.findByText("owner-gemini-model");
  expect(
    screen.queryByRole("textbox", { name: "Exact model identifier" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText(/Enable matching backend/),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Failover rank/)).not.toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Save provider order" }),
  ).toHaveLength(1);
  expect(
    within(screen.getByRole("list", { name: "Provider order" })).getAllByRole(
      "article",
    ),
  ).toHaveLength(8);
  expect(screen.queryByText(/Legacy manual fallback/)).not.toBeInTheDocument();
  expect(f.runCommand).not.toHaveBeenCalled();
});
it("checks the selected provider only and disables checks with missing credentials", async () => {
  const f = setup();
  await screen.findByText("owner-openai-model");
  await userEvent.click(
    panel("OpenAI").getByRole("button", { name: "Check OpenAI only" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith("model.probe", {
    provider: "openai",
  });
  expect(
    panel("Qwen").getByRole("button", { name: "Check Qwen only" }),
  ).toBeDisabled();
  expect(
    await screen.findByText(/Connection check queued. Follow/),
  ).toBeInTheDocument();
});
it("persists provider order and strategy without writing credentials or permissions", async () => {
  const f = setup();
  await screen.findByText("owner-gemini-model");
  await userEvent.click(screen.getByRole("button", { name: "Move z.ai up" }));
  await userEvent.selectOptions(
    screen.getByLabelText("Provider selection"),
    "round_robin",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save provider order" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith("model.routing", {
    enabled: true,
    expected_revision: 7,
    strategy: "round_robin",
    provider_order: [
      "gemini_free",
      "qwen_free",
      "mistral_free",
      "zai_free",
      "groq_free",
      "openai",
      "anthropic",
      "cloudflare_free",
    ],
  });
  f.view.unmount();
  render(<ModelControls />);
  await waitFor(() =>
    expect(screen.getByLabelText("Provider selection")).toHaveValue(
      "round_robin",
    ),
  );
  expect(
    within(screen.getByRole("list", { name: "Provider order" })).getAllByRole(
      "listitem",
    )[3],
  ).toHaveTextContent("z.ai");
});
it.each([
  ["OpenAI", "openai", "owner-openai-model"],
  ["Claude", "anthropic", "owner-claude-model"],
  ["Cloudflare Workers AI", "cloudflare_free", "@cf/owner/chosen-model"],
])(
  "saves %s legacy manual limits with the server identity and no billing attestation",
  async (name, provider, model) => {
    const f = setup({ enabled: false });
    await screen.findByText(model);
    await openPolicy(name);
    await userEvent.clear(
      panel(name).getByLabelText(`${name} Daily call ceiling`),
    );
    await userEvent.type(
      panel(name).getByLabelText(`${name} Daily call ceiling`),
      "12",
    );
    await userEvent.click(
      panel(name).getByRole("button", { name: `Save ${name} policy` }),
    );
    expect(f.runCommand).toHaveBeenCalledWith(
      "model.configure",
      expect.objectContaining({
        provider,
        model,
        project_ref:
          provider === "cloudflare_free" ? "syntheticaccount" : "default",
        calls_per_day: 12,
        enabled: false,
        quota_mode: "provider_managed",
        billing_verified: false,
      }),
    );
  },
);
it("saving one provider preserves other provider and routing drafts", async () => {
  const f = setup({ enabled: false });
  await screen.findByText("owner-gemini-model");
  await openPolicy("Gemini");
  await openPolicy("Groq");
  await userEvent.clear(
    panel("Groq").getByLabelText("Groq Daily call ceiling"),
  );
  await userEvent.type(
    panel("Groq").getByLabelText("Groq Daily call ceiling"),
    "17",
  );
  await userEvent.click(screen.getByRole("button", { name: "Move Groq up" }));
  await userEvent.click(
    panel("Gemini").getByRole("button", { name: "Save Gemini policy" }),
  );
  await waitFor(() => expect(f.runCommand).toHaveBeenCalledTimes(1));
  expect(panel("Groq").getByLabelText("Groq Daily call ceiling")).toHaveValue(
    17,
  );
  expect(
    within(screen.getByRole("list", { name: "Provider order" })).getAllByRole(
      "listitem",
    )[2],
  ).toHaveTextContent("Groq");
});
it("requires explicit policy review after a server account changes in manual mode", async () => {
  const f = setup({
    enabled: false,
    policies: [
      {
        provider: "gemini_free",
        revision: 2,
        model: "old-model",
        project_ref: "old-project",
        quota_mode: "provider_managed",
      },
    ],
  });
  await screen.findByText("owner-gemini-model");
  expect(
    panel("Gemini").getByText("Account change needs review"),
  ).toBeInTheDocument();
  expect(
    panel("Gemini").queryByRole("button", { name: "Check Gemini only" }),
  ).not.toBeInTheDocument();
  await openPolicy("Gemini");
  await userEvent.click(
    panel("Gemini").getByRole("button", { name: "Save Gemini policy" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith(
    "model.configure",
    expect.objectContaining({
      expected_revision: 2,
      model: "owner-gemini-model",
      project_ref: "test-project",
    }),
  );
  await waitFor(() =>
    expect(
      panel("Gemini").queryByText("Account change needs review"),
    ).not.toBeInTheDocument(),
  );
});
it("preserves edits when saving fails", async () => {
  setup({ fail: true, enabled: false });
  await screen.findByText("owner-gemini-model");
  await openPolicy("Gemini");
  await userEvent.clear(
    panel("Gemini").getByLabelText("Gemini Daily call ceiling"),
  );
  await userEvent.type(
    panel("Gemini").getByLabelText("Gemini Daily call ceiling"),
    "13",
  );
  await userEvent.click(
    panel("Gemini").getByRole("button", { name: "Save Gemini policy" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "A newer revision exists",
  );
  expect(
    panel("Gemini").getByLabelText("Gemini Daily call ceiling"),
  ).toHaveValue(13);
});
it("separates legacy manual activation when automatic selection is off", async () => {
  const f = setup({
    enabled: false,
    policies: [
      {
        provider: "gemini_free",
        revision: 1,
        enabled: true,
        model: "owner-gemini-model",
        project_ref: "test-project",
        quota_mode: "provider_managed",
      },
    ],
  });
  await screen.findByText("owner-gemini-model");
  await openPolicy("Gemini");
  expect(
    panel("Gemini").getByLabelText("Enable Gemini for manual routing"),
  ).toBeChecked();
  await userEvent.click(
    screen.getByRole("button", { name: "Check Gemini connection" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith("model.probe", {});
});
it("does not read Owner-only setup or permit Reviewer changes", async () => {
  const f = setup({ role: "Reviewer" });
  await screen.findByRole("button", { name: "Save provider order" });
  expect(f.request).not.toHaveBeenCalledWith("/v1/model-environment");
  expect(f.request).not.toHaveBeenCalledWith("/v1/model-routing");
  expect(
    screen.getByRole("button", { name: "Save provider order" }),
  ).toBeDisabled();
});

it("uses the supplied server account directly in automatic routing without quota controls", async () => {
  setup({
    policies: [
      {
        provider: "gemini_free",
        revision: 2,
        model: "old-model",
        project_ref: "old-project",
      },
    ],
  });
  await screen.findByText("owner-gemini-model");
  expect(
    panel("Gemini").getByRole("button", { name: "Check Gemini only" }),
  ).toBeEnabled();
  await openPolicy("Gemini");
  expect(
    screen.queryByText("Account change needs review"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Gemini Daily call ceiling"),
  ).not.toBeInTheDocument();
});
