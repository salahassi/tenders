import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthPanel, authRedirect } from "./AuthPanel";
import type { BackendClient } from "./backendClient";
afterEach(cleanup);
function fixture() {
  const auth = {
    signInWithPassword: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    updateUser: vi.fn(async () => ({ error: null })),
  };
  const client = {
    auth: { auth },
    checkInvitation: vi.fn(async () => ({
      email: "invited@example.test",
      role: "Reviewer",
      expires_at: "2026-10-20T00:00:00Z",
    })),
  };
  return { auth, api: client, client: client as unknown as BackendClient };
}
describe("invitation-only email authentication", () => {
  it("retains the invitation in the confirmation redirect without placing it in the query string", () => {
    const token = "a".repeat(64);
    const redirect = new URL(authRedirect(false, token));
    expect(redirect.hash).toBe(`#/invite/${token}`);
    expect(redirect.search).not.toContain(token);
    expect(new URL(authRedirect(true, token)).hash).toBe("");
  });
  it("offers only email sign-in without public registration or social providers", async () => {
    const f = fixture();
    render(<AuthPanel client={f.client} />);
    expect(
      screen.queryByRole("button", { name: /Create/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Continue with/ }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Email address"),
      "invited@example.test",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "Synthetic-test-password",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "invited@example.test",
      password: "Synthetic-test-password",
    });
    expect(f.auth.signUp).not.toHaveBeenCalled();
  });
  it("checks an invitation before offering account creation and waits for email confirmation", async () => {
    const f = fixture();
    render(<AuthPanel client={f.client} invitationToken={"a".repeat(64)} />);
    await screen.findByText("Accept your invitation");
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "invited@example.test",
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Password"),
      "Synthetic-test-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "Synthetic-test-password",
    );
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText(/Check your email for the confirmation link/);
    expect(f.auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "invited@example.test",
        options: { emailRedirectTo: expect.stringContaining("mode=connected") },
      }),
    );
  });
  it("does not permit registration from an invalid or revoked invitation", async () => {
    const f = fixture();
    f.api.checkInvitation.mockRejectedValue(new Error("Invitation revoked"));
    render(<AuthPanel client={f.client} invitationToken={"b".repeat(64)} />);
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();
    expect(f.auth.signUp).not.toHaveBeenCalled();
  });
  it("disables the form until the invitation check finishes", async () => {
    const f = fixture();
    let resolveCheck!: (value: {
      email: string;
      role: string;
      expires_at: string;
    }) => void;
    f.api.checkInvitation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    render(<AuthPanel client={f.client} invitationToken={"a".repeat(64)} />);
    expect(screen.getByText("Checking your invitation…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Email address")).toBeDisabled();
    await act(async () =>
      resolveCheck({
        email: "invited@example.test",
        role: "Reviewer",
        expires_at: "2026-10-20T00:00:00Z",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(f.auth.signUp).not.toHaveBeenCalled();
  });
  it("clears the old invitation and password when a different invitation fails", async () => {
    const f = fixture();
    const { rerender } = render(
      <AuthPanel client={f.client} invitationToken={"a".repeat(64)} />,
    );
    await screen.findByText("Accept your invitation");
    await userEvent.type(
      screen.getByLabelText("Password"),
      "Synthetic-test-password",
    );
    f.api.checkInvitation.mockRejectedValueOnce(
      new Error("Invitation expired"),
    );
    rerender(<AuthPanel client={f.client} invitationToken={"b".repeat(64)} />);
    await screen.findByText("Invitation expired");
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(f.auth.signUp).not.toHaveBeenCalled();
  });
  it("keeps failed sign-in explicit and never invents a session", async () => {
    const f = fixture();
    f.auth.signInWithPassword.mockRejectedValue(
      new Error("Invalid login credentials"),
    );
    render(<AuthPanel client={f.client} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Email address"),
      "invited@example.test",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "Synthetic-wrong-password",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Invalid login credentials");
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "invited@example.test",
    );
  });
  it("changes the password only after recovery confirmation succeeds", async () => {
    const f = fixture(),
      done = vi.fn();
    render(<AuthPanel client={f.client} recovery onRecoveryDone={done} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("New password"),
      "Synthetic-new-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "Synthetic-new-password",
    );
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(f.auth.updateUser).toHaveBeenCalledWith({
      password: "Synthetic-new-password",
    });
  });
});
