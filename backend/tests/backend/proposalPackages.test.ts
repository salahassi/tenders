// @vitest-environment node
import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import { validateModelResult } from "../../supabase/functions/_shared/model";
import { commercialHelpers } from "./commercialFixture";
import { workflowFixture } from "./workflowFixture";
it("checks increasing synthetic RFP packages for complete grounded inventory, missing-credential questions and isolated buyer content", async () => {
  let previous = 0;
  for (const size of ["small", "medium", "large"]) {
    const p = JSON.parse(
      await readFile(
        new URL(`../../fixtures/evaluation/${size}.json`, import.meta.url),
        "utf8",
      ),
    );
    const length = JSON.stringify(p.blocks).length;
    expect(length).toBeGreaterThan(previous);
    previous = length;
    const outputs = p.blocks.map((b: any) => {
      const requirements = p.requirements.filter(
        (r: any) => r.source_id === b.id,
      );
      return validateModelResult(
        "analyze_chunk",
        {
          processed_block_ids: [b.id],
          requirements: requirements.map((r: any) => ({
            text: r.text,
            category: "functional",
            mandatory: true,
            source_refs: [{ id: b.id, quote: r.quote }],
            interpretation: "Synthetic workflow step",
            acceptance_evidence: "Demonstrate the named step",
            owner_question: null,
          })),
          questions: p.required_questions.map((question: string) => ({
            question,
            blocking_level: "finalization",
            requirement_ids: [],
          })),
          separate_volumes: false,
          summary: "Recorded synthetic output; no model called.",
        },
        [b],
        [b.id],
      );
    });
    expect(outputs.flatMap((x: any) => x.requirements)).toHaveLength(
      p.requirements.length,
    );
    expect(
      outputs
        .flatMap((x: any) => x.questions)
        .some((q: any) => q.question.includes("credentials")),
    ).toBe(true);
    for (const other of ["SMALL", "MEDIUM", "LARGE"].filter(
      (x) => x !== size.toUpperCase(),
    ))
      expect(JSON.stringify(outputs)).not.toContain(`SYNTHETIC ${other} BUYER`);
    const altered = {
      ...outputs[0],
      requirements: [
        {
          ...outputs[0].requirements[0],
          source_refs: [
            { id: p.blocks[0].id, quote: "Invented certification" },
          ],
        },
      ],
    };
    expect(() =>
      validateModelResult("analyze_chunk", altered, p.blocks, [p.blocks[0].id]),
    ).toThrow("EVIDENCE_REFERENCE_INVALID");
  }
});
it("ties each package's expected financial result to the same verified decimal calculator", async () => {
  const f = await workflowFixture();
  try {
    await f.db.exec("begin");
    const h = commercialHelpers(f),
      s = await h.setup();
    s.input.lines[0].quantity = "11";
    const actual = await h.calculate(s);
    for (const size of ["small", "medium", "large"]) {
      const p = JSON.parse(
        await readFile(
          new URL(`../../fixtures/evaluation/${size}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(actual.calculated.display_gross).toBe(p.expected_commercial_gross);
    }
  } finally {
    await f.db.close();
  }
});
