import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalTabProps {
  terminalId: string;
  worktreePath: string;
  isVisible: boolean;
  env?: Record<string, string>;
  initialCommand?: string;
  taskId?: string;
}

const darkTheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
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
};

const lightTheme = {
  background: "#ffffff",
  foreground: "#383a42",
  selectionBackground: "#b4d5fe",
  selectionForeground: "#000000",
  cursor: "#526eff",
  cursorAccent: "#ffffff",
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#a0a1a7",
  brightBlack: "#4f525e",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

function getTerminalTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? darkTheme
    : lightTheme;
}

const token = new URLSearchParams(window.location.search).get("token") ?? "";

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?token=${encodeURIComponent(token)}`;
}

const TerminalTab: React.FC<TerminalTabProps> = ({
  terminalId,
  worktreePath,
  isVisible,
  env,
  initialCommand,
  taskId,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!containerRef.current) return;

    const xterm = new Terminal({
      theme: getTerminalTheme(),
      fontFamily:
        '"SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri);
    }));

    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      ws.send(
        JSON.stringify({
          type: "create",
          terminalId,
          worktreePath,
          cols: xterm.cols,
          rows: xterm.rows,
          isDark,
          ...(env ? { env } : {}),
          ...(initialCommand ? { initialCommand } : {}),
          ...(taskId ? { taskId } : {}),
        })
      );
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "data" || msg.type === "buffered") {
        xterm.write(msg.data);
      } else if (msg.type === "exit") {
        xterm.write("\r\n[Terminal session ended]\r\n");
      }
    };

    // Send user input to server
    const dataDisposable = xterm.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", terminalId, data }));
      }
    });

    // Send resize events
    const resizeDisposable = xterm.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", terminalId, cols, rows }));
      }
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Follow OS color scheme changes
    const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onColorSchemeChange = () => {
      xterm.options.theme = getTerminalTheme();
    };
    colorSchemeQuery.addEventListener("change", onColorSchemeChange);

    return () => {
      mountedRef.current = false;
      colorSchemeQuery.removeEventListener("change", onColorSchemeChange);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      // Close WebSocket but don't kill the PTY
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [terminalId, worktreePath]);

  // Re-fit when visibility changes
  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      // Small delay to ensure DOM is laid out
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
        xtermRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  return (
    <div
      ref={containerRef}
      className="terminal-wrapper"
      style={{
        display: isVisible ? "block" : "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
};

export default TerminalTab;
