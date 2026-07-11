import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getRpcClient } from "../rpc-client";
import type { TerminalEvent } from "../../../shared/protocol";

interface TerminalTabProps {
  terminalId: string;
  worktreePath: string;
  isVisible: boolean;
  serif?: boolean;
  env?: Record<string, string>;
  initialCommand?: string;
  taskId?: string;
  onTitleChange?: (title: string) => void;
}

const MONOSPACE_FONT =
  '"SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", monospace';

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

const TerminalTab: React.FC<TerminalTabProps> = ({
  terminalId,
  worktreePath,
  isVisible,
  serif,
  env,
  initialCommand,
  taskId,
  onTitleChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!containerRef.current) return;

    const xterm = new Terminal({
      theme: getTerminalTheme(),
      fontFamily: MONOSPACE_FONT,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => {
      const a = document.createElement("a");
      a.href = uri;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.click();
    }));

    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    // Create terminal session on server, then subscribe to output.
    // Must await create before subscribing — the server registers
    // data listeners on the session object, which must exist first.
    const unsubRef = { current: null as (() => void) | null };
    getRpcClient().query("terminal.create", {
      terminalId,
      worktreePath,
      cols: xterm.cols,
      rows: xterm.rows,
      isDark,
      ...(env ? { env } : {}),
      ...(initialCommand ? { initialCommand } : {}),
      ...(taskId ? { taskId } : {}),
    }).then(() => {
      if (!mountedRef.current) return;
      unsubRef.current = getRpcClient().subscribe(
        "terminal.events",
        (event: TerminalEvent) => {
          if (event.type === "data" || event.type === "buffered") {
            xterm.write(event.data);
          } else if (event.type === "exit") {
            xterm.write("\r\n[Terminal session ended]\r\n");
          }
        },
        { terminalId }
      );
    });
    const unsubscribe = () => unsubRef.current?.();

    // Translate Shift+Enter into ESC+CR (the Alt/Option+Enter sequence), which
    // Claude Code treats as "insert newline" without submitting. xterm.js 6 does
    // not advertise the kitty/modifyOtherKeys keyboard protocols, so Claude runs
    // in legacy mode where ESC+CR is the newline trick that works without them.
    // preventDefault() is required: returning false alone still lets xterm's
    // textarea emit a stray \r for the Enter key, which Claude reads as submit.
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        getRpcClient().query("terminal.input", { terminalId, data: "\x1b\r" });
        return false;
      }
      return true;
    });

    // Send user input to server
    const dataDisposable = xterm.onData((data) => {
      getRpcClient().query("terminal.input", { terminalId, data });
    });

    // Send resize events
    const resizeDisposable = xterm.onResize(({ cols, rows }) => {
      getRpcClient().query("terminal.resize", { terminalId, cols, rows });
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Surface terminal title changes (e.g. OSC 0/2 sequences from Claude Code)
    const titleDisposable = xterm.onTitleChange((title) => {
      onTitleChange?.(title);
    });

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
      titleDisposable.dispose();
      unsubscribe();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId, worktreePath]);

  // Toggle serif via the `.terminal-serif` class (rule in styles.css), which
  // restyles `.xterm-rows` glyphs while leaving xterm's monospace cell metrics
  // untouched.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.classList.toggle("terminal-serif", !!serif);
  }, [serif]);

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
