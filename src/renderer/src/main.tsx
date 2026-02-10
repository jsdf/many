import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../../main/api";

// Detect if we're running in Electron or browser
const isElectron = typeof window !== "undefined" && window.electronAPI !== undefined;

// Client is set before React renders
export let client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;

async function init() {
  if (isElectron) {
    // Dynamic import so Vite code-splits this and doesn't evaluate it in browser
    const { ipcLink } = await import("electron-trpc/renderer");
    client = createTRPCProxyClient<AppRouter>({
      links: [ipcLink()],
    });
    const { initializeClientLogging } = await import("./logger");
    initializeClientLogging();
  } else {
    client = createTRPCProxyClient<AppRouter>({
      links: [
        httpLink({
          url: `${window.location.origin}/trpc`,
        }),
      ],
    });
  }

  const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
  );
  root.render(<App />);
}

init();
