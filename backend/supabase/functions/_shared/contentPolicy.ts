// Tender confidentiality requirements are ordinary evidence. Explicit document
// classification labels and credentials still require restricted-content handling.
const confidentialityMarking =
  /(?:\bconfidential\b|سرية)(?:\s*[:：—–]|\s+-|-(?![\p{L}\p{N}]))|(?:^|[\r\n]|\\[nr]|["=:])\s*(?:confidential|سرية)\s*(?=$|[\r\n"]|\\[nr])|strictly private|سري للغاية/iu;
const credentialAssignment =
  /password\s*[:=]|api[_ -]?key\s*[:=]|\b(?:sk|sb_secret)_[a-z0-9]{12,}/i;
const credential = {
  test(value: string) {
    if (credentialAssignment.test(value)) return true;
    // Equivalent to /-----BEGIN .*PRIVATE KEY/i: the two literal markers
    // must occur in order without a JavaScript dot-excluded line terminator.
    // Scan each marker once instead of retrying the entire remaining line
    // for every BEGIN when a large input contains no closing marker.
    const markers = /-----BEGIN |PRIVATE KEY|[\r\n\u2028\u2029]/gi;
    let began = false;
    for (let match = markers.exec(value); match; match = markers.exec(value)) {
      if (match[0].length === 1) began = false;
      else if (match[0][0] === "-") began = true;
      else if (began) return true;
    }
    return false;
  },
};
// Any legacy match can extend left across the same local-part character class.
// Starting only at that maximal prefix preserves boolean detection and avoids
// retrying every suffix of a long ASCII word that contains no '@'.
const email = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;

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
