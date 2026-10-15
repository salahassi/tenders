import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { captureAuthCallback } from "./lib/authCallback";
import { AppProvider } from "./lib/store";
import { InvitationRouteCapture } from "./lib/InvitationRouteCapture";
import App from "./App";
import "./styles.css";

captureAuthCallback();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <InvitationRouteCapture />
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </React.StrictMode>,
);
