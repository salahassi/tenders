import { afterEach, describe, expect, it } from "vitest";
import {
  clearPasswordRecovery,
  parseAuthCallback,
  passwordRecoveryPending,
  takeRecoveryTokens,
} from "./authCallback";

afterEach(() => {
  clearPasswordRecovery();
});

describe("parseAuthCallback", () => {
  it("recognizes a recovery hash before the router can discard it", () => {
    const parsed = parseAuthCallback(
      "https://salahassi.github.io/tenders/#access_token=aaa&refresh_token=bbb&type=recovery",
    );
    expect(parsed.recovery).toBe(true);
    expect(parsed.tokens).toEqual({
      access_token: "aaa",
      refresh_token: "bbb",
    });
  });

  it("recognizes the reset redirect query without treating it as a normal visit", () => {
    const parsed = parseAuthCallback(
      "https://salahassi.github.io/tenders/?auth=recovery&code=pkce-code",
    );
    expect(parsed.recovery).toBe(true);
    expect(parsed.hasCode).toBe(true);
    expect(parsed.tokens).toBeNull();
  });

  it("keeps an expired-link error", () => {
    const parsed = parseAuthCallback(
      "https://salahassi.github.io/tenders/?error_description=Email+link+is+invalid+or+has+expired&auth=recovery",
    );
    expect(parsed.recovery).toBe(true);
    expect(parsed.error).toMatch(/invalid or has expired/i);
  });
});

describe("recovery token handoff", () => {
  it("keeps stashed tokens available until reset finishes", () => {
    sessionStorage.setItem(
      "tenderdesk:recovery-tokens",
      JSON.stringify({ access_token: "aaa", refresh_token: "bbb" }),
    );
    sessionStorage.setItem("tenderdesk:password-recovery", "1");
    expect(passwordRecoveryPending()).toBe(true);
    expect(takeRecoveryTokens()).toEqual({
      access_token: "aaa",
      refresh_token: "bbb",
    });
    expect(takeRecoveryTokens()).toEqual({
      access_token: "aaa",
      refresh_token: "bbb",
    });
  });
});
