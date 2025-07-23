import React, { useEffect, useRef, useState } from "react";
import { TerminalSession } from "./TerminalSession";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  workingDirectory?: string;
  onTitleChange?: (title: string) => void;
  terminalId?: string;
  initialCommand?: string;
  worktreePath?: string;
}

const Terminal: React.FC<TerminalProps> = ({
  workingDirectory,
  onTitleChange,
  terminalId = "terminal-" + Math.random().toString(36).substr(2, 9),
  initialCommand,
  worktreePath,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  console.log("Initializing terminal", terminalId, workingDirectory);

  // Create TerminalSession instance once
  useEffect(() => {
    if (!terminalRef.current) return;

    const session = new TerminalSession(terminalRef.current);
    sessionRef.current = session;

    // Set up callbacks
    session.setCallbacks({
      onConnectionChange: setIsConnected,
      onTitleChange: onTitleChange,
    });

    // Connect to backend with current parameters
    session.connectToBackend({
      terminalId,
      workingDirectory,
      initialCommand,
      worktreePath,
    });

    return () => {
      session.dispose();
      sessionRef.current = null;
    };
  }, []); // Only run once when component mounts

  // Update session when connection parameters change
  useEffect(() => {
    if (!sessionRef.current) return;

    // Update callbacks in case they changed
    sessionRef.current.setCallbacks({
      onConnectionChange: setIsConnected,
      onTitleChange: onTitleChange,
    });
  }, [onTitleChange]);

  return (
    <div className="terminal-container">
      <div className="terminal-status">
        <span
          className={`status-indicator ${
            isConnected ? "connected" : "disconnected"
          }`}
        >
          {isConnected ? "●" : "○"}
        </span>
        <span className="terminal-path">{workingDirectory || "~"}</span>
      </div>
      <div
        ref={terminalRef}
        className="terminal-wrapper"
        style={{ width: "100%", height: "calc(100% - 30px)" }}
      />
    </div>
  );
};

export default Terminal;
