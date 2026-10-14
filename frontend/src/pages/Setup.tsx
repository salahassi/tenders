import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Database,
  ShieldCheck,
  Workflow,
  ArrowRight,
  LockKeyhole,
  Layers3,
} from "lucide-react";
import { Badge, PageHeader } from "../components/ui";
import "./admin.css";
import { useApp } from "../lib/store";
export default function Setup() {
  const { mode, operations } = useApp();
  const connected = mode === "CONNECTED_FREE";
  if (connected)
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
            Last worker heartbeat:{" "}
            {operations?.lastHeartbeat || "none recorded"}.
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
  return (
    <>
      <PageHeader
        eyebrow="GETTING STARTED"
        title="Your workspace, ready to explore"
        description="Try the complete workflow locally, then connect the services when you are ready."
      />
      <div className="admin-state-banner">
        <Layers3 size={24} />
        <div>
          <strong>Demo mode is active.</strong>
          <p>
            <a href={`${window.location.pathname}?mode=connected`}>
              Sign in to the connected workspace
            </a>
          </p>
          <p>
            Your edits stay in this browser. No live tenders are collected, no
            model is called, and no paid service is enabled.
          </p>
        </div>
      </div>
      <div className="split-layout">
        <div className="panel admin-section">
          <div className="admin-spread">
            <h2>Connection checklist</h2>
            <Badge tone="amber">Backend not configured</Badge>
          </div>
          <div className="admin-step">
            <span className="admin-step-number">
              <CheckCircle2 size={17} />
            </span>
            <div className="admin-step-main">
              <h3>Explore the demo workspace</h3>
              <p>
                Discover sample opportunities, review an RFP, edit a proposal,
                and export a Word draft. Changes persist locally.
              </p>
              <Link className="admin-link" to="/opportunities">
                Browse opportunities <ArrowRight size={13} />
              </Link>
            </div>
            <Badge tone="green">Available</Badge>
          </div>
          <div className="admin-step">
            <span className="admin-step-number">2</span>
            <div className="admin-step-main">
              <h3>Connect the authenticated backend</h3>
              <p>
                The implementation needs Supabase Auth, database policies,
                private Storage, and the documented API. This frontend does not
                simulate a secure live connection.
              </p>
            </div>
            <Badge tone="neutral">Pending</Badge>
          </div>
          <div className="admin-step">
            <span className="admin-step-number">3</span>
            <div className="admin-step-main">
              <h3>Verify the free model account</h3>
              <p>
                Configure provider credentials in backend secrets only. Confirm
                actual free quotas and data terms before enabling inference.
              </p>
            </div>
            <Badge tone="neutral">Pending</Badge>
          </div>
          <div className="admin-step">
            <span className="admin-step-number">4</span>
            <div className="admin-step-main">
              <h3>Approve your real sources and company facts</h3>
              <p>
                Add permitted sources, verified public or sanitized company
                information, and labeled examples to evaluate matching quality.
              </p>
              <Link className="admin-link" to="/sources">
                Review sources <ArrowRight size={13} />
              </Link>
            </div>
            <Badge tone="neutral">Owner input</Badge>
          </div>
          <div className="admin-step">
            <span className="admin-step-number">5</span>
            <div className="admin-step-main">
              <h3>Activate and verify the scheduler</h3>
              <p>
                Confirm background jobs, retries, quota stops, private-file
                access, and monitoring before relying on unattended collection.
              </p>
            </div>
            <Badge tone="neutral">Pending</Badge>
          </div>
        </div>
        <div className="stack">
          <div className="panel admin-section">
            <h2>Free-first by design</h2>
            <ul className="admin-feature-list" style={{ marginTop: 22 }}>
              <li>
                <ShieldCheck />
                <span>
                  <strong>No paid fallback</strong>
                  <br />
                  <span className="muted">
                    At the limit, pause and explain what happened.
                  </span>
                </span>
              </li>
              <li>
                <LockKeyhole />
                <span>
                  <strong>Secrets stay on the server</strong>
                  <br />
                  <span className="muted">
                    Never paste API keys into this demo or commit them to
                    GitHub.
                  </span>
                </span>
              </li>
              <li>
                <Database />
                <span>
                  <strong>Use trial-safe data</strong>
                  <br />
                  <span className="muted">
                    Public, synthetic, or sanitized content only. This is not a
                    confidential production workspace.
                  </span>
                </span>
              </li>
              <li>
                <Workflow />
                <span>
                  <strong>Keep human decisions clear</strong>
                  <br />
                  <span className="muted">
                    Purchase and submission remain manual. Approval does not
                    initiate a payment.
                  </span>
                </span>
              </li>
            </ul>
          </div>
          <div className="panel admin-section">
            <span className="admin-kicker">Suggested trial</span>
            <h2>Start small. Learn quickly.</h2>
            <p className="admin-help">
              Five approved sources, 50–100 labeled advertisements, and three
              sample RFP packages give you a practical first evaluation.
            </p>
            <Link className="admin-link" to="/settings">
              Workspace preferences →
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
