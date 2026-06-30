import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MobileApp from "./components/MobileApp";
import "./styles.css";

// Re-export the RPC client for components
export { getRpcClient } from "./rpc-client";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

// The simplified mobile UI is a standalone full-screen view at /mobile, separate
// from the desktop worktree-manager chrome.
const isMobile = window.location.pathname.replace(/^\/+/, "").startsWith("mobile");
root.render(isMobile ? <MobileApp /> : <App />);
