import { useLayoutEffect, useRef, useState } from "react";
import type { BackendClient } from "../lib/backendClient";
import { Button } from "./ui";
import DeliveryDraft from "./DeliveryDraft";

export default function PrepareDeliveryDraft({
  client,
  opportunityId,
  disabled,
  intakeFailure,
}: {
  client: BackendClient;
  opportunityId: string;
  disabled?: boolean;
  intakeFailure?: string;
}) {
  const [snapshotId, setSnapshotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setSnapshotId("");
    setBusy(false);
    setError("");
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, opportunityId]);
  return (
    <section className="stack">
      <div className="panel">
        <h2>Save an available draft</h2>
        <p>
          Save the available source content and missing inputs now. If there is
          insufficient scope information, the saved template will show yellow
          placeholders. This does not mark the proposal complete or stop model
          processing.
        </p>
        <Button
          disabled={disabled || busy}
          onClick={async () => {
            pending.current?.abort();
            const controller = new AbortController();
            pending.current = controller;
            const current = () =>
              pending.current === controller && !controller.signal.aborted;
            setBusy(true);
            setError("");
            try {
              const { data: opportunity } = await client.request<{
                revision: number;
              }>(`/v1/opportunities/${opportunityId}`, {
                signal: controller.signal,
              });
              if (!current()) return;
              const { data } = await client.request<Array<{ id: string }>>(
                "/v1/commands",
                {
                  method: "POST",
                  idempotencyKey: crypto.randomUUID(),
                  signal: controller.signal,
                  body: {
                    commands: [
                      {
                        operation: "delivery.snapshot.prepare",
                        input: {
                          opportunity_id: opportunityId,
                          expected_revision: opportunity.revision,
                          ...(intakeFailure
                            ? { intake_failure: intakeFailure }
                            : {}),
                        },
                      },
                    ],
                  },
                },
              );
              if (!current()) return;
              if (!data[0]?.id)
                throw new Error("The saved draft could not be identified.");
              setSnapshotId(data[0].id);
            } catch (failure) {
              if (current())
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not save the available draft.",
                );
            } finally {
              if (current()) {
                setBusy(false);
                pending.current = null;
              }
            }
          }}
        >
          {busy ? "Saving available draft…" : "Save available draft"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
      {snapshotId && <DeliveryDraft client={client} snapshotId={snapshotId} />}
    </section>
  );
}
