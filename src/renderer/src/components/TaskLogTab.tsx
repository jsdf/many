import React, { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getRpcClient } from "../rpc-client";

const darkTheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  cursor: "#1e1e1e", // hidden cursor
};

const lightTheme = {
  background: "#ffffff",
  foreground: "#383a42",
  selectionBackground: "#b4d5fe",
  selectionForeground: "#000000",
  cursor: "#ffffff",
};

function getTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? darkTheme
    : lightTheme;
}

interface TaskLogTabProps {
  taskId: string;
  isVisible: boolean;
}

const TaskLogTab: React.FC<TaskLogTabProps> = ({ taskId, isVisible }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const offsetRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<string>("running");

  const fetchLog = useCallback(async () => {
    const xterm = xtermRef.current;
    if (!xterm) return;

    try {
      const result = await getRpcClient().query("task.getLog", {
        taskId,
        offset: offsetRef.current,
      });

      if (result.content) {
        xterm.write(result.content);
        offsetRef.current = result.size;
      }

      // Check task status
      const tasks = await getRpcClient().query("task.list", {});
      const task = tasks.find((t: any) => t.id === taskId);
      if (task) {
        setStatus(task.status);
        if (task.status !== "running" && pollRef.current) {
          // One final fetch, then stop polling
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch {
      // ignore
    }
  }, [taskId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new Terminal({
      theme: getTheme(),
      fontFamily: '"SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 10000,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Initial fetch
    fetchLog();

    // Poll for new output
    pollRef.current = setInterval(fetchLog, 2000);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onColorSchemeChange = () => {
      xterm.options.theme = getTheme();
    };
    colorSchemeQuery.addEventListener("change", onColorSchemeChange);

    return () => {
      colorSchemeQuery.removeEventListener("change", onColorSchemeChange);
      resizeObserver.disconnect();
      if (pollRef.current) clearInterval(pollRef.current);
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [taskId]);

  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [isVisible]);

  return (
    <div className="terminal-wrapper h-full w-full" ref={containerRef} />
  );
};

export default TaskLogTab;
