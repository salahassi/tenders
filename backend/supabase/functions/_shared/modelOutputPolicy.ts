/** A maximum, never a requested response length. Provider capability limits
 * still apply; accepted remote requests retain their recorded execution profile. */
export const DEFAULT_OUTPUT_CEILING = 40000;
export const OUTPUT_ECONOMY_INSTRUCTIONS =
  "The output-token allowance is a ceiling, never a target or minimum. " +
  "Finish as soon as the complete requested result is expressed. Use concise, non-repetitive fields, " +
  "reference supplied IDs instead of copying requirements, and never pad to consume the allowance. " +
  "Preserve every required fact, condition, exception and coverage obligation. " +
  "Return only the requested structured result, without commentary or private reasoning traces.";
