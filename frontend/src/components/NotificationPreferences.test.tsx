import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../lib/store";
import NotificationPreferences from "./NotificationPreferences";
vi.mock("../lib/store", () => ({ useApp: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(configured = true, fail = false) {
  let preferences = {
    revision: 1,
    email_enabled: true,
    failure_alerts: true,
    review_reminders: true,
    review_interval_hours: 24,
    language: "ar",
  };
  const runCommand = vi.fn(async (op, input) => {
    if (fail) throw Error("Preferences could not be saved");
    if (op === "notification.preferences")
      preferences = {
        ...preferences,
        ...input,
        revision: preferences.revision + 1,
      };
    return { id: "test-job" };
  });
  const request = vi.fn(async () => ({
    data: {
      preferences,
      recipient: "owner@example.test",
      transport: { configured },
      deliveries: [],
    },
  }));
  vi.mocked(useApp).mockReturnValue({
    backend: { request },
    runCommand,
    notify: vi.fn(),
  } as any);
  const view = render(<NotificationPreferences />);
  return { view, runCommand };
}
it("saves account preferences and reminder interval, then reloads the persisted values", async () => {
  const f = setup();
  await screen.findByText("owner@example.test");
  await userEvent.selectOptions(
    screen.getByLabelText("Review reminder frequency"),
    "12",
  );
  await userEvent.selectOptions(screen.getByLabelText("Email language"), "en");
  await userEvent.click(
    screen.getByRole("button", { name: "Save notification preferences" }),
  );
  await waitFor(() =>
    expect(f.runCommand).toHaveBeenCalledWith("notification.preferences", {
      expected_revision: 1,
      email_enabled: true,
      failure_alerts: true,
      review_reminders: true,
      review_interval_hours: 12,
      language: "en",
    }),
  );
  f.view.unmount();
  render(<NotificationPreferences />);
  await screen.findByText("owner@example.test");
  expect(screen.getByLabelText("Review reminder frequency")).toHaveValue("12");
  expect(screen.getByLabelText("Email language")).toHaveValue("en");
});
it("permits a test only for saved enabled preferences and configured SMTP", async () => {
  const f = setup();
  const button = await screen.findByRole("button", {
    name: "Send test email to me",
  });
  await userEvent.click(button);
  expect(f.runCommand).toHaveBeenCalledWith("notification.test", {});
  await userEvent.click(screen.getByLabelText("Email notifications"));
  expect(button).toBeDisabled();
});
it("shows missing SMTP honestly, disables tests and still allows preference saving", async () => {
  const f = setup(false);
  await screen.findByText("SMTP setup required");
  expect(
    screen.getByRole("button", { name: "Send test email to me" }),
  ).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Save notification preferences" }),
  );
  expect(f.runCommand).toHaveBeenCalledWith(
    "notification.preferences",
    expect.any(Object),
  );
});
it("preserves user edits if preference saving fails", async () => {
  setup(true, true);
  await screen.findByText("owner@example.test");
  await userEvent.selectOptions(
    screen.getByLabelText("Review reminder frequency"),
    "168",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Save notification preferences" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Preferences could not be saved",
  );
  expect(screen.getByLabelText("Review reminder frequency")).toHaveValue("168");
});
