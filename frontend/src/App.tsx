import OriginalEligibility from "./components/OriginalEligibility";
import { useEffect, useState, lazy, Suspense } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Command,
  FileText,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Menu,
  Radio,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Target,
  WifiOff,
  X,
} from "lucide-react";
import { useApp } from "./lib/store";
import { Button, EmptyState, Modal } from "./components/ui";
import ErrorBoundary from "./components/ErrorBoundary";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Opportunities = lazy(() => import("./pages/Opportunities"));
const OpportunityDetail = lazy(() => import("./pages/OpportunityDetail"));
const Review = lazy(() => import("./pages/Review"));
const Proposals = lazy(() => import("./pages/Proposals"));
const ProposalEditor = lazy(() => import("./pages/ProposalEditor"));
const Sources = lazy(() => import("./pages/Sources"));
const SourceDetail = lazy(() => import("./pages/SourceDetail"));
const Knowledge = lazy(() => import("./pages/Knowledge"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Settings = lazy(() => import("./pages/Settings"));
const Setup = lazy(() => import("./pages/Setup"));
const Notifications = lazy(() => import("./pages/Notifications"));
const nav = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/review", label: "Review inbox", icon: ListChecks },
  { to: "/opportunities", label: "Opportunities", icon: Target },
  { to: "/proposals", label: "Proposals", icon: FileText },
  { to: "/sources", label: "Sources", icon: Radio },
  { to: "/knowledge", label: "Company knowledge", icon: BookOpen },
];
export default function App() {
  const {
    state,
    ready,
    storageError,
    toast,
    clearToast,
    mode,
    saving,
    userLabel,
    refresh,
    signOut,
  } = useApp();
  const connected = mode === "CONNECTED_FREE";
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [help, setHelp] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const unread = state.notifications.filter((n) => !n.read).length;
  const reviewCount = state.opportunities.filter(
    (o) => o.status === "new" || o.status === "deferred",
  ).length;
  useEffect(() => {
    setMenu(false);
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    const fn = () => setOffline(!navigator.onLine);
    window.addEventListener("online", fn);
    window.addEventListener("offline", fn);
    return () => {
      window.removeEventListener("online", fn);
      window.removeEventListener("offline", fn);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clearToast, 5000);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);
  if (!ready)
    return (
      <div className="app-loading">
        <div className="brand-mark">
          t<span>.</span>
        </div>
        <h2>Opening your workspace</h2>
        <p>Loading your saved opportunities…</p>
        <span className="loading-line" />
      </div>
    );
  const results = query.trim()
    ? state.opportunities
        .filter((o) =>
          `${o.title} ${o.buyer} ${o.reference}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 6)
    : [];
  return (
    <ErrorBoundary>
      {connected && <OriginalEligibility />}
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="app-shell">
        {menu && (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
          />
        )}
        <aside className={`sidebar ${menu ? "is-open" : ""}`}>
          <Link to="/dashboard" className="brand">
            <span className="brand-mark">
              t<span>.</span>
            </span>
            <span>
              Tender<span className="brand-light">desk</span>
              <small>Opportunity workspace</small>
            </span>
          </Link>
          <button
            className="workspace-selector"
            onClick={() => navigate("/settings")}
          >
            <span className="workspace-avatar">TL</span>
            <span>
              <strong>{state.settings.companyName || "Trial workspace"}</strong>
              <small>Free trial workspace</small>
            </span>
            <ChevronDown size={15} />
          </button>
          <div className="nav-section-label">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "active" : ""}`
                }
              >
                <n.icon size={19} />
                <span>{n.label}</span>
                {n.to === "/review" && reviewCount > 0 && (
                  <b className="nav-count">{reviewCount}</b>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="nav-section-label operations-label">OPERATIONS</div>
          <NavLink to="/jobs" className="nav-item">
            <Gauge size={19} />
            <span>Activity & jobs</span>
          </NavLink>
          <NavLink to="/settings" className="nav-item">
            <SettingsIcon size={19} />
            <span>Settings</span>
          </NavLink>
          <div className="sidebar-bottom">
            <div className="trial-card">
              <div>
                <span className="pulse-dot" /> Connected workspace
              </div>
              <p>Your records are saved to your authorized workspace.</p>
              <Link to="/setup">
                View setup <ArrowUpRight size={14} />
              </Link>
            </div>
            <button
              className="profile-button"
              onClick={() => navigate("/settings")}
            >
              <span className="user-avatar">DU</span>
              <span>
                <strong>{userLabel || "Workspace member"}</strong>
                <small>{state.settings.role} · Connected workspace</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-left">
              <Button
                variant="ghost"
                className="mobile-menu"
                aria-label="Open navigation"
                onClick={() => setMenu(true)}
              >
                <Menu size={21} />
              </Button>
              <span className="breadcrumb">
                Workspace <span>/</span>{" "}
                <strong>
                  {nav.find((n) => location.pathname.startsWith(n.to))?.label ||
                    ({
                      jobs: "Activity & jobs",
                      settings: "Settings",
                      setup: "Setup",
                      notifications: "Notifications",
                    }[location.pathname.split("/")[1]] ??
                      "Overview")}
                </strong>
              </span>
            </div>
            <div className="topbar-actions">
              <button
                className="global-search"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={16} />
                <span>Find anything…</span>
                <kbd>
                  <Command size={10} /> K
                </kbd>
              </button>
              <button
                className="icon-button help-button"
                aria-label="Workspace guide"
                onClick={() => setHelp(true)}
              >
                <CircleHelp size={19} />
              </button>
              <Link
                to="/notifications"
                className="icon-button notification-button"
                aria-label={`Notifications, ${unread} unread`}
              >
                <Bell size={19} />
                {unread > 0 && <i />}
              </Link>
              <div className="topbar-divider" />
              {connected && (
                <>
                  <button
                    className="btn btn-ghost"
                    disabled={saving}
                    onClick={() => void refresh?.()}
                  >
                    Refresh
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => void signOut?.()}
                  >
                    Sign out
                  </button>
                </>
              )}
              <span className="avatar-small">{connected ? "U" : "DU"}</span>
            </div>
          </header>
          <div className="workspace-status">
            <Sparkles size={14} />
            <span>
              <>
                <strong>
                  {saving
                    ? "Saving to your workspace…"
                    : "Connected workspace."}
                </strong>{" "}
                Your records use your signed-in access.
              </>
            </span>
            <Link to="/setup">
              Setup details <ArrowUpRight size={13} />
            </Link>
          </div>
          {offline && (
            <div className="notice notice-warning">
              <WifiOff size={17} /> You are offline. Server changes cannot be
              saved until the connection returns.
            </div>
          )}
          {storageError && (
            <div className="notice notice-error" role="alert">
              {storageError}{" "}
              {!connected &&
                "Keep this tab open and export a backup from Settings."}
            </div>
          )}
          <main id="main" tabIndex={-1} className="main-content">
            <Suspense
              fallback={
                <div className="view-loading">
                  <span className="loading-line" />
                  <p>Loading workspace…</p>
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/opportunities" element={<Opportunities />} />
                <Route
                  path="/opportunities/:id"
                  element={<OpportunityDetail />}
                />
                <Route path="/review" element={<Review />} />
                <Route path="/proposals" element={<Proposals />} />
                <Route path="/proposals/:id" element={<ProposalEditor />} />
                <Route path="/sources" element={<Sources />} />
                <Route path="/sources/:id" element={<SourceDetail />} />
                <Route path="/knowledge" element={<Knowledge />} />
                <Route path="/jobs" element={<Jobs />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route
                  path="*"
                  element={
                    <EmptyState
                      title="This page isn't here"
                      description="Return to your workspace to continue."
                      action={
                        <Link className="btn btn-primary" to="/dashboard">
                          Back to overview
                        </Link>
                      }
                    />
                  }
                />
              </Routes>
            </Suspense>
          </main>
          <footer className="workspace-footer">
            <span>
              Tenderdesk <span>·</span> Your next opportunity, in focus.
            </span>
            <span>
              <span className="status-dot" /> Connected workspace <span>·</span>{" "}
              Asia/Riyadh
            </span>
          </footer>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={clearToast}>
            <X size={15} />
          </button>
        </div>
      )}
      <Modal
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setQuery("");
        }}
        title="Find an opportunity"
      >
        <div className="search-field">
          <Search size={18} />
          <input
            aria-label="Search all opportunities"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, buyer, or reference…"
            autoFocus
          />
        </div>
        <div className="search-results">
          {results.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                navigate(`/opportunities/${o.id}`);
                setSearchOpen(false);
                setQuery("");
              }}
            >
              <Target size={18} />
              <span>
                <strong>{o.title}</strong>
                <small>
                  {o.buyer} · {o.reference}
                </small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
          {query && results.length === 0 && (
            <EmptyState
              title="No matching opportunities"
              description="Try a different buyer, title, or reference."
            />
          )}
          {!query && (
            <p className="muted">
              Start typing to search your saved workspace.
            </p>
          )}
        </div>
      </Modal>
      <Modal
        open={help}
        onClose={() => setHelp(false)}
        title="Your opportunity workflow"
      >
        <ol className="guide-list">
          <li>
            <strong>Review incoming opportunities</strong>
            <p>
              Open the Review inbox and approve the opportunities you want to
              pursue. Approved items move to Opportunities.
            </p>
          </li>
          <li>
            <strong>Upload the RFP</strong>
            <p>
              Open an approved opportunity and add the RFP and any supporting
              documents.
            </p>
          </li>
          <li>
            <strong>Prepare your proposal</strong>
            <p>
              Use company reference files and add any information requested by
              the RFP. The connected agent will use these inputs to draft and
              refine the proposal.
            </p>
          </li>
          <li>
            <strong>Generate the file</strong>
            <p>
              Review the saved proposal before exporting a Word file. AI
              drafting and rewriting will become available after model
              activation.
            </p>
          </li>
        </ol>
        <div className="notice">
          Sign-in and core records use the server. File workflows, automated
          collection, and AI drafting are still being completed.
        </div>
      </Modal>
    </ErrorBoundary>
  );
}
