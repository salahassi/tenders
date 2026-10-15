// Browser-safe Supabase configuration. This publishable key grants no membership
// or privileged database access. User JWT, RLS and server commands are required.
const defaultAppOrigin = "https://salahassi.github.io/tenders";
const trimOrigin = (value: string) => value.trim().replace(/\/$/, "");

export const deployment = {
  projectUrl:
    import.meta.env.VITE_SUPABASE_URL ||
    "https://nqfwbqeozmuiuwbiowil.supabase.co",
  publishableKey:
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    "sb_publishable_2rYRriPhklB0BrBODdVBFQ_0ZSAZLJj",
  /** Canonical hosted app origin for Auth email links (invite + recovery). */
  appOrigin: trimOrigin(
    import.meta.env.VITE_APP_ORIGIN || defaultAppOrigin,
  ),
} as const;
