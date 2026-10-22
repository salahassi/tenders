// Tender confidentiality requirements are ordinary evidence. Explicit document
// classification labels and credentials still require restricted-content handling.
const confidentialityMarking =
  /(?:\bconfidential\b|سرية)(?:\s*[:：—–]|\s+-|-(?![\p{L}\p{N}]))|(?:^|[\r\n]|\\[nr]|["=:])\s*(?:confidential|سرية)\s*(?=$|[\r\n"]|\\[nr])|strictly private|سري للغاية/iu;
const credential =
  /password\s*[:=]|api[_ -]?key\s*[:=]|-----BEGIN .*PRIVATE KEY|\b(?:sk|sb_secret)_[a-z0-9]{12,}/i;
const email = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;

export function hasRestrictedDocumentContent(value: string) {
  return confidentialityMarking.test(value) || credential.test(value);
}

export function blockedContent(value: string) {
  return hasRestrictedDocumentContent(value) || email.test(value);
}

/** Category-only diagnostics; never log the matched content. */
export function contentPolicyCategories(value: string) {
  return Object.entries({
    confidentiality_marking: confidentialityMarking,
    credential,
    email,
  })
    .filter(([, check]) => check.test(value))
    .map(([category]) => category);
}
