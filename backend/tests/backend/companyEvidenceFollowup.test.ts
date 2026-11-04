import { expect, it } from "vitest";
import { followupCompanyEvidence } from "../../supabase/functions/_shared/companyEvidenceFollowup.ts";
import type {
  Evidence,
  Reference,
} from "../../supabase/functions/_shared/model.ts";
const source = (
  id: string,
  text: string,
): Evidence & { reference: Reference } => ({
  id,
  text,
  kind: "company",
  verified: true,
  reference: {
    entity_kind: "knowledge",
    entity_id: id,
    content_hash: "a".repeat(64),
  },
});
const irrelevant = "Unrelated historical material. ".repeat(1800);
it("actively retrieves late seventh-source evidence and suffix qualifiers beyond the whole-source budget", () => {
  const sources = Array.from({ length: 6 }, (_, i) =>
    source(`s${i}`, "Unrelated record."),
  );
  sources.push(
    source(
      "s7",
      irrelevant +
        "\n\nIntroduction.\n\nWe deliver cybersecurity assessments.\n\nEvidence note.\n\n" +
        irrelevant +
        "\n\nOnly for private networks; never certified government systems.",
    ),
  );
  const result = followupCompanyEvidence(
    sources,
    [{ id: "r", text: "cybersecurity assessments" }],
    4000,
  );
  expect(result.coverage.followup_performed).toBe(true);
  const evidence = result.evidence.find((s) => s.id === "s7");
  expect(evidence?.text).toContain("Only for private networks");
  expect(result.claimEligibleIds).not.toContain("s7");
  expect(result.coverage.capability_absence_proven).toBe(false);
});
it("retains decisive middle paragraph and distant qualifier with bounded small neighboring paragraphs", () => {
  const s = source(
    "large",
    irrelevant +
      "\n\nIntroduction.\n\nWe provide security assessments.\n\nEvidence note.\n\n" +
      irrelevant +
      "\n\nOnly for private systems.",
  );
  const result = followupCompanyEvidence(
    [s],
    [{ id: "r", text: "security assessments" }],
    3000,
  );
  expect(result.evidence[0].text).toContain("We provide security assessments");
  expect(result.evidence[0].text).toContain("Only for private systems");
  expect(result.claimEligibleIds).toEqual([]);
  for (const span of result.coverage.spans)
    expect(
      Array.from(s.text).slice(span.start, span.end).join(""),
    ).not.toContain("omitted source");
});
it.each(["مطلوب تدريب وورش عمل", "Workshops and training"])(
  "expands bounded bilingual retrieval hints for %s without asserting support",
  (query) => {
    const s = source(
      "late",
      irrelevant +
        "\n\nIntroduction.\n\nWe offer training workshops. نقدم التدريب وورش العمل.\n\nEvidence note.\n\n" +
        irrelevant,
    );
    const result = followupCompanyEvidence(
      [s],
      [{ id: "r", text: query }],
      3000,
    );
    expect(result.evidence[0].text).toContain("training workshops");
    expect(result.coverage.selection_complete).toBe(false);
  },
);
it("keeps oversized paragraphs explicit rather than truncating a hidden exception", () => {
  const result = followupCompanyEvidence(
    [
      source(
        "oversized",
        "Security assessment " + irrelevant + " except government systems",
      ),
    ],
    [{ id: "r", text: "security" }],
    1000,
  );
  expect(result.evidence).toEqual([]);
  expect(result.coverage.gap).toBe("context_capacity");
});
it("excludes unverified/style evidence and preserves full-source claims when bounded", () => {
  const full = source("full", "We provide workflow training."),
    style = {
      ...source("style", "We provide workflow training."),
      kind: "style" as const,
    },
    unverified = { ...full, id: "unverified", verified: false };
  const result = followupCompanyEvidence(
    [style, unverified, full],
    [{ id: "r", text: "training" }],
  );
  expect(result.evidence.map((s) => s.id)).toEqual(["full"]);
  expect(result.claimEligibleIds).toEqual(["full"]);
});
it("retains already admitted complete priority proof when an omitted fragment would consume its space", () => {
  const full = source(
    "priority",
    "Verified workflow security approval training evidence. ".repeat(38),
  );
  const huge = source(
    "large",
    irrelevant +
      "\n\nIntroduction.\n\nWorkflow approval security training discovery. ".repeat(
        30,
      ) +
      "\n\nOnly for private systems.\n\n" +
      irrelevant,
  );
  const result = followupCompanyEvidence(
    [full, huge],
    [{ id: "r", text: "Workflow approval security training" }],
    3500,
    ["priority"],
  );
  expect(result.evidence.find((e) => e.id === "priority")).toEqual(full);
  expect(result.claimEligibleIds).toContain("priority");
  expect(result.coverage.cited_source_coverage_complete).toBe(true);
});
