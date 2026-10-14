import { Link } from "react-router-dom";
import { ArrowUpRight, CalendarDays } from "lucide-react";
import type { Opportunity } from "../types";
import { date, deadlineLabel, daysLeft } from "../lib/format";
import { deadlineSourceLabel, opportunityStatusLabel } from "../lib/workflow";
import { EmptyState, Badge } from "./ui";
export default function OpportunityTable({
  items,
  compact = false,
}: {
  items: Opportunity[];
  compact?: boolean;
}) {
  if (!items.length)
    return (
      <EmptyState
        title="No selected opportunities"
        description="Choose opportunities from the Review inbox, or add one you already want to pursue."
        action={
          <Link className="btn btn-primary" to="/review">
            Open Review inbox
          </Link>
        }
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
            <th scope="col">RFP files</th>
            <th scope="col">Closing date</th>
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
                  <div className="buyer-icon green">
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
                {o.documents.length
                  ? `${o.documents.length} attached`
                  : "Upload RFP to start"}
              </td>
              <td>
                <div className="deadline-cell">
                  <span>
                    <CalendarDays size={13} />
                    {date(o.deadline)}
                  </span>
                  <small className={daysLeft(o.deadline) <= 7 ? "urgent" : ""}>
                    {deadlineLabel(o.deadline)}
                  </small>
                  <small>{deadlineSourceLabel(o)}</small>
                </div>
              </td>
              <td>
                <Badge tone={o.status === "in_progress" ? "blue" : "neutral"}>
                  {opportunityStatusLabel(o.status)}
                </Badge>
              </td>
              <td>
                <Link
                  className="btn btn-ghost btn-sm"
                  to={`/opportunities/${o.id}`}
                  aria-label={`Open ${o.title}`}
                >
                  Open <ArrowUpRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
