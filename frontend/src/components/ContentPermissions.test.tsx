import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import ContentPermissions from "./ContentPermissions";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const item = {
  entity_id: "synthetic-content",
  entity_kind: "knowledge",
  title: "Synthetic capabilities",
  content_hash: "a".repeat(64),
  content: "Synthetic public company expertise.",
};
function setup(role = "Owner", authorizations: any[] = []) {
  const runCommand = vi.fn(async () => ({}));
  vi.mocked(useApp).mockReturnValue({
    state: { settings: { role } },
    saving: false,
    notify: vi.fn(),
    runCommand,
    backend: {
      request: vi.fn(async () => ({ data: { items: [item], authorizations } })),
    },
  } as any);
  render(<ContentPermissions />);
  return runCommand;
}
it("distinguishes recorded policy permission from the absence of individual approval", async () => {
  setup("Owner", [
    {
      ...item,
      provider: "gemini_free",
      authorization_basis: "company_knowledge_policy",
    },
  ]);
  await screen.findByText(item.title);
  await userEvent.click(screen.getByText(/Review individual documents/));
  expect(
    screen.getByText(/Recorded through Company Knowledge policy/),
  ).toBeInTheDocument();
  await userEvent.selectOptions(
    screen.getByLabelText("Provider for this review"),
    "anthropic",
  );
  expect(
    screen.getByText(
      /No current individual permission record; workspace policy may apply/,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("not authorized")).not.toBeInTheDocument();
});
it("requires a fresh review for each provider and submits the exact text hash", async () => {
  const command = setup();
  await screen.findByText(item.title);
  await userEvent.click(screen.getByText(/Review individual documents/));
  await userEvent.click(screen.getByRole("button", { name: "Review text" }));
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.selectOptions(
    screen.getByLabelText("Provider for this review"),
    "openai",
  );
  expect(
    screen.queryByRole("button", { name: "Authorize this text" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Review text" }));
  expect(
    screen.getByRole("button", { name: "Authorize this text" }),
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: "Authorize this text" }),
  );
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith("content.authorize", {
      entity_kind: item.entity_kind,
      entity_id: item.entity_id,
      content_hash: item.content_hash,
      provider: "openai",
      attestation: "nonconfidential_nonpersonal",
    }),
  );
});
it("does not permit Reviewer authorization", async () => {
  const command = setup("Reviewer");
  await screen.findByText(item.title);
  await userEvent.click(screen.getByText(/Review individual documents/));
  expect(screen.getByRole("button", { name: "Review text" })).toBeDisabled();
  expect(command).not.toHaveBeenCalled();
});
