// @vitest-environment node
import { expect, it } from "vitest";
import {
  blockedContent,
  contentPolicyCategories,
  hasRestrictedDocumentContent,
} from "../../supabase/functions/_shared/contentPolicy";

// Frozen compatibility oracle: this is the exact previously deployed matcher.
// This qualification preserves its boolean behavior, including permissive
// punctuation cases; it does not redefine valid email syntax.
const legacyEmail = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const emailCategory = (text: string) =>
  contentPolicyCategories(text).includes("email");
function* strings(
  alphabet: string[],
  remaining: number,
  prefix = "",
): Generator<string> {
  yield prefix;
  if (remaining)
    for (const character of alphabet)
      yield* strings(alphabet, remaining - 1, prefix + character);
}
it("preserves legacy email classification on every short boundary combination", () => {
  let checked = 0;
  // Includes valid minimal addresses, repeated separators, punctuation local
  // parts and non-ASCII boundaries, independently of the new implementation.
  for (const text of strings(["a", "@", ".", "-", "_", "é"], 7)) {
    const actual = emailCategory(text),
      expected = legacyEmail.test(text);
    if (actual !== expected)
      expect(actual, JSON.stringify(text)).toBe(expected);
    checked++;
  }
  expect(checked).toBe(335923);
});
it.each([
  ["a@b.co", true],
  ["FIRST.Last+tag@sub-domain.EXAMPLE", true],
  ["...+_-@..co", true],
  ["x@a..bc", true],
  ["بريد: أولfirst.last+tag@domain.exampleنهاية", true],
  ["Ａa@b.co", true],
  ["😀name@domain.example😀", true],
  ["prefix$name@domain.example/suffix", true],
  ["name@domain.comé", true],
  ["name@xn--bcher-kva.example", true],
  ["x@y.z", false],
  ["x@@b.co", false],
  ["name＠domain.example", false],
  ["name@مثال.example", false],
  ["اسم@domain.example", false],
  ["name@domain.cö", false],
  ["name@domain.", false],
  ["name @domain.example", false],
])("preserves the established result for %s", (text, expected) => {
  expect(legacyEmail.test(text)).toBe(expected);
  expect(blockedContent(text)).toBe(expected);
  expect(emailCategory(text)).toBe(expected);
  expect(hasRestrictedDocumentContent(text)).toBe(false);
});
it("preserves email category alongside independent confidentiality and credential checks", () => {
  expect(
    contentPolicyCategories("Confidential: contact name@domain.example"),
  ).toEqual(["confidentiality_marking", "email"]);
  expect(
    contentPolicyCategories("password=sample; name@domain.example"),
  ).toEqual(["credential", "email"]);
  expect(
    contentPolicyCategories(
      "Confidential: password=sample; name@domain.example",
    ),
  ).toEqual(["confidentiality_marking", "credential", "email"]);
});
it("does not rescan admitted-envelope-size ASCII words quadratically", () => {
  const value = {
    key: "approach",
    title: "Proposed work",
    content_blocks: Array.from({ length: 100 }, () => ({
      type: "paragraph",
      text: "Z".repeat(10000),
    })),
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
  };
  // Predeclared regression bound: one second of process CPU per public entry
  // point on a 1 MiB ASCII JSON envelope. CPU avoids wall-clock scheduling
  // noise; this is a local regression guard, not a new production time quota.
  const byteLimit = 1048576;
  let remaining = byteLimit - Buffer.byteLength(JSON.stringify(value));
  for (const block of value.content_blocks) {
    const added = Math.min(remaining, 20000 - block.text.length);
    block.text += "Z".repeat(added);
    remaining -= added;
  }
  expect(remaining).toBe(0);
  const serialized = JSON.stringify(value);
  expect(Buffer.byteLength(serialized)).toBe(byteLimit);
  for (const [name, run] of [
    ["blockedContent", () => blockedContent(serialized)],
    ["contentPolicyCategories", () => contentPolicyCategories(serialized)],
  ] as const) {
    const started = process.cpuUsage();
    const result = run();
    const cpu = process.cpuUsage(started),
      milliseconds = (cpu.user + cpu.system) / 1000;
    console.info(
      "email_policy_cpu",
      JSON.stringify({ name, bytes: byteLimit, milliseconds }),
    );
    expect(result).toEqual(name === "blockedContent" ? false : []);
    expect(milliseconds).toBeLessThan(1000);
  }
}, 20000);
it("retains long-prefix and malformed-domain behavior without changing match boundaries", () => {
  for (const text of [
    "+._-Z".repeat(4000) + "@domain.example",
    "Z".repeat(20000) + "@" + "D".repeat(20000),
    "😀" + ".".repeat(20000) + "@a..bc!",
    "word ".repeat(2000) + "actual.person+tag@sub.example",
  ])
    expect(emailCategory(text)).toBe(legacyEmail.test(text));
});
