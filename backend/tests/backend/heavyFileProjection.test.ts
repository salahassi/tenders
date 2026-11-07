// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Backend } from "../../supabase/functions/_shared/backend";
import {
  heavyFileReadResources,
  isHeavyFileRequest,
  jsonBytesUpperBound,
  FULL_LIST_PAGE_BYTES,
} from "../../supabase/functions/_shared/heavyFileProjection";

it.each(Object.keys(heavyFileReadResources))(
  "admits full-content %s reads before any record projection",
  (resource) => {
    expect(isHeavyFileRequest("GET", `/v1/${resource}?limit=100`)).toBe(true);
    expect(isHeavyFileRequest("GET", `/v1/${resource}/synthetic-id`)).toBe(
      true,
    );
  },
);
it.each([
  ["GET", "/v1/generation-plans/id"],
  ["GET", "/v1/restore-sessions/id"],
  ["GET", "/v1/documents/id/download"],
  ["GET", "/v1/recovery/manifest"],
  ["GET", "/v1/delivery-snapshots/id/context"],
  ["GET", "/v1/delivery-snapshots/id/package"],
  ["GET", "/v1/exports/id/context"],
  ["GET", "/v1/proposal-authoring/id/context"],
  ["POST", "/v1/commands"],
  ["POST", "/v1/proposals/id/regenerate"],
  ["POST", "/v1/estimates"],
  ["POST", "/v1/deliveries"],
  ["POST", "/v1/knowledge"],
  ["PATCH", "/v1/knowledge/id"],
  ["POST", "/v1/knowledge/id/verify"],
  ["POST", "/v1/opportunities/id/archive"],
  ["POST", "/v1/jobs/id/actions"],
  ["POST", "/v1/opportunities"],
  ["PATCH", "/v1/opportunities/id"],
  ["PUT", "/v1/proposals/id/review-inputs"],
])("covers full-content projection %s %s", (method, path) => {
  expect(isHeavyFileRequest(method, path)).toBe(true);
});

function tableFixture(rows: Array<Record<string, unknown>>) {
  const selections: string[] = [],
    limits: number[] = [],
    cursors: string[] = [];
  const client = {
    from: vi.fn(() => {
      let limit = 0,
        cursor: string | undefined;
      const query = {
        select(value: string) {
          selections.push(value);
          return query;
        },
        order() {
          return query;
        },
        limit(value: number) {
          limits.push(value);
          limit = value;
          return query;
        },
        eq() {
          return query;
        },
        gt(_column: string, value: string) {
          cursors.push(value);
          cursor = value;
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(
            resolve({
              error: null,
              data: rows
                .filter((row) => !cursor || String(row.id) > cursor)
                .slice(0, limit),
            }),
          );
        },
      };
      return query;
    }),
  };
  const user = vi.fn(() => client);
  return { user, selections, limits, cursors };
}

it.each(["opportunities", "fit_assessments", "source_runs"])(
  "returns all 119 small full %s rows in two HTTP pages while reading individual DB rows",
  async (table) => {
    const records = Array.from({ length: 119 }, (_, n) => ({
      id: String(n).padStart(4, "0"),
      revision: 1,
      text: "Complete requirement: quantity 0; optional unless approved.",
      semantic: { required: false, quantity: 0, condition: null },
    }));
    const fake = tableFixture(records);
    const first = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      table,
      { workspace_id: "workspace" },
      100,
    );
    const last = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      table,
      { workspace_id: "workspace" },
      100,
      first.next_cursor!,
    );
    expect(first.records).toEqual(records.slice(0, 100));
    expect(last.records).toEqual(records.slice(100));
    expect(last.next_cursor).toBeNull();
    expect(fake.limits.every((n) => n === 1)).toBe(true);
    expect(fake.selections.every((s) => s === "*")).toBe(true);
  },
);

it("defers a non-fitting complete row without skipping it or fetching a second large row", async () => {
  const records = [
    { id: "a", text: "small" },
    { id: "b", text: "ب".repeat(FULL_LIST_PAGE_BYTES) },
    { id: "c", text: "tail" },
  ];
  const fake = tableFixture(records),
    all: unknown[] = [];
  let cursor: string | undefined;
  const sizes = [];
  do {
    const page = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      "documents",
      {},
      100,
      cursor,
    );
    all.push(...page.records);
    sizes.push(page.records.length);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(all).toEqual(records);
  expect(sizes).toEqual([1, 1, 1]);
  expect(fake.cursors).toEqual(["a", "a", "b", "c"]);
});

it("bounds a page's work duration without dropping the continuation record", async () => {
  const fake = tableFixture([{ id: "a" }, { id: "b" }]);
  const clock = vi
    .spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(2001);
  try {
    const page = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      "opportunities",
      {},
      100,
    );
    expect(page.records).toEqual([{ id: "a" }]);
    expect(page.next_cursor).toBe("a");
    expect(fake.limits).toEqual([1]);
  } finally {
    clock.mockRestore();
  }
});

it("conservatively covers JSON escaping, Arabic, emoji and nested values without copying large text", () => {
  const values = [
    null,
    false,
    0,
    -2.25,
    'عربي😀\n\u0000"\\',
    { a: [1, false, null, "plain"], ع: { condition: "after approval" } },
    "x".repeat(2 * FULL_LIST_PAGE_BYTES),
  ];
  for (const value of values) {
    const actual = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(
      jsonBytesUpperBound(value, 10 * FULL_LIST_PAGE_BYTES),
    ).toBeGreaterThanOrEqual(actual);
    if (actual > FULL_LIST_PAGE_BYTES)
      expect(jsonBytesUpperBound(value, FULL_LIST_PAGE_BYTES)).toBe(
        FULL_LIST_PAGE_BYTES + 1,
      );
  }
});

it("pages complete large records one at a time with no lookahead and a lossless terminal cursor", async () => {
  const records = [
    {
      id: "a",
      extracted_text: "A".repeat(1048576),
      semantic: { required: false, quantity: 0, condition: null },
    },
    {
      id: "b",
      extracted_text: "ب".repeat(1048576),
      semantic: { required: true, quantity: "12", condition: "after approval" },
    },
  ];
  const fake = tableFixture(records),
    all: unknown[] = [];
  let cursor: string | undefined;
  const observed: Array<string | null> = [];
  do {
    const page = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      "documents",
      {},
      100,
      cursor,
    );
    expect(page.records.length).toBeLessThanOrEqual(1);
    all.push(...page.records);
    observed.push(page.next_cursor);
    cursor = page.next_cursor || undefined;
  } while (cursor);
  expect(all).toEqual(records);
  expect(observed).toEqual(["a", "b", null]);
  expect(fake.limits).toEqual([1, 1, 1]);
  expect(fake.selections).toEqual(["*", "*", "*"]);
  expect(fake.cursors).toEqual(["a", "b"]);
});

it.each([
  "model_settings",
  "model_connections",
  "generation_plans",
  "restore_sessions",
])(
  "preserves existing metadata pagination for internal %s consumers",
  async (table) => {
    const records = [
      { id: "a", enabled: false },
      { id: "b", enabled: true },
    ];
    const fake = tableFixture(records);
    const page = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      table,
      {},
      10,
    );
    expect(page.records).toEqual(records);
    expect(page.next_cursor).toBeNull();
    expect(fake.limits).toEqual([11]);
  },
);

it("reads 1201 job summaries in three pages while retaining full one-row job reads", async () => {
  const records = Array.from({ length: 1201 }, (_, n) => ({
    id: String(n).padStart(6, "0"),
    revision: 1,
    status: "failed",
  }));
  const fake = tableFixture(records);
  const all: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await Backend.prototype.list.call(
      fake as unknown as Backend,
      "synthetic",
      "jobs",
      {},
      500,
      cursor,
      "job-summary",
    );
    all.push(...page.records);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(all).toEqual(records);
  expect(fake.limits).toEqual([501, 501, 501]);
  expect(
    fake.selections.every(
      (s) =>
        !s
          .split(",")
          .some((field) =>
            ["*", "checkpoint", "lease_token", "input_hash"].includes(field),
          ),
    ),
  ).toBe(true);
  expect(fake.selections[0]).toContain(
    "model_round:checkpoint->model_routing->round_attempts",
  );
  expect(isHeavyFileRequest("GET", "/v1/job-summaries?limit=500")).toBe(false);
  expect(isHeavyFileRequest("GET", "/v1/jobs/id")).toBe(true);
  const full = tableFixture(records);
  await Backend.prototype.list.call(
    full as unknown as Backend,
    "synthetic",
    "jobs",
    {},
    500,
  );
  expect(full.limits).toEqual([1]);
  expect(full.selections).toEqual(["*"]);
});
