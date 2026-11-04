// @vitest-environment node
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  blockedContent,
  contentPolicyCategories,
  hasRestrictedDocumentContent,
} from "../../supabase/functions/_shared/contentPolicy";

// Exact previous expression: frozen compatibility oracle, not a replacement
// definition of PEM syntax. Preserve its permissive substring behavior.
const legacyCredential =
  /password\s*[:=]|api[_ -]?key\s*[:=]|-----BEGIN .*PRIVATE KEY|\b(?:sk|sb_secret)_[a-z0-9]{12,}/i;
const credentialCategory = (text: string) =>
  contentPolicyCategories(text).includes("credential");
function* sequences(
  tokens: string[],
  remaining: number,
  prefix = "",
): Generator<string> {
  yield prefix;
  if (remaining)
    for (const token of tokens)
      yield* sequences(tokens, remaining - 1, prefix + token);
}

it("preserves every short marker/terminator ordering against the previous policy", () => {
  let checked = 0;
  for (const text of sequences(
    [
      "-----BEGIN ",
      "-----begin ",
      "PRIVATE KEY",
      "private key",
      "X",
      "\n",
      "\r",
      "\u2028",
      "\u2029",
      "\v",
      "\f",
      "\\n",
      "ſ",
      "K",
    ],
    4,
  )) {
    const expected = legacyCredential.test(text);
    if (credentialCategory(text) !== expected)
      expect(credentialCategory(text), JSON.stringify(text)).toBe(expected);
    checked++;
  }
  expect(checked).toBe(41371);
});

it.each([
  ["-----BEGIN PRIVATE KEY", true],
  ["prefix-----bEgIn RSA private key-----suffix", true],
  ["-----BEGIN -----BEGIN PRIVATE KEY", true],
  ["PRIVATE KEY -----BEGIN without suffix", false],
  ["-----BEGIN RSA\nPRIVATE KEY", false],
  ["-----BEGIN RSA\rPRIVATE KEY", false],
  ["-----BEGIN RSA\u2028PRIVATE KEY", false],
  ["-----BEGIN RSA\u2029PRIVATE KEY", false],
  ["-----BEGIN RSA\r\nPRIVATE KEY", false],
  ["-----BEGIN RSA\vPRIVATE KEY", true],
  ["-----BEGIN RSA\fPRIVATE KEY", true],
  ["-----BEGIN RSA\\nPRIVATE KEY", true],
  ["-----BEGIN RSA\n-----BEGIN EC PRIVATE KEY", true],
  ["-----BEGIN RSA\nPRIVATE KEY\n-----BEGIN missing", false],
  ["-----BEGIN\tPRIVATE KEY", false],
  ["-----BEGINPR IVATE KEY", false],
  ["-----BEGIN PRİVATE KEY", false],
  ["-----BEGIN PRIVATE KEY", false],
  ["بداية-----BEGIN 😀محتوى PRIVATE KEYنهاية", true],
  ["password\n =synthetic", true],
  ["xPASSWORD:synthetic", true],
  ["api-key =synthetic", true],
  ["API_KEY\t:synthetic", true],
  ["sk_abcdefghijkl", true],
  ["prefixsk_abcdefghijkl", false],
  ["sb_secret_ABCDEFGHIJKL", true],
  ["sk_abcdefghijk", false],
])("retains the declared credential result for %s", (text, expected) => {
  expect(legacyCredential.test(text)).toBe(expected);
  expect(hasRestrictedDocumentContent(text)).toBe(expected);
  expect(blockedContent(text)).toBe(expected);
  expect(contentPolicyCategories(text)).toEqual(expected ? ["credential"] : []);
});

it("retains category order and independent confidentiality/email detection", () => {
  expect(
    contentPolicyCategories(
      "Confidential: -----BEGIN RSA PRIVATE KEY; person@example.invalid",
    ),
  ).toEqual(["confidentiality_marking", "credential", "email"]);
  expect(contentPolicyCategories("-----BEGIN missing; a@b.example")).toEqual([
    "email",
  ]);
  expect(
    contentPolicyCategories("Confidential: -----BEGIN RSA\nPRIVATE KEY"),
  ).toEqual(["confidentiality_marking"]);
});

it("bounds repeated-marker scanning in an isolated subprocess", () => {
  // A three-second subprocess deadline contains the previously quadratic
  // matcher even if it regresses. Each public entrypoint has a predeclared
  // one-second CPU bound for one synthetic 1 MiB line. These are local
  // regression guards, not a change to production request/model budgets.
  const policyUrl = new URL(
    "../../supabase/functions/_shared/contentPolicy.ts",
    import.meta.url,
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import * as policy from ${JSON.stringify(policyUrl)};
const bytes=1048576;
const negative='-----BEGIN '.repeat(Math.floor(bytes/11)).padEnd(bytes,'X');
const positive=negative.slice(0,-11)+'PRIVATE KEY';
const observations=[];
for (const [fixture,text,expected] of [['missing_suffix',negative,false],['matching_suffix',positive,true]]) {
  for (const name of ['hasRestrictedDocumentContent','blockedContent','contentPolicyCategories']) {
    const start=process.cpuUsage();
    const result=policy[name](text);
    const cpu=process.cpuUsage(start);
    const wanted=name==='contentPolicyCategories'?(expected?['credential']:[]):expected;
    if(JSON.stringify(result)!==JSON.stringify(wanted)) throw Error('policy result changed: '+name);
    observations.push({fixture,name,bytes:Buffer.byteLength(text),cpu_ms:(cpu.user+cpu.system)/1000});
  }
}
console.log(JSON.stringify(observations));`,
    ],
    { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
  );
  expect(child.error?.message ?? child.stderr).toBe("");
  expect(child.status).toBe(0);
  const observations = JSON.parse(child.stdout) as {
    fixture: string;
    name: string;
    bytes: number;
    cpu_ms: number;
  }[];
  console.info("credential_policy_cpu", JSON.stringify(observations));
  expect(observations).toHaveLength(6);
  for (const observation of observations) {
    expect(observation.bytes).toBe(1048576);
    expect(observation.cpu_ms).toBeLessThan(1000);
  }
}, 5000);
