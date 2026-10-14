import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createClient } from "@supabase/supabase-js";
import { get, set } from "idb-keyval";
import { AppProvider } from "./store";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  })),
}));
vi.mock("idb-keyval", () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
});

describe("connected-only application entry", () => {
  it.each(["", "?mode=demo", "?mode=connected"])(
    "requires sign-in with query %s even with legacy DEMO configuration",
    async (query) => {
      vi.stubEnv("VITE_APP_MODE", "DEMO");
      window.history.replaceState(null, "", "/" + query);
      render(
        <AppProvider>
          <p>Private workspace</p>
        </AppProvider>,
      );
      expect(
        await screen.findByRole("heading", { name: "Sign in to Tenderdesk" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Private workspace")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /demo/i }),
      ).not.toBeInTheDocument();
      expect(createClient).toHaveBeenCalledOnce();
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it("shows configuration errors without opening a local workspace", () => {
    vi.mocked(createClient).mockImplementationOnce(() => {
      throw new Error("Connection configuration unavailable");
    });
    render(
      <AppProvider>
        <p>Private workspace</p>
      </AppProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Connection configuration unavailable",
    );
    expect(screen.queryByText("Private workspace")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /demo/i }),
    ).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
