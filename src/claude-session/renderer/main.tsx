import React from "react";
import ReactDOM from "react-dom/client";
import { ClaudeSessionView } from "./components/ClaudeSessionView.js";
import "./styles.css";

// Extract cwd from URL params (server sets it when launching)
const params = new URLSearchParams(window.location.search);
const cwd = params.get("cwd") ?? "";
const sessionId = params.get("session") ?? null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClaudeSessionView cwd={cwd} sessionId={sessionId} />
  </React.StrictMode>
);
