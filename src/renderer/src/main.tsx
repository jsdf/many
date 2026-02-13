import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../../web/server";

const token = new URLSearchParams(window.location.search).get("token") ?? "";

export const client = createTRPCProxyClient<AppRouter>({
  links: [
    httpLink({
      url: `${window.location.origin}/trpc`,
      headers: () => ({
        "x-token": token,
      }),
    }),
  ],
});

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(<App />);
