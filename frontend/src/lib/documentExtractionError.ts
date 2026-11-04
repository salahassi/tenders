export const extractionFailureCodes = [
  "EMPTY_FILE",
  "INVALID_FILE",
  "UNSUPPORTED_FORMAT",
  "EXTRACTION_LIMIT",
  "EXTRACTION_FAILED",
] as const;
export type ExtractionFailureCode = (typeof extractionFailureCodes)[number];
export class DocumentExtractionError extends Error {
  constructor(
    readonly code: ExtractionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}
