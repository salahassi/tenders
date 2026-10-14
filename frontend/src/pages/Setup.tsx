import { Link } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { useApp } from "../lib/store";
import "./admin.css";
export default function Setup() {
  const { operations } = useApp();
  return (
    <>
      <PageHeader
        eyebrow="CONNECTION STATUS"
        title="Connected workspace"
        description="Sign-in and core records use your account."
      />
      <div className="panel admin-section stack">
        <h2>Current service status</h2>
        <p>Access: verified workspace membership.</p>
        <p>Core records: read and saved through the server.</p>
        <p>
          Scheduler:{" "}
          {operations?.schedulerEnabled ? "enabled" : "not activated"}.
        </p>
        <p>
          Last worker heartbeat: {operations?.lastHeartbeat || "none recorded"}.
        </p>
        <p>
          Last successful collection:{" "}
          {operations?.lastCollection || "none recorded"}.
        </p>
        <p>
          File workflows, automated collection, AI analysis, and proposal
          generation are still being completed.
        </p>
        <Link to="/settings" className="btn btn-primary">
          Workspace settings and users
        </Link>
      </div>
    </>
  );
}
