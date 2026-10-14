import { describe, expect, it } from "vitest";
import {
  can,
  canApplyMutation,
  getApprovalBlockers,
  invalidateChangedApprovals,
} from "./domain";
import { createSeedState } from "../test/fixtures/workspace";
import { parseBackup, serializeBackup } from "./legacyBackup";

describe("proposal approval and role controls", () => {
  const seed = () => createSeedState(new Date("2026-10-14T10:00:00Z"));
  it("exposes genuine blockers and a complete reviewable synthetic proposal", () => {
    const state = seed();
    expect(
      getApprovalBlockers(state, state.proposals[0]).length,
    ).toBeGreaterThan(0);
    expect(getApprovalBlockers(state, state.proposals[1])).toEqual([]);
    expect(getApprovalBlockers(state, state.proposals[2])).toEqual([]);
  });
  it("invalidates the exact approval after content changes without double-incrementing", () => {
    const before = seed(),
      next = structuredClone(before);
    next.proposals[2].sections[0].body += " Revised scope.";
    next.proposals[2].version = 4;
    expect(invalidateChangedApprovals(before, next).proposals[2]).toMatchObject(
      { status: "draft", approvalVersion: null, version: 4 },
    );
    expect(before.proposals[2]).toMatchObject({
      status: "approved",
      approvalVersion: 3,
      version: 3,
    });
  });
  it("invalidates only the related proposal when its RFP evidence changes", () => {
    const before = seed(),
      next = structuredClone(before);
    next.opportunities[4].requirements[0].text += " Addendum.";
    const result = invalidateChangedApprovals(before, next);
    expect(result.proposals[2].approvalVersion).toBeNull();
    expect(result.proposals[1]).toEqual(before.proposals[1]);
  });
  it("preserves approvals for a comment or a shortlist decision", () => {
    const before = seed(),
      next = structuredClone(before);
    next.proposals[2].comments.push({
      id: "c",
      body: "Noted.",
      author: "Demo Reviewer",
      at: new Date().toISOString(),
    });
    next.opportunities[4].status = "shortlisted";
    expect(invalidateChangedApprovals(before, next).proposals[2]).toMatchObject(
      { approvalVersion: 3, version: 3, status: "approved" },
    );
  });
  it("denies unknown capabilities and reserves approval and final export for Owner", () => {
    expect(can("Owner", "approve")).toBe(true);
    expect(can("Editor", "approve")).toBe(false);
    expect(can("Reviewer", "edit")).toBe(false);
    expect(can("Reviewer", "review")).toBe(true);
    expect(can("Reviewer", "export_draft")).toBe(true);
    expect(can("Editor", "export_final")).toBe(false);
    expect(can("Owner", "unknown-action")).toBe(false);
  });
  it("enforces role mutations below the UI while permitting explicit demo role simulation", () => {
    const before = seed();
    before.settings.role = "Reviewer";
    const edit = structuredClone(before);
    edit.opportunities[0].title = "Changed";
    expect(canApplyMutation(before, edit)).toBe(false);
    const roleSwitch = structuredClone(before);
    roleSwitch.settings.role = "Owner";
    expect(canApplyMutation(before, roleSwitch)).toBe(true);
    const comment = structuredClone(before);
    comment.proposals[0].comments.push({
      id: "c",
      body: "Review note",
      at: new Date().toISOString(),
      author: "Demo Reviewer",
    });
    expect(canApplyMutation(before, comment)).toBe(true);
  });
  it("prevents editors from approving a source, a proposal, or acquisition", () => {
    const before = seed();
    before.settings.role = "Editor";
    const source = structuredClone(before);
    source.sources[2].status = "approved";
    expect(canApplyMutation(before, source)).toBe(false);
    const proposal = structuredClone(before);
    proposal.proposals[0].status = "approved";
    expect(canApplyMutation(before, proposal)).toBe(false);
    const acquisition = structuredClone(before);
    acquisition.opportunities[1].acquisition = "approved";
    expect(canApplyMutation(before, acquisition)).toBe(false);
  });
  it("uses the Riyadh calendar day for relative fixture deadlines", () => {
    const state = createSeedState(new Date("2026-10-14T22:00:00Z"));
    expect(state.opportunities[0].deadline).toBe("2026-10-27T09:00:00.000Z");
    expect(state.opportunities).toHaveLength(12);
    expect(
      state.opportunities.every((item) => item.buyer.includes("fictional")),
    ).toBe(true);
  });
  it("round-trips a typed backup without losing approvals or evidence", () => {
    const state = seed();
    expect(parseBackup(serializeBackup(state))).toEqual(state);
  });
  it("rejects broken references and unsafe links in imported backups", () => {
    const backup = JSON.parse(serializeBackup(seed()));
    backup.state.proposals[0].opportunityId = "missing";
    expect(() => parseBackup(JSON.stringify(backup))).toThrow(
      "missing opportunity",
    );
    backup.state.proposals[0].opportunityId = "opp-1";
    backup.state.opportunities[0].sourceUrl = "javascript:alert(1)";
    expect(() => parseBackup(JSON.stringify(backup))).toThrow("HTTPS");
  });
  it("blocks approval when commercial terms are absent", () => {
    const state = seed();
    state.proposals[1].sections = state.proposals[1].sections.filter(
      (item) => item.id !== "commercial-assumptions",
    );
    expect(getApprovalBlockers(state, state.proposals[1])).toContain(
      "Add commercial terms covering offer validity and payment milestones.",
    );
  });
});
