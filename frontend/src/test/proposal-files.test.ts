// @vitest-environment node
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createSeedState } from "../lib/seed";
import { createProposalDocumentBlob } from "../lib/export";
import { buildAgentInput } from "../lib/agentInput";

async function exportedXml(
  includePricing = false,
  completePricing = false,
  arabic = false,
  currency: string | null = "SAR",
) {
  const state = createSeedState();
  const proposal = structuredClone(state.proposals[0]);
  const opportunity = structuredClone(
    state.opportunities.find((item) => item.id === proposal.opportunityId)!,
  );
  opportunity.language = arabic ? "ar" : "en";
  proposal.title = "Test proposal document";
  proposal.sections = [
    {
      id: "first",
      title: "Commercial terms",
      body: "Payment is due against accepted milestones.",
      evidence: [],
    },
    {
      id: "second",
      title: "Implementation approach",
      body: "Keep the requested section order.",
      evidence: [],
    },
    {
      id: "third",
      title: "الفريق المقترح",
      body: "تفاصيل الفريق المقترح باللغة العربية.",
      evidence: [],
    },
  ];
  proposal.includePricing = includePricing;
  proposal.currency = currency || undefined;
  proposal.lines = [
    {
      id: "line",
      description: "Delivery",
      quantity: "2",
      unit: "day",
      rate: completePricing ? "100" : "",
      optional: false,
    },
  ];
  proposal.pricingMode = "markup";
  proposal.percentage = "10";
  proposal.contingency = "0";
  proposal.tax = "0";
  const blob = await createProposalDocumentBlob(
    proposal,
    opportunity,
    "Test company",
  );
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return {
    document: await zip.file("word/document.xml")!.async("string"),
    settings: await zip.file("word/settings.xml")!.async("string"),
  };
}

describe("proposal document export", () => {
  it("exports every section in its chosen order, including commercial text, with an updateable TOC", async () => {
    const xml = await exportedXml();
    expect(xml.document).toContain(
      "Payment is due against accepted milestones.",
    );
    expect(xml.document.indexOf("Commercial terms")).toBeLessThan(
      xml.document.indexOf("Implementation approach"),
    );
    expect(xml.document).toContain("تفاصيل الفريق المقترح باللغة العربية.");
    expect(xml.document).toMatch(/TOC.*1-2/);
    expect(xml.settings).toMatch(/<w:updateFields(?:\s+w:val="true")?\s*\/>/);
    expect(xml.document).not.toContain("Pricing schedule");
    expect(xml.document).not.toContain("Compliance matrix");
  });

  it("includes an optional pricing schedule and computed totals only with complete inputs", async () => {
    const incomplete = await exportedXml(true, false);
    expect(incomplete.document).toContain("Pricing schedule");
    expect(incomplete.document).toContain(
      "Pricing is incomplete. Totals have not been included.",
    );
    expect(incomplete.document).not.toContain("Total including tax");
    const complete = await exportedXml(true, true);
    expect(complete.document).toContain("Total including tax");
    expect(complete.document).toContain("220.00");
  });

  it("preserves Arabic content and marks Arabic document paragraphs right-to-left", async () => {
    const xml = await exportedXml(false, false, true);
    expect(xml.document).toContain("المحتويات");
    expect(xml.document).toContain("<w:bidi/>");
    expect(xml.document).toContain("<w:rtl/>");
  });
  it("uses the recorded currency and withholds totals when currency is unknown", async () => {
    const usd = await exportedXml(true, true, false, "USD");
    expect(usd.document).toContain("Currency: USD");
    expect(usd.document).not.toContain("Unit cost (SAR)");
    expect(usd.document).toContain("220.00");
    const unknown = await exportedXml(true, true, false, null);
    expect(unknown.document).toContain("confirm offer currency");
    expect(unknown.document).not.toContain("Total including tax");
  });
});

describe("explicit agent text package", () => {
  it("includes readable enabled company files and reports unreadable documents without claiming to send anything", () => {
    const state = createSeedState();
    const opportunity = state.opportunities[0];
    const proposal = state.proposals.find(
      (item) => item.opportunityId === opportunity.id,
    )!;
    const base = {
      id: "team",
      name: "Team.txt",
      size: 20,
      uploadedAt: new Date().toISOString(),
      text: "Verified team profile",
      status: "ready" as const,
      classification: "synthetic" as const,
      hash: "test",
      category: "team" as const,
      enabled: true,
    };
    state.knowledgeDocuments = [
      base,
      {
        ...base,
        id: "off",
        name: "Excluded.txt",
        text: "Excluded secret",
        enabled: false,
      },
      { ...base, id: "scan", name: "Scan.pdf", text: "", status: "needs_ocr" },
    ];
    const result = buildAgentInput(state, opportunity, proposal, {
      sectionId: proposal.sections[0].id,
      instruction: "Clarify the wording.",
    });
    expect(result.companyDocuments).toHaveLength(1);
    expect(result.companyDocuments[0].text).toBe("Verified team profile");
    expect(JSON.stringify(result)).not.toContain("Excluded secret");
    expect(result.extractionLimitations.omittedDocuments).toContainEqual({
      id: "scan",
      name: "Scan.pdf",
      status: "needs_ocr",
    });
    expect(result.extractionLimitations.originalFileBytesIncluded).toBe(false);
    expect(result.rewrite?.section?.id).toBe(proposal.sections[0].id);
    expect(result.task).toBe("rewrite_section");
  });
});
