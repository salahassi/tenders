import { useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, Check, ArrowUpRight } from "lucide-react";
import { useApp } from "../lib/store";
import { Button, EmptyState, PageHeader, Tabs } from "../components/ui";
import "./admin.css";
export default function Notifications() {
  const { state, update, notify } = useApp();
  const [active, setActive] = useState("all");
  const unread = state.notifications.filter((n) => !n.read).length;
  const items = state.notifications.filter((n) => active === "all" || !n.read);
  const read = (id: string) =>
    update((s) => ({
      ...s,
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n,
      ),
    }));
  const markAll = async () => {
    if (
      !(await update((s) => ({
        ...s,
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
      })))
    )
      return;
    notify("All notifications marked as read.");
  };
  return (
    <>
      <PageHeader
        eyebrow="STAY IN THE LOOP"
        title="Notifications"
        description="A clear view of decisions, drafts, and items that need your attention."
        actions={
          <Button variant="secondary" onClick={markAll} disabled={!unread}>
            <CheckCheck size={16} /> Mark all as read
          </Button>
        }
      />
      <div className="admin-toolbar">
        <Tabs
          items={[
            {
              id: "all",
              label: "All updates",
              count: state.notifications.length,
            },
            { id: "unread", label: "Unread", count: unread },
          ]}
          active={active}
          onChange={setActive}
        />
        <span className="admin-filter-count">
          In-app updates only · external messages are disabled
        </span>
      </div>
      <div className="panel">
        {items.length ? (
          items.map((n) => (
            <article
              className={`admin-notification ${!n.read ? "unread" : ""}`}
              key={n.id}
            >
              <span className={`admin-dot ${n.read ? "read" : ""}`} />
              <span className="admin-source-icon">
                <Bell size={18} />
              </span>
              <div className="admin-notification-main">
                <h3>{n.title}</h3>
                <p>{n.body}</p>
                <time dateTime={n.createdAt}>
                  {new Date(n.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div className="admin-notification-actions">
                {n.href.startsWith("/") && !n.href.startsWith("//") && (
                  <Link
                    className="admin-link small"
                    to={n.href}
                    onClick={() => read(n.id)}
                  >
                    View <ArrowUpRight size={12} />
                  </Link>
                )}
                {!n.read && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => read(n.id)}
                    aria-label={`Mark ${n.title} as read`}
                  >
                    <Check size={15} />
                  </Button>
                )}
              </div>
            </article>
          ))
        ) : (
          <EmptyState
            title={
              active === "unread"
                ? "You're all caught up"
                : "No notifications yet"
            }
            description={
              active === "unread"
                ? "New decisions and workflow updates will appear here."
                : "Local workflow notifications will appear here as you explore the workspace."
            }
          />
        )}
      </div>
    </>
  );
}
