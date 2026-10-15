import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readPendingInvitation } from "./invitations";

/** Persist invite tokens from `#/invite/<token>` HashRouter paths for AuthPanel. */
export function InvitationRouteCapture() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!/^\/invite\/[a-f0-9]{64}$/.test(location.pathname)) return;
    readPendingInvitation(location.pathname);
    navigate("/", { replace: true });
  }, [location.pathname, navigate]);
  return null;
}
