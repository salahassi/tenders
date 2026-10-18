import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect, vi } from "vitest";
import { useApp } from "../lib/store";
import DiscoveryControls from "./DiscoveryControls";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("persists continuing company evidence permission with selected destinations", async () => {
  let policy = {
    scope: "software_services",
    auto_public_notices: true,
    auto_company_knowledge: false,
    providers: ["gemini_free", "groq_free", "zai_free"],
  };
  const runCommand = vi.fn(async (_op: string, input: any) => {
    policy = input;
    return {};
  });
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role: "Owner" } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: {
      request: vi.fn(async () => ({
        data: { workspace: { revision: 7, discovery_policy: policy } },
      })),
    },
  } as any);
  const page = render(<DiscoveryControls />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Automatically assess public collector notices"),
    ).toBeChecked(),
  );
  await userEvent.click(
    screen.getByLabelText("Include Company Knowledge in model processing"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save assessment & sharing settings" }),
  );
  await waitFor(() =>
    expect(runCommand).toHaveBeenCalledWith("discovery.configure", {
      expected_revision: 7,
      scope: "software_services",
      auto_public_notices: true,
      auto_company_knowledge: true,
      providers: ["gemini_free", "groq_free", "zai_free"],
    }),
  );
  page.unmount();
  render(<DiscoveryControls />);
  await waitFor(() =>
    expect(
      screen.getByLabelText("Include Company Knowledge in model processing"),
    ).toBeChecked(),
  );
});
