// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  HeavyFileAdmission,
  isHeavyFileRequest,
} from "../../supabase/functions/api/heavyFileAdmission";

const signal = () => new AbortController().signal;
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

it("retains the permit through the actual last read, without prefetching a slow response", async () => {
  const admission = new HeavyFileAdmission();
  const permit = admission.acquire(signal());
  let pulls = 0;
  const original = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls <= 2) controller.enqueue(new Uint8Array([pulls]));
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "x-fixture": "kept" } },
  );
  const response = permit.retainThrough(original);
  expect(permit.retainThrough(response)).toBe(response);
  permit.finishWork();
  await Promise.resolve();
  expect(pulls).toBe(0);
  expect(response.headers.get("x-fixture")).toBe("kept");
  const reader = response.body!.getReader();
  for (let expected = 1; expected <= 2; expected++) {
    expect(() => admission.acquire(signal())).toThrow(/Another file/);
    expect(await reader.read()).toEqual({
      done: false,
      value: new Uint8Array([expected]),
    });
    expect(pulls).toBe(expected);
  }
  expect(() => admission.acquire(signal())).toThrow(/Another file/);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  admission.acquire(signal()).finishWork();
});

it.each(["cancel", "abort"] as const)(
  "retains ownership until underlying %s settles and releases once",
  async (mode) => {
    const admission = new HeavyFileAdmission(),
      abort = new AbortController();
    const stopped = pending();
    const cancel = vi.fn(() => stopped.promise);
    const permit = admission.acquire(abort.signal);
    const response = permit.retainThrough(
      new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })),
    );
    permit.finishWork();
    let completion: Promise<unknown>;
    if (mode === "cancel")
      completion = response.body!.cancel("consumer closed");
    else {
      abort.abort(new Error("client disconnected"));
      completion = expect(response.arrayBuffer()).rejects.toThrow(
        "client disconnected",
      );
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => admission.acquire(signal())).toThrow(/Another file/);
    stopped.resolve();
    await completion;
    await Promise.resolve();
    const next = admission.acquire(signal());
    permit.finishWork();
    abort.abort();
    expect(() => admission.acquire(signal())).toThrow(/Another file/);
    next.finishWork();
    admission.acquire(signal()).finishWork();
  },
);

it("releases on response source error, including a rejected pending read", async () => {
  const admission = new HeavyFileAdmission(),
    permit = admission.acquire(signal());
  const response = permit.retainThrough(
    new Response(
      new ReadableStream(
        {
          pull() {
            throw new Error("synthetic source failed");
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  permit.finishWork();
  await expect(response.arrayBuffer()).rejects.toThrow(
    "synthetic source failed",
  );
  admission.acquire(signal()).finishWork();
});

it("does not release aborted uncooperative handler work before it settles", () => {
  const admission = new HeavyFileAdmission(),
    abort = new AbortController();
  const permit = admission.acquire(abort.signal);
  abort.abort();
  expect(() => admission.acquire(signal())).toThrow(/Another file/);
  expect(() => permit.retainThrough(new Response("late result"))).toThrow();
  permit.finishWork();
  permit.finishWork();
  admission.acquire(signal()).finishWork();
});

it("does not acquire a canceled request and releases bodyless responses immediately", () => {
  const admission = new HeavyFileAdmission(),
    abort = new AbortController();
  abort.abort();
  expect(() => admission.acquire(abort.signal)).toThrow();
  const permit = admission.acquire(signal());
  expect(permit.retainThrough(new Response(null, { status: 204 })).status).toBe(
    204,
  );
  permit.finishWork();
  admission.acquire(signal()).finishWork();
});

it.each([
  ["GET", "/v1/health"],
  ["GET", "/v1/status"],
  ["GET", "/v1/bootstrap"],
  ["GET", "/v1/notifications"],
  ["GET", "/v1/proposal-issuance/id"],
  ["GET", "/v1/documents/id/ocr"],
  ["GET", "/v1/export-packages/id"],
  ["GET", "/v1/delivery-snapshots/id/authoring-status"],
  ["OPTIONS", "/v1/delivery-artifacts/id/download"],
])("leaves lightweight %s %s outside file admission", (method, path) => {
  expect(isHeavyFileRequest(method, path)).toBe(false);
});
