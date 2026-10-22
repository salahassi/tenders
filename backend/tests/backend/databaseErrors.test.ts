// @vitest-environment node
import { expect, it } from "vitest";
import { databaseError } from "../../supabase/functions/_shared/http";

it.each(["57014", "55P03", "40P01", "40001"])(
  "retries transaction-aborted SQLSTATE %s without disclosing diagnostics",
  (code) => {
    const result = databaseError({
      code,
      message: "private database diagnostic",
      details: "private SQL parameters",
    });
    expect(result).toMatchObject({
      status: 503,
      code: "DATABASE_TEMPORARY_FAILURE",
      retryable: true,
      details: { sqlstate: code },
    });
    expect(result.message).not.toContain("private");
  },
);

it.each(["42501", "42P01", "23505", "23514", "08006", undefined])(
  "does not silently retry permission, schema, constraint or ambiguous failure %s",
  (code) => {
    expect(
      databaseError({ code, message: "private diagnostic" }),
    ).toMatchObject({
      status: 422,
      code: "DATABASE_COMMAND_FAILED",
      retryable: false,
      details: null,
    });
  },
);

it("preserves explicit domain error classification", () => {
  expect(
    databaseError({ code: "P0001", message: "STALE_LEASE" }),
  ).toMatchObject({
    status: 409,
    code: "STALE_LEASE",
    retryable: false,
  });
});
