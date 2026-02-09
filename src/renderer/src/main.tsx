import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../../main/api";
import { initializeClientLogging } from "./logger";

// Detect if we're running in Electron or browser
const isElectron = typeof window !== "undefined" && window.electronAPI !== undefined;

// Create the appropriate tRPC client
function createClient() {
  if (isElectron) {
    // Use Electron IPC link
    const { ipcLink } = require("electron-trpc/renderer");
    return createTRPCProxyClient<AppRouter>({
      links: [ipcLink()],
    });
  } else {
    // Use HTTP link for web version
    return createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${window.location.origin}/trpc`,
        }),
      ],
    });
  }
}

export const client = createClient();

// Initialize client-side logging (only in Electron)
if (isElectron) {
  initializeClientLogging();
}

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(<App />);
