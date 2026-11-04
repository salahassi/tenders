/** Server-owned identities for an explicit successor; never infer them from UI state. */
export interface CurrentProposalRequest {
  plan_id: string;
  expected_plan_revision: number;
  preserved_input_hash: string;
  cancel_required: boolean;
  opportunity_id: string;
  expected_opportunity_revision: number;
  proposal_id: string | null;
  expected_proposal_revision: number | null;
  base_version_id: string | null;
  next_operation: "proposal.generate" | "proposal.regenerate";
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function currentProposalRequest(
  value: unknown,
  opportunityId: string,
): CurrentProposalRequest | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (
    !uuid(d.plan_id) ||
    !revision(d.expected_plan_revision) ||
    typeof d.preserved_input_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(d.preserved_input_hash) ||
    typeof d.cancel_required !== "boolean" ||
    d.opportunity_id !== opportunityId ||
    !uuid(d.opportunity_id) ||
    !revision(d.expected_opportunity_revision) ||
    !(d.proposal_id === null || uuid(d.proposal_id)) ||
    !(
      d.expected_proposal_revision === null ||
      revision(d.expected_proposal_revision)
    ) ||
    !(d.base_version_id === null || uuid(d.base_version_id))
  )
    return null;
  if (
    d.next_operation === "proposal.generate"
      ? d.base_version_id !== null
      : d.next_operation !== "proposal.regenerate" ||
        !uuid(d.proposal_id) ||
        !uuid(d.base_version_id) ||
        !revision(d.expected_proposal_revision)
  )
    return null;
  return {
    plan_id: d.plan_id,
    expected_plan_revision: d.expected_plan_revision,
    preserved_input_hash: d.preserved_input_hash,
    cancel_required: d.cancel_required,
    opportunity_id: d.opportunity_id,
    expected_opportunity_revision: d.expected_opportunity_revision,
    proposal_id: d.proposal_id,
    expected_proposal_revision: d.expected_proposal_revision,
    base_version_id: d.base_version_id,
    next_operation: d.next_operation,
  } as CurrentProposalRequest;
}

export async function currentProposalCommands(d: CurrentProposalRequest) {
  // This identifies the explicit successor command. The server independently
  // constructs and hashes the new frozen evidence snapshot.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(d)),
  );
  const inputHash = [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return [
    ...(d.cancel_required
      ? [
          {
            operation: "generation.cancel",
            input: {
              id: d.plan_id,
              expected_revision: d.expected_plan_revision,
              reason:
                "User explicitly requested a current proposal request; preserve the original saved work.",
            },
          },
        ]
      : []),
    {
      operation: d.next_operation,
      input:
        d.next_operation === "proposal.generate"
          ? {
              id: d.opportunity_id,
              expected_revision: d.expected_opportunity_revision,
            }
          : {
              id: d.proposal_id,
              expected_revision: d.expected_proposal_revision,
              base_version_id: d.base_version_id,
              input_hash: inputHash,
            },
    },
  ];
}
