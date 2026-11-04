// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Backend } from "../../supabase/functions/_shared/backend";
import {
  heavyFileReadResources,
  isHeavyFileRequest,
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
