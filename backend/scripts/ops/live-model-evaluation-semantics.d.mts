export const SEMANTIC_CORPUS_SHA256: string;
export type SemanticCorpus = {
  version: number; split: string; synthetic: boolean; families: number;
  paired_cases: number; languages: string[]; task: string; original_task: string;
  policy: { critical_false_acceptances: number; faithful_false_rejections: number;
    repetitions: number; automatic_retries: number; missing_or_invalid_reports: string;
    holdout_status: string; scope: string };
  cases: { family: string; language: "en" | "ar"; source: string;
    faithful: { text: string; mandatory: boolean }; mutated: { text: string; mandatory: boolean };
    unchanged_requirements?: { text: string; mandatory: boolean }[];
    oracle: { defect_term_groups: string[]; field_paths: string[]; offending_candidate_spans: string[] } }[];
};
export function semanticCorpus(): Promise<{ corpus: SemanticCorpus; sha256: string }>;
export function semanticFixtures(language: "en" | "ar"): Promise<any[]>;
