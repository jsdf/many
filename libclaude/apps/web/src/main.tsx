import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClaudeView } from "@libclaude/react";
import { rpc } from "./rpc.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClaudeView rpc={rpc} />
  </StrictMode>,
);
