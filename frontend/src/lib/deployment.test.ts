import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete window.__TENDERDESK_CONFIG__;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public deployment settings", () => {
  it("uses the mounted runtime settings ahead of stale build settings", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://old.example.test");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "old-public-key");
    vi.stubEnv("VITE_APP_ORIGIN", "https://old-app.example.test");
    window.__TENDERDESK_CONFIG__ = {
      apiUrl: " https://new.example.test/ ",
      publishableKey: "new-public-key",
      appOrigin: "https://new.example.test/",
    };
    const { deployment } = await import("./deployment");
    expect(deployment).toEqual({
      projectUrl: "https://new.example.test",
      publishableKey: "new-public-key",
      appOrigin: "https://new.example.test",
    });
  });

  it("fails closed without a public key and never selects a prior backend", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_APP_ORIGIN", "");
    const { deployment } = await import("./deployment");
    const { configuredBackend } = await import("./backendClient");
    expect(deployment.projectUrl).toBe(window.location.origin);
    expect(deployment.publishableKey).toBe("");
    expect(() => configuredBackend()).toThrow(/need to be configured/);
  });

  it("does not mix a new runtime endpoint with an old build's public key", async () => {
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "old-public-key");
    window.__TENDERDESK_CONFIG__ = { apiUrl: "https://new.example.test" };
    const { deployment } = await import("./deployment");
    expect(deployment.projectUrl).toBe("https://new.example.test");
    expect(deployment.publishableKey).toBe("");
  });
});
