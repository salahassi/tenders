import { createHash } from "node:crypto";
import { z } from "zod";
export const exampleSchema = z
  .object({
    id: z.string().min(1).max(200),
    opportunity_group: z.string().max(200).optional(),
    title: z.string().min(1).max(2000),
    description: z.string().max(100000),
    buyer: z.string().max(1000).default(""),
    reference: z.string().max(1000).default(""),
    label: z.enum(["suitable", "unsuitable", "uncertain"]),
  })
  .strict();
export type Example = z.infer<typeof exampleSchema>;
export const predictionSchema = z
  .object({
    id: z.string(),
    routing: z.enum(["recommended", "needs_review", "low_fit", "excluded"]),
    citation_errors: z.number().int().min(0).nullable(),
    notes: z.string().max(3000).default(""),
  })
  .strict();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (value: string) =>
  new Set(normalized(value).split(" ").filter(Boolean));
function similar(a: Example, b: Example) {
  if (a.opportunity_group && a.opportunity_group === b.opportunity_group)
    return true;
  if (
    a.reference &&
    b.reference &&
    normalized(a.reference) === normalized(b.reference) &&
    normalized(a.buyer) === normalized(b.buyer)
  )
    return true;
  const left = normalized(a.title + " " + a.description),
    right = normalized(b.title + " " + b.description);
  if (left === right) return true;
  const x = words(left),
    y = words(right);
  if (Math.min(x.size, y.size) < 5) return false;
  const overlap = [...x].filter((t) => y.has(t)).length;
  return overlap / (x.size + y.size - overlap) >= 0.85;
}
export function prepareSplit(input: unknown, seed: string, synthetic = false) {
  const rows = z
    .array(exampleSchema)
    .min(synthetic ? 4 : 50)
    .max(100)
    .parse(input)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(rows.map((x) => x.id)).size !== rows.length)
    throw Error("Duplicate example ID.");
  if (!seed.trim()) throw Error("A fixed split seed is required.");
  const parent = rows.map((_, i) => i);
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++)
      if (similar(rows[i], rows[j])) parent[root(j)] = root(i);
  const groups = new Map<number, Example[]>();
  rows.forEach((row, i) =>
    groups.set(root(i), [...(groups.get(root(i)) || []), row]),
  );
  if (groups.size < 2)
    throw Error("Need at least two independent opportunity groups.");
  const ordered = [...groups.values()].sort((a, b) =>
    hash(seed + a.map((x) => x.id).join("|")).localeCompare(
      hash(seed + b.map((x) => x.id).join("|")),
    ),
  );
  const held: Example[] = [],
    development: Example[] = [];
  const target = Math.round(rows.length * 0.3);
  for (let i = 0; i < ordered.length; i++) {
    const group = ordered[i];
    if (
      (Math.abs(held.length + group.length - target) <
        Math.abs(held.length - target) ||
        held.length === 0) &&
      i < ordered.length - 1
    )
      held.push(...group);
    else development.push(...group);
  }
  const warnings: string[] = [];
  if (Math.abs(held.length / rows.length - 0.3) > 0.1)
    warnings.push("Duplicate group sizes prevented a close 70/30 split.");
  if (ordered.some((g) => new Set(g.map((x) => x.label)).size > 1))
    warnings.push(
      "A duplicate group has conflicting human labels; resolve before evaluating.",
    );
  const manifest = {
    format: "tenderdesk-evaluation-v1",
    kind: synthetic ? "synthetic" : "human_labeled",
    seed,
    dataset_hash: hash(JSON.stringify(rows)),
    holdout_hash: hash(JSON.stringify(held)),
    development_ids: development.map((x) => x.id),
    holdout_ids: held.map((x) => x.id),
    groups: ordered.map((g) => g.map((x) => x.id)),
    warnings,
  };
  return {
    manifest,
    development,
    holdout: held,
    holdoutInputs: held.map(({ label, ...row }) => row),
  };
}
export function proportion(successes: number, total: number) {
  if (!total)
    return {
      value: null,
      numerator: successes,
      denominator: total,
      wilson_95: null,
    };
  const z = 1.959963984540054,
    p = successes / total,
    denominator = 1 + (z * z) / total,
    center = (p + (z * z) / (2 * total)) / denominator,
    half =
      (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) /
      denominator;
  return {
    value: p,
    numerator: successes,
    denominator: total,
    wilson_95: [Math.max(0, center - half), Math.min(1, center + half)],
  };
}
export function evaluateHoldout(
  split: ReturnType<typeof prepareSplit>,
  input: unknown,
) {
  if (hash(JSON.stringify(split.holdout)) !== split.manifest.holdout_hash)
    throw Error("Held-out labels differ from the frozen split.");
  const predictions = z.array(predictionSchema).parse(input);
  if (
    new Set(predictions.map((x) => x.id)).size !== predictions.length ||
    predictions.length !== split.holdout.length ||
    predictions.some((x) => !split.manifest.holdout_ids.includes(x.id))
  )
    throw Error("Predictions must cover the held-out IDs exactly once.");
  const rows = split.holdout.map((x) => ({
    ...x,
    prediction: predictions.find((p) => p.id === x.id)!,
  }));
  const suitable = rows.filter((x) => x.label === "suitable"),
    known = rows.filter((x) => x.label !== "uncertain"),
    recommended = known.filter((x) => x.prediction.routing === "recommended"),
    tp = recommended.filter((x) => x.label === "suitable").length;
  const attention = suitable.filter((x) =>
    ["recommended", "needs_review"].includes(x.prediction.routing),
  ).length;
  const precision = proportion(tp, recommended.length),
    recall = proportion(tp, suitable.length);
  const titleOnlyDiscarded = rows
    .filter(
      (x) => !x.description.trim() && x.prediction.routing !== "needs_review",
    )
    .map((x) => x.id);
  const unknownAudit = rows
    .filter((x) => x.prediction.citation_errors === null)
    .map((x) => x.id);
  return {
    kind: split.manifest.kind,
    dataset_hash: split.manifest.dataset_hash,
    split: {
      development: split.development.length,
      holdout: rows.length,
      groups: split.manifest.groups.length,
    },
    counts: {
      suitable: suitable.length,
      unsuitable: rows.filter((x) => x.label === "unsuitable").length,
      uncertain: rows.filter((x) => x.label === "uncertain").length,
      true_positive: tp,
      false_positive: recommended.length - tp,
      not_recommended_suitable: suitable.length - tp,
      discarded_suitable: suitable.length - attention,
    },
    recommendation_precision: precision,
    recommendation_recall: recall,
    human_attention_recall: proportion(attention, suitable.length),
    needs_review: rows
      .filter((x) => x.prediction.routing === "needs_review")
      .map((x) => x.id),
    missed_opportunities: suitable
      .filter((x) => ["low_fit", "excluded"].includes(x.prediction.routing))
      .map((x) => x.id),
    irrelevant_alerts: recommended
      .filter((x) => x.label === "unsuitable")
      .map((x) => x.id),
    uncertain_not_routed_to_review: rows
      .filter(
        (x) =>
          x.label === "uncertain" && x.prediction.routing !== "needs_review",
      )
      .map((x) => x.id),
    title_only_routing_errors: titleOnlyDiscarded,
    citation_errors: rows.reduce(
      (n, x) => n + (x.prediction.citation_errors || 0),
      0,
    ),
    citation_audit_pending: unknownAudit,
    proposed_point_targets_met:
      precision.value !== null &&
      precision.value >= 0.7 &&
      recall.value !== null &&
      recall.value >= 0.9 &&
      titleOnlyDiscarded.length === 0,
    warnings: split.manifest.warnings,
    owner_acceptance: "required",
    business_accuracy_validated: false,
    limitations:
      split.manifest.kind === "synthetic"
        ? "Synthetic functional evidence only; these metrics are not business accuracy."
        : "Small held-out sample. Review the counts and Wilson intervals, audit citations and record Owner acceptance; point targets alone do not establish reliable performance.",
  };
}
