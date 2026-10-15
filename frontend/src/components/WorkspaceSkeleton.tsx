const bars = (count: number, className: string) =>
  Array.from({ length: count }, (_, index) => (
    <span key={index} className={`skeleton-block ${className}`} />
  ));

export function WorkspaceSkeleton() {
  return (
    <div className="app-shell shell-skeleton">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark">
            t<span>.</span>
          </span>
          <span>
            Tender<span className="brand-light">desk</span>
            <small>Opportunity workspace</small>
          </span>
        </div>
        <span className="skeleton-block skeleton-workspace" />
        <span className="skeleton-block skeleton-label" />
        {bars(5, "skeleton-nav")}
        <span className="skeleton-block skeleton-label skeleton-label-gap" />
        {bars(2, "skeleton-nav")}
        <div className="sidebar-bottom">
          <span className="skeleton-block skeleton-card" />
          <span className="skeleton-block skeleton-profile" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar" aria-hidden="true">
          <div className="topbar-left">
            <span className="skeleton-block skeleton-menu" />
            <span className="skeleton-block skeleton-crumb" />
          </div>
          <span className="skeleton-block skeleton-search" />
        </header>
        <div className="workspace-status" aria-hidden="true">
          <span className="skeleton-block skeleton-status" />
        </div>
        <main id="main" className="main-content" aria-busy="true">
          <div className="shell-skeleton-copy">
            <h1>Opening your workspace</h1>
            <p role="status">
              Checking your account and loading the workspace.
            </p>
            <span className="loading-line" />
          </div>
          <div className="shell-skeleton-body" aria-hidden="true">
            <span className="skeleton-block skeleton-title" />
            <span className="skeleton-block skeleton-banner" />
            <div className="metrics-grid">{bars(4, "skeleton-metric")}</div>
            <div className="dashboard-columns">
              <span className="skeleton-block skeleton-panel" />
              <span className="skeleton-block skeleton-panel skeleton-panel-side" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
