// Browser-safe Supabase configuration. This publishable key grants no membership
// or privileged database access. User JWT, RLS and server commands are required.
export const deployment = {
  projectUrl: "https://nqfwbqeozmuiuwbiowil.supabase.co",
  publishableKey: "sb_publishable_2rYRriPhklB0BrBODdVBFQ_0ZSAZLJj",
  /** Canonical hosted app origin for Auth email links (invite + recovery). */
  appOrigin: "https://salahassi.github.io/tenders",
} as const;
