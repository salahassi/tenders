import type { ConnectedExportFlow } from "../lib/useConnectedExport";
import { Button } from "./ui";
export default function ConnectedExportStatus({
  flow,
}: {
  flow: ConnectedExportFlow;
}) {
  if (!flow.busy && !flow.error && !flow.paused) return null;
  return (
    <div className="notice" role={flow.error ? "alert" : "status"}>
      {flow.error ? (
        <p>{flow.error}</p>
      ) : (
        <p>
          {flow.paused
            ? "You stopped waiting here. Select Download again to check the saved preparation."
            : "The complete Word package is being prepared and verified on the server."}
        </p>
      )}
      <p>
        You can leave this page and select Download again to retrieve the same
        saved package. This does not restart its deadline or approve the
        proposal.
      </p>
      {flow.busy && (
        <Button onClick={flow.stopWaiting}>Stop waiting here</Button>
      )}
      {!flow.busy && flow.saved?.status === "blocked" && (
        <Button onClick={() => void flow.retry()}>
          Retry export preparation
        </Button>
      )}
    </div>
  );
}
