import { afterEach, describe, expect, it } from "vitest";
import { clearPendingInvitation, readPendingInvitation } from "./invitations";

afterEach(() => {
  clearPendingInvitation();
  window.history.replaceState(null, "", "/");
});

describe("readPendingInvitation", () => {
  it("reads invite tokens from HashRouter pathname", () => {
    const token = "a".repeat(64);
    expect(readPendingInvitation(`/invite/${token}`)).toBe(token);
    expect(sessionStorage.getItem("tenderdesk:pending-invitation")).toBe(token);
  });

  it("falls back to session storage after capture", () => {
    const token = "b".repeat(64);
    readPendingInvitation(`/invite/${token}`);
    expect(readPendingInvitation("/")).toBe(token);
  });
});
