import { contextBridge, ipcRenderer } from "electron";

// Helper function to log from preload to main process
function preloadLog(message: string, data?: any) {
  try {
    const logMessage = data ? `${message} ${JSON.stringify(data)}` : message;
    ipcRenderer.invoke('log-renderer-error', logMessage, 'PRELOAD_LOG');
  } catch (e) {
    // Silent fallback if logging fails
  }
}

preloadLog("=== Preload script starting ===");

// Manual implementation of electronTRPC bridge for tRPC v10
contextBridge.exposeInMainWorld("electronTRPC", {
  sendMessage: (data: any) => {
    preloadLog("=== electronTRPC sendMessage ===", data);
    ipcRenderer.send('electron-trpc', data);
  },
  onMessage: (callback: (data: any) => void) => {
    preloadLog("=== electronTRPC onMessage setup ===");
    ipcRenderer.on('electron-trpc', (_event, data) => {
      preloadLog("=== electronTRPC received message ===", data);
      callback(data);
    });
  },
});

preloadLog("=== electronTRPC bridge exposed ===");

contextBridge.exposeInMainWorld("electronAPI", {
  // Terminal event listeners - must stay as IPC for real-time data streams
  onTerminalData: (terminalId: string, callback: (data: string) => void) => {
    const channel = `terminal-data-${terminalId}`;
    const handler = (_event: any, data: string) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onTerminalExit: (terminalId: string, callback: () => void) => {
    const channel = `terminal-exit-${terminalId}`;
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onTerminalTitle: (terminalId: string, callback: (title: string) => void) => {
    const channel = `terminal-title-${terminalId}`;
    const handler = (_event: any, title: string) => callback(title);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Logging API
  logRendererError: (error: any, source: string) =>
    ipcRenderer.invoke("log-renderer-error", error, source),
});
