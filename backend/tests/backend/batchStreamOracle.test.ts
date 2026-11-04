// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { batchStreamOracle } from "../../scripts/testing/batchStreamOracle.ts";
const values = ['{"text":"عربي \\\" ] } ,"}', '{"number":12500}'];
const descriptors = values.map((text, ordinal) => ({
  ordinal,
  byte_length: Buffer.byteLength(text),
  chunk_count: 1,
  sha256: createHash("sha256").update(text).digest("hex"),
}));
const text =
  '{"data":[' +
  values.join(",") +
  '],"meta":{"request_id":"00000000-0000-4000-8000-000000000001"}}';
it("hashes exact per-result bytes across every byte boundary without parsing result JSON", () => {
  const oracle = batchStreamOracle(descriptors);
  for (const byte of new TextEncoder().encode(text))
    oracle.write(new Uint8Array([byte]));
  const result = oracle.finish();
  expect(result.result_hashes).toEqual(
    descriptors.map((value) => value.sha256),
  );
  expect(result.array_sha256).toBe(
    createHash("sha256")
      .update("[" + values.join(",") + "]")
      .digest("hex"),
  );
  expect(result.wire_bytes).toBe(Buffer.byteLength(text));
});
it.each([
  text.slice(0, -1),
  text.replace("12500", "12501"),
  text.replace('},{"number"', '}, {"number"'),
  text + "garbage",
])("rejects truncated, changed or extra bytes", (value) => {
  const oracle = batchStreamOracle(descriptors);
  expect(() => {
    oracle.write(new TextEncoder().encode(value));
    oracle.finish();
  }).toThrow();
});
