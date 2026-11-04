import type { SemanticCorpus } from "./live-model-evaluation-semantics.mjs";
export const SEMANTIC_V2_CORPUS_SHA256: string;
export function semanticV2Corpus(): Promise<{ corpus: SemanticCorpus & { oracle_version: 2 }; sha256: string }>;
export function semanticV2Fixtures(language: "en" | "ar"): Promise<any[]>;
