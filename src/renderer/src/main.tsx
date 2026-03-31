import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Re-export the RPC client for components
export { getRpcClient } from "./rpc-client";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);
root.render(<App />);
