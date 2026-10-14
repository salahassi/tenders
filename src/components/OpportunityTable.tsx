import { Link } from "react-router-dom";
import { ArrowUpRight, Bookmark, CalendarDays } from "lucide-react";
import type { Opportunity } from "../types";
import { useApp } from "../lib/store";
import { date, deadlineLabel, daysLeft } from "../lib/format";
import { EmptyState, Score, StatusBadge } from "./ui";
export default function OpportunityTable({
  items,
  compact = false,
}: {
  items: Opportunity[];
  compact?: boolean;
}) {
  const { state, update, notify } = useApp();
  if (!items.length)
    return (
      <EmptyState
        title="No opportunities match"
        description="Try another filter, or add a public sample to start your pipeline."
      />
    );
  return (
    <div className="table-wrap">
      <table
        className={`data-table opportunity-table ${compact ? "compact" : ""}`}
      >
        <thead>
          <tr>
            <th scope="col">Opportunity</th>
            <th scope="col">Fit score</th>
            <th scope="col">Deadline</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td>
                <div className="opportunity-title">
                  <div
                    className={`buyer-icon ${o.category === "Systems integration" ? "blue" : o.category === "AI & analytics" ? "green" : "sand"}`}
                  >
                    {o.buyer
                      .split(" ")
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")}
                  </div>
                  <div>
                    <Link to={`/opportunities/${o.id}`} className="table-title">
                      {o.title}
                    </Link>
                    <div className="table-subtitle">
                      <span>{o.buyer}</span>
                      <span className="tiny-dot" />
                      {o.category}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <Score value={o.score} coverage={o.coverage} />
              </td>
              <td>
                <div className="deadline-cell">
                  <span>
                    <CalendarDays size={13} />
                    {date(o.deadline).replace(/, \d{4}/, "")}
                  </span>
                  <small className={daysLeft(o.deadline) <= 7 ? "urgent" : ""}>
                    {deadlineLabel(o.deadline)}
                  </small>
                </div>
              </td>
              <td>
                <StatusBadge status={o.status} />
              </td>
              <td>
                <div className="row-actions">
                  <button
                    className={`icon-button save-button ${o.saved ? "saved" : ""}`}
                    title={o.saved ? "Remove bookmark" : "Save opportunity"}
                    aria-label={`${o.saved ? "Unsave" : "Save"} ${o.title}`}
                    disabled={state.settings.role === "Reviewer"}
                    onClick={() => {
                      update(
                        (s) => ({
                          ...s,
                          opportunities: s.opportunities.map((x) =>
                            x.id === o.id ? { ...x, saved: !x.saved } : x,
                          ),
                        }),
                        "Bookmark changed",
                        o.title,
                      );
                      notify(
                        o.saved ? "Bookmark removed" : "Opportunity saved",
                      );
                    }}
                  >
                    <Bookmark
                      size={17}
                      fill={o.saved ? "currentColor" : "none"}
                    />
                  </button>
                  <Link
                    to={`/opportunities/${o.id}`}
                    className="icon-button"
                    aria-label={`Open ${o.title}`}
                  >
                    <ArrowUpRight size={18} />
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
