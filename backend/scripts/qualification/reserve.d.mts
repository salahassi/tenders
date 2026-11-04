/** Offline evidence records are extensible fixture metadata, not application
 * request/response contracts. Canonical task adapters remain a separate gate. */
export type ReserveCase = {
  id: string; task: string; language: string; family: string; split_group: string;
  scenario: string; instruction: string; documents: any[]; workflow_facts: any;
  oracle: { invariants: any[]; noncritical_acceptance_threshold: null; [key: string]: any };
};
export type ReserveCorpus = { version: number; cases: ReserveCase[]; [key: string]: any };
export type RetrievalReserve = { version: number; cases: any[]; source_assembly: any; [key: string]: any };
export const CORPUS_SHA256: string;
export const RETRIEVAL_SHA256: string;
export const TASKS: string[];
export function sha256(value: string | Uint8Array): string;
export function loadReserve(): Promise<{ corpus: ReserveCorpus; retrieval: RetrievalReserve }>;
export function validateReserve(corpus: ReserveCorpus, retrieval: RetrievalReserve): void;
export function retrievalSource(row: any, retrieval: RetrievalReserve, mode: string): string;
export function publicCase(row: ReserveCase): Pick<ReserveCase, "task" | "language" | "instruction" | "documents" | "workflow_facts">;
export function validateActivation(corpus: ReserveCorpus, lock: any): any;
export function schedule(corpus: ReserveCorpus, lock: any): any[];
export function scoreReserve(corpus: ReserveCorpus, lock: any, observations: any[], adjudications: any[]): any;
