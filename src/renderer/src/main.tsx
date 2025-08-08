import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { createTRPCProxyClient } from "@trpc/client";
import { ipcLink } from "electron-trpc/renderer";
import type { AppRouter } from "../../main/api";
import { initializeClientLogging } from "./logger";

export const client = createTRPCProxyClient<AppRouter>({
  links: [ipcLink()],
});

// Initialize client-side logging
initializeClientLogging();

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(<App />);
