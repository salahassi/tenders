// @vitest-environment node
import { it, expect } from "vitest";
import {
  prepareSplit,
  evaluateHoldout,
  proportion,
} from "../../packages/evaluation";
const fixtures = () =>
  Array.from({ length: 20 }, (_, i) => ({
    id: "synthetic-" + i,
    title: [
      "solar",
      "hospital",
      "library",
      "transport",
      "education",
      "water",
      "finance",
      "museum",
      "housing",
      "science",
      "courts",
      "roads",
      "airports",
      "farms",
      "mines",
      "tourism",
      "archives",
      "energy",
      "utilities",
      "environment",
    ][i],
    description: "Unique scope " + String.fromCharCode(97 + i).repeat(12),
    buyer: "Synthetic buyer " + i,
    reference: "REF-" + i,
    label: i % 3 === 0 ? "uncertain" : i % 2 === 0 ? "suitable" : "unsuitable",
  }));
it("keeps exact and near duplicates together and freezes a deterministic held-out split", () => {
  const rows = fixtures();
  rows[1] = {
    ...rows[0],
    id: "duplicate",
    description: rows[0].description + " ",
  };
  const first = prepareSplit(rows, "fixed", true),
    second = prepareSplit([...rows].reverse(), "fixed", true);
  expect(first).toEqual(second);
  expect(
    first.manifest.groups.some(
      (g) => g.includes(rows[0].id) && g.includes("duplicate"),
    ),
  ).toBe(true);
  expect(first.holdout.some((x) => x.id === "duplicate")).toBe(
    first.holdout.some((x) => x.id === rows[0].id),
  );
  expect(first.holdoutInputs.every((x) => !("label" in x))).toBe(true);
});
it("reports counts, uncertainty and citation audit gaps without declaring synthetic business accuracy", () => {
  const split = prepareSplit(fixtures(), "fixed", true),
    predictions = split.holdout.map((x) => ({
      id: x.id,
      routing: x.label === "suitable" ? "recommended" : "needs_review",
      citation_errors: null,
    }));
  const report = evaluateHoldout(split, predictions);
  expect(report.recommendation_precision.value).toBe(1);
  expect(report.recommendation_recall.value).toBe(1);
  expect(report.recommendation_precision.wilson_95![0]).toBeLessThan(1);
  expect(report.citation_audit_pending).toHaveLength(split.holdout.length);
  expect(report.business_accuracy_validated).toBe(false);
  expect(() => evaluateHoldout(split, predictions.slice(1))).toThrow(
    "exactly once",
  );
  split.holdout[0].description += "changed";
  expect(() => evaluateHoldout(split, predictions)).toThrow("frozen split");
});
it("does not invent precision for an empty positive set or accept too few human labels", () => {
  expect(proportion(0, 0).value).toBeNull();
  expect(proportion(0, 10).wilson_95![0]).toBe(0);
  expect(() => prepareSplit(fixtures(), "fixed")).toThrow();
});
