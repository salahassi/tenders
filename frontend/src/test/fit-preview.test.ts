// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getFitPreview } from "../lib/fitPreview";
import { createSeedState } from "./fixtures/workspace";
const seed = () => createSeedState(new Date("2026-11-10T10:30:00Z"));
describe("fit assessment without an activated provider", () => {
  it("never supplies canned assessments, including for former fixture IDs", () => {
    const state = seed();
    const before = structuredClone(state);
    for (const opportunity of state.opportunities) {
      expect(getFitPreview(state, opportunity)).toMatchObject({
        mode: "unassessed",
        level: "Assessment required",
        reasons: [],
      });
    }
    expect(state).toEqual(before);
  });
  it("does not borrow a fixture assessment for custom or imported data", () => {
    const state = seed();
    expect(
      getFitPreview(state, {
        ...state.opportunities[1],
        id: "imported-real-opportunity",
      }),
    ).toMatchObject({ mode: "unassessed", level: "Assessment required", reasons: [] });
    expect(
      getFitPreview(state, { ...state.opportunities[1], sourceId: "manual" }),
    ).toMatchObject({ mode: "unassessed", level: "Assessment required", reasons: [] });
  });
});
