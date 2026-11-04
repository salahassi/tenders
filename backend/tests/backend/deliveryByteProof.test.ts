// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as verifier from "../../supabase/functions/_shared/export";
import { deliveryBytes } from "../../supabase/functions/_shared/deliveryWorker";
import {
  renderDocx,
  type FontData,
} from "../../../frontend/src/lib/renderDocx";
const model: verifier.RenderModel = {
  id: "synthetic-proof",
  version: 1,
  mode: "draft",
  volume: "combined",
  language: "en",
  created_at: "2026-11-04T00:00:00Z",
  footer: "Tenderdesk Draft",
  blocks: [
    { type: "title", text: "Synthetic response" },
    { type: "toc", text: "Contents" },
    { type: "heading", text: "Approach" },
    { type: "paragraph", text: "Configure approved workflow." },
  ],
};
// Real DOCX archives include four embedded fonts and repeated canonical scans.
// Use the same bounded integration budget as deliveryExport.test.ts.
const DOCX_TEST_TIMEOUT_MS = 30_000;
let bytes: Uint8Array;
beforeAll(async () => {
  const fonts = Object.fromEntries(
    await Promise.all(
      ["Amiri-Regular", "Amiri-Bold", "Carlito-Regular", "Carlito-Bold"].map(
        async (name) => [
          name,
          new Uint8Array(
            await readFile(
              new URL(
                `../../../frontend/public/fonts/${name}.ttf`,
                import.meta.url,
              ),
            ),
          ),
        ],
      ),
    ),
  ) as FontData;
  bytes = new Uint8Array(await (await renderDocx(model, fonts)).arrayBuffer());
}, DOCX_TEST_TIMEOUT_MS);
afterEach(() => vi.restoreAllMocks());
it("reuses only privately verified identical bytes and exact current model binding", async () => {
  const spy = vi.spyOn(verifier, "verifyOwnedExportDocxSnapshot");
  const proof = await deliveryBytes(bytes, model);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]).toBe(JSON.stringify(model));
  expect(spy.mock.calls[0][0]).not.toBe(bytes);
  expect(proof.bytes).not.toBe(bytes);
  const readback = await deliveryBytes(
    new Blob([new Uint8Array(bytes)]),
    model,
    undefined,
    proof,
  );
  expect(readback.hash).toBe(proof.hash);
  expect(spy).toHaveBeenCalledTimes(1);
  await deliveryBytes(bytes, model, undefined, { ...proof });
  expect(spy).toHaveBeenCalledTimes(2);
  proof.hash = "0".repeat(64);
  proof.size = 1;
  expect((await deliveryBytes(bytes, model, undefined, proof)).hash).toBe(
    readback.hash,
  );
  expect(spy).toHaveBeenCalledTimes(2);
}, DOCX_TEST_TIMEOUT_MS);
it("mutated model or changed bytes cannot borrow a previous verification", async () => {
  const spy = vi.spyOn(verifier, "verifyOwnedExportDocxSnapshot");
  const current = structuredClone(model),
    proof = await deliveryBytes(bytes, current);
  current.blocks.push({
    type: "paragraph",
    text: "New unverified obligation.",
  });
  await expect(deliveryBytes(bytes, current, undefined, proof)).rejects.toThrow(
    "content",
  );
  expect(spy).toHaveBeenCalledTimes(2);
  const archive = unzipSync(bytes);
  archive["word/document.xml"] = strToU8(
    strFromU8(archive["word/document.xml"]).replace("Configure", "Invent"),
  );
  await expect(
    deliveryBytes(zipSync(archive), model, undefined, proof),
  ).rejects.toThrow("content");
  expect(spy).toHaveBeenCalledTimes(3);
}, DOCX_TEST_TIMEOUT_MS);
it("cancellation returns no proof even when bytes previously passed", async () => {
  const proof = await deliveryBytes(bytes, model),
    abort = new AbortController();
  abort.abort(new Error("user canceled"));
  await expect(
    deliveryBytes(bytes, model, abort.signal, proof),
  ).rejects.toThrow("user canceled");
}, DOCX_TEST_TIMEOUT_MS);

it("captures the model before a delayed Blob read and cannot lend that proof to a later model", async () => {
  let release!: (value: ArrayBuffer) => void;
  const current = structuredClone(model),
    blob = new Blob([new Uint8Array(bytes)]);
  vi.spyOn(blob, "arrayBuffer").mockImplementation(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  );
  const pending = deliveryBytes(blob, current);
  current.blocks.push({
    type: "paragraph",
    text: "Later unverified obligation.",
  });
  release(new Uint8Array(bytes).buffer);
  const proof = await pending;
  expect(proof.bytes).toEqual(bytes);
  await expect(deliveryBytes(bytes, current, undefined, proof)).rejects.toThrow(
    "content",
  );
}, DOCX_TEST_TIMEOUT_MS);

it("owns its byte snapshot before yielding and never lends verification to changed input", async () => {
  const mutable = new Uint8Array(bytes),
    pending = deliveryBytes(mutable, model);
  mutable.fill(0);
  const proof = await pending;
  expect(proof.bytes).toEqual(bytes);
  await expect(
    deliveryBytes(mutable, model, undefined, proof),
  ).rejects.toThrow();
}, DOCX_TEST_TIMEOUT_MS);
