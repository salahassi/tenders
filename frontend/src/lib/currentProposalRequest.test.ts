import { expect, it } from "vitest";
import {
  currentProposalRequest,
  currentProposalCommands,
} from "./currentProposalRequest";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const recovery = () => ({
  plan_id: id(1),
  expected_plan_revision: 3,
  preserved_input_hash: "a".repeat(64),
  cancel_required: true,
  opportunity_id: id(2),
  expected_opportunity_revision: 4,
  proposal_id: id(3),
  expected_proposal_revision: 5,
  base_version_id: null,
  next_operation: "proposal.generate" as const,
});
it("binds an explicit cancellation and first successor to server identities in one batch", async () => {
  const d = currentProposalRequest(recovery(), id(2));
  expect(d).not.toBeNull();
  const commands = await currentProposalCommands(d!);
  expect(commands.map((c) => c.operation)).toEqual([
    "generation.cancel",
    "proposal.generate",
  ]);
  expect(commands[1].input).toEqual({ id: id(2), expected_revision: 4 });
});
it("preserves an accepted version and makes a stable regeneration command without canceling a terminal plan", async () => {
  const d = currentProposalRequest(
    {
      ...recovery(),
      cancel_required: false,
      next_operation: "proposal.regenerate",
      base_version_id: id(4),
    },
    id(2),
  )!;
  const first = await currentProposalCommands(d);
  expect(first).toEqual(await currentProposalCommands(d));
  expect(first).toEqual([
    {
      operation: "proposal.regenerate",
      input: {
        id: id(3),
        expected_revision: 5,
        base_version_id: id(4),
        input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  ]);
});
it.each([
  { opportunity_id: id(9) },
  { plan_id: "bad" },
  { expected_plan_revision: -1 },
  { cancel_required: "true" },
  { expected_opportunity_revision: null },
  { next_operation: "job.action" },
  { next_operation: "proposal.regenerate", base_version_id: null },
  { base_version_id: id(4) },
  { preserved_input_hash: "bad" },
])("rejects inconsistent recovery metadata %j", (patch) => {
  expect(currentProposalRequest({ ...recovery(), ...patch }, id(2))).toBeNull();
});
