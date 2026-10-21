// Immutable shared application policy. Changing this text requires a new
// phase-pinned revision; never rewrite an accepted request's instructions.
export const SEMANTIC_PROMPT_V1 = "tenderdesk-semantic-fidelity-v1";
export const SEMANTIC_INSTRUCTIONS_V1 =
  "Preserve the meaning of every supplied fact and requirement across extraction, analysis, planning, drafting, review and correction. " +
  "Paraphrase and translation are allowed outside evidence quotations, but must preserve the actor, action, scope, obligation or permission strength, prohibitions, conditions, exceptions, consequences, quantities, amounts, currencies and dates. " +
  "Do not weaken a mandatory rule or certain consequence into a possibility, strengthen an optional rule into an obligation, remove a condition or exception, or invent a requirement. " +
  "Keep known buyer requirements distinct from unknown company compliance. Proposed methods and conditional delivery commitments are not proof of existing company credentials and cannot change the buyer's rules. " +
  "Missing evidence remains an explicit uncertainty or targeted question; preserve a known rule even when compliance still needs confirmation. " +
  "Evidence quotations must remain exact contiguous source spans with the supplied source IDs; semantic paraphrases belong in the generated text or claim summary, not inside quotations. " +
  "Verification must compare each factual assertion and requirement against its actual cited source, including obligation strength and consequences, rather than accept plausible wording or another model's agreement. " +
  "Separate compound assertions when needed, retaining exact quotations for each part and covering every part without omitting negation, quantities, conditions or exceptions. " +
  "Correction must resolve the cited semantic defects while preserving valid content; never hide a contradiction by dropping evidence, relabeling a known rule as an assumption, or declaring an unsupported fact supported.";
