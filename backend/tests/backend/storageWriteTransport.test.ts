import { afterEach, expect, it, vi } from "vitest";
import {
  Backend,
  modelEnvironments,
} from "../../supabase/functions/_shared/backend";
import { prepareStorageCleanup } from "../../supabase/functions/_shared/storageWrites";
afterEach(() => vi.unstubAllGlobals());
it.each(["GET", "PUT"])(
  "aborts Storage %s at the supplied budget signal without treating cancellation as settlement",
  async (method) => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let observed: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        observed = init.signal;
        began();
        return new Promise<Response>((_resolve, reject) => {
          if (observed!.aborted) reject(observed!.reason);
          else
            observed!.addEventListener(
              "abort",
              () => reject(observed!.reason),
              { once: true },
            );
        });
      }),
    );
    const b = new Backend({
      url: "https://synthetic.test",
      publishableKey: "synthetic",
      serviceKey: "synthetic",
      workerSecret: "synthetic",
      allowedOrigins: [],
      models: modelEnvironments(() => undefined),
    });
    const budget = new AbortController();
    const pending =
      method === "GET"
        ? b.deliveryObject("synthetic/private", budget.signal)
        : b.storeDeliveryObject(
            "synthetic/private",
            new Uint8Array([1]),
            "application/octet-stream",
            budget.signal,
          );
    const rejected = expect(pending).rejects.toThrow();
    await started;
    budget.abort(new Error("Synthetic issuance deadline"));
    await rejected;
    expect(observed?.aborted).toBe(true);
    expect(observed).not.toBe(budget.signal); // Combined with the existing20s transport cap.
  },
);
it.each(["absent", "wrong_size", "wrong_hash", "read_failure", "legacy"])(
  "does not authorize cleanup for %s write evidence",
  async (kind) => {
    const internal = vi.fn(async (name: string) =>
      name === "storage_cleanup_context"
        ? {
            storage_key: "synthetic/private",
            write_state: kind === "legacy" ? "legacy_unfenced" : "unknown",
            expected_hash: "a".repeat(64),
            expected_size: 3,
            can_delete: false,
          }
        : null,
    );
    const read = vi.fn(async () => {
      if (kind === "read_failure") throw Error("Synthetic read outage");
      return kind === "absent"
        ? null
        : new Blob([kind === "wrong_size" ? "abcd" : "abc"]);
    });
    expect(
      await prepareStorageCleanup(
        { internal, deliveryObject: read } as unknown as Backend,
        {
          id: "synthetic",
          lease_token: "synthetic-lease",
          storage_key: "synthetic/private",
        },
      ),
    ).toBe("deferred");
    expect(internal).toHaveBeenLastCalledWith("defer_storage_cleanup", {
      cleanup_id: "synthetic",
      lease: "synthetic-lease",
    });
    expect(
      internal.mock.calls.some(
        ([name]) => name === "observe_cleanup_storage_write",
      ),
    ).toBe(false);
    if (kind === "legacy") expect(read).not.toHaveBeenCalled();
  },
);

it.each(["positive", "empty", "wrong_key", "delete_marker", "missing_version"])(
  "accepts only exact nonmarker physical delete receipt: %s",
  async (kind) => {
    const object = {
      id: "00000000-0000-4000-8000-000000000001",
      name: kind === "wrong_key" ? "another/key" : "synthetic/private",
      version: "synthetic-version",
      is_delete_marker: kind === "delete_marker",
    };
    if (kind === "missing_version") delete (object as any).version;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(kind === "empty" ? [] : [object]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const b = new Backend({
      url: "https://synthetic.test",
      publishableKey: "synthetic",
      serviceKey: "synthetic",
      workerSecret: "synthetic",
      allowedOrigins: [],
      models: modelEnvironments(() => undefined),
    });
    if (kind === "positive")
      expect(await b.removeObject("synthetic/private")).toEqual({
        object_id: object.id,
        object_version: object.version,
      });
    else
      await expect(b.removeObject("synthetic/private")).rejects.toMatchObject({
        code: "STORAGE_DELETE_RECEIPT_REQUIRED",
      });
  },
);
