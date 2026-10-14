import type { ReactNode } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";

export function AccessLayout({ children }: { children: ReactNode }) {
  return (
    <main className="access-page">
      <header className="access-header">
        <div className="access-brand" aria-label="Tenderdesk">
          <span className="brand-mark" aria-hidden="true">
            t<span>.</span>
          </span>
          <span>
            tenderdesk<span className="access-brand-dot">.</span>
          </span>
        </div>
        <span className="access-badge">
          <LockKeyhole size={14} aria-hidden="true" />
          Invitation only
        </span>
      </header>
      <div className="access-content">
        <section className="access-intro" aria-label="About Tenderdesk">
          <p className="access-eyebrow">
            A LITTLE MORE FOCUS. A LOT MORE CLARITY.
          </p>
          <h2>
            Your next opportunity.
            <br />
            <span>All in one place.</span>
          </h2>
          <p className="access-description">
            A focused workspace for your team’s tenders, documents, and
            proposals.
          </p>
          <div className="access-intro-note">
            <span aria-hidden="true" />
            <p>
              Built around your team.
              <br />
              <strong>Access starts with an invitation.</strong>
            </p>
          </div>
        </section>
        <div className="access-form-column">
          <div className="access-card">{children}</div>
          <div className="access-demo">
            <span>Just taking a look?</span>
            <a href={`${window.location.pathname}?mode=demo#/dashboard`}>
              Explore the demo <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <p>Sample data · Saved only in this browser</p>
          </div>
        </div>
      </div>
      <footer className="access-footer">
        Tenderdesk · Your team’s opportunity workspace
      </footer>
    </main>
  );
}
