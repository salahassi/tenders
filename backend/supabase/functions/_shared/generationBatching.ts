type Requirement = Record<string, any>;

/** The exact requirement projection sent to downstream models. Source quotes
 * remain in the separately selected evidence, rather than duplicated here. */
export const requirementModelContext = ({
  id,
  text,
  category,
  mandatory,
  interpretation,
  acceptance_evidence,
  owner_question,
}: Requirement) => ({
  id,
  text,
  category,
  mandatory,
  interpretation,
  acceptance_evidence,
  owner_question,
});

/** Pack only newly scheduled mapping/review work. These tasks return bounded
 * requirement records; prose drafting and commercial expansion retain their
 * smaller batches. This is a scheduling bound, not a token quota or permission
 * to omit text. Oversized individual requirements remain intact and use the
 * existing model context/truncation handling. Stored steps are never repacked. */
export function batchGenerationRequirements<T extends Requirement>(
  requirements: T[],
  task: "plan_proposal" | "review_proposal",
): T[][] {
  const maximum = task === "plan_proposal" ? 24 : 12;
  const batches: T[][] = [];
  let current: T[] = [],
    size = 2; // JSON array brackets.
  for (const requirement of requirements) {
    const length = JSON.stringify(requirementModelContext(requirement)).length;
    if (
      current.length &&
      (current.length >= maximum || size + 1 + length > 12000)
    ) {
      batches.push(current);
      current = [];
      size = 2;
    }
    size += (current.length ? 1 : 0) + length;
    current.push(requirement);
  }
  if (current.length) batches.push(current);
  return batches;
}
