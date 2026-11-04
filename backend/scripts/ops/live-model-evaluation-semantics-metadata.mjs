/** Explicit future prompt-5 campaign. The frozen v2 baseline stays on prompt 4. */
import { semanticV2Fixtures } from "./live-model-evaluation-semantics-v2.mjs";
export async function semanticMetadataFixtures(language) {
  return (await semanticV2Fixtures(language)).map((fixture) => ({
    ...fixture,
    id: fixture.id.replace("semantic_v2_", "semantic_v2_metadata_"),
    verificationRevision: 5,
    qualification: { ...fixture.qualification, verification_policy_version: 5 },
    assertion_scope: `${fixture.assertion_scope}_metadata_policy_v5`,
  }));
}
