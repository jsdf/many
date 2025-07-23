import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  workingDirectory?: string;
  onTitleChange?: (title: string) => void;
  terminalId?: string;
  initialCommand?: string;
}

const Terminal: React.FC<TerminalProps> = ({
  workingDirectory,
  onTitleChange,
  terminalId = "terminal-" + Math.random().toString(36).substr(2, 9),
  initialCommand,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm instance
    const xterm = new XTerm({
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#ffffff",
        cursorAccent: "#000000",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      fontFamily:
        '"Cascadia Code", "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 1000,
      rightClickSelectsWord: true,
    });

    // Create addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    // Load addons
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    // Store refs
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Open terminal
    xterm.open(terminalRef.current);

    // Fit to container
    fitAddon.fit();

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };

    // Set up resize observer
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalRef.current);

    // Connect to backend terminal process
    connectToTerminal(
      xterm,
      workingDirectory,
      terminalId,
      setIsConnected,
      onTitleChange,
      initialCommand
    );

    return () => {
      resizeObserver.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [workingDirectory, terminalId, onTitleChange, initialCommand]);

  // Handle container resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current) {
        setTimeout(() => {
          fitAddonRef.current?.fit();
        }, 0);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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

// This function will connect to the terminal process via IPC
async function connectToTerminal(
  xterm: XTerm,
  workingDirectory: string | undefined,
  terminalId: string,
  setIsConnected: (connected: boolean) => void,
  onTitleChange?: (title: string) => void,
  initialCommand?: string
) {
  try {
    // Request a new terminal session from the main process
    const terminalSession = await window.electronAPI.createTerminalSession({
      terminalId,
      workingDirectory,
      cols: xterm.cols,
      rows: xterm.rows,
      initialCommand: initialCommand,
    });

    setIsConnected(true);

    // Handle data from terminal process
    const dataHandler = window.electronAPI.onTerminalData?.(
      terminalId,
      (data: string) => {
        try {
          xterm.write(data);
        } catch (error) {
          console.error("Error writing to terminal:", error);
        }
      }
    );

    // Handle terminal process exit
    const exitHandler = window.electronAPI.onTerminalExit?.(terminalId, () => {
      try {
        setIsConnected(false);
        xterm.write("\r\n[Terminal session ended]\r\n");
      } catch (error) {
        console.error("Error handling terminal exit:", error);
      }
    });

    // Handle terminal title changes
    const titleHandler = window.electronAPI.onTerminalTitle?.(
      terminalId,
      (title: string) => {
        try {
          onTitleChange?.(title);
        } catch (error) {
          console.error("Error handling title change:", error);
        }
      }
    );

    // Send data from xterm to terminal process
    const dataDisposable = xterm.onData((data) => {
      try {
        window.electronAPI.sendTerminalData?.(terminalId, data);
      } catch (error) {
        console.error("Error sending terminal data:", error);
      }
    });

    // Handle terminal resize
    const resizeDisposable = xterm.onResize(({ cols, rows }) => {
      try {
        window.electronAPI.resizeTerminal?.(terminalId, cols, rows);
      } catch (error) {
        console.error("Error resizing terminal:", error);
      }
    });

    // Set initial title
    onTitleChange?.(`Terminal ${terminalId.slice(-4)}`);

    // Return cleanup function
    return () => {
      try {
        dataHandler?.();
        exitHandler?.();
        titleHandler?.();
        dataDisposable?.dispose();
        resizeDisposable?.dispose();
      } catch (error) {
        console.error("Error cleaning up terminal handlers:", error);
      }
    };
  } catch (error) {
    console.error("Failed to connect to terminal:", error);
    try {
      xterm.write("\r\n[Failed to start terminal session]\r\n");
    } catch (writeError) {
      console.error("Error writing failure message:", writeError);
    }
    setIsConnected(false);
    return () => {}; // Return empty cleanup function
  }
}

export default Terminal;
