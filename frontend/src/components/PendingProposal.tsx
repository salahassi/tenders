import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BackendRequestError } from "../lib/backendClient";
import { useApp } from "../lib/store";
import GenerationPanel from "./GenerationPanel";
import { Button, EmptyState, PageHeader } from "./ui";

type ProposalRecord = {
  id: string;
  opportunity_id: string;
  active_version_id: string | null;
};

/** A proposal exists before its first version. Check the authorized record
 * instead of manufacturing an editable version or treating that gap as a 404. */
export default function PendingProposal({ id }: { id: string }) {
  const { backend, state, refresh } = useApp();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const opportunitiesRef = useRef(state.opportunities);
  opportunitiesRef.current = state.opportunities;
  const [record, setRecord] = useState<ProposalRecord | null>(null);
  const [status, setStatus] = useState<
    "loading" | "found" | "missing" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setRecord(null);
    void (async () => {
      try {
        const response = await backend!.request<ProposalRecord>(
          `/v1/proposals/${id}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (
          response.data?.id !== id ||
          typeof response.data.opportunity_id !== "string"
        )
          throw new Error("The proposal response could not be read.");
        setRecord(response.data);
        // A newly completed proposal may not be in the workspace snapshot yet.
        // Refresh once; the parent renders its real version when it arrives.
        if (
          response.data.active_version_id ||
          !opportunitiesRef.current.some(
            (item) => item.id === response.data.opportunity_id,
          )
        )
          await refreshRef.current?.();
        if (!controller.signal.aborted) setStatus("found");
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (
          failure instanceof BackendRequestError &&
          [403, 404].includes(failure.status)
        )
          setStatus("missing");
        else {
          setError(
            failure instanceof Error
              ? failure.message
              : "The proposal could not be loaded.",
          );
          setStatus("error");
        }
      }
    })();
    return () => controller.abort();
  }, [backend, id, attempt]);

  if (status === "loading") return <p role="status">Loading proposal…</p>;
  if (status === "missing")
    return (
      <EmptyState
        title="Proposal not found"
        description="Choose a proposal linked to an opportunity."
        action={<Link to="/proposals">All proposals</Link>}
      />
    );
  if (status === "error")
    return (
      <section className="panel">
        <h1>Cannot load proposal</h1>
        <p role="alert">{error}</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </section>
    );
  const opportunity = state.opportunities.find(
    (item) => item.id === record?.opportunity_id,
  );
  if (record?.active_version_id || !opportunity)
    return (
      <EmptyState
        title="Proposal data is not loaded"
        description="Refresh the workspace to load the saved proposal and its linked opportunity."
        action={
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Refresh workspace
          </Button>
        }
      />
    );
  return (
    <div className="workspace-page">
      <PageHeader
        eyebrow="PROPOSAL"
        title="Proposal preparation"
        description="A complete proposal file has not been saved yet. View preparation progress and any steps that need attention below."
        actions={
          <Link
            className="btn btn-secondary"
            to={`/opportunities/${opportunity.id}`}
          >
            Open opportunity
          </Link>
        }
      />
      <GenerationPanel opportunity={opportunity} showOpenLink={false} />
    </div>
  );
}
