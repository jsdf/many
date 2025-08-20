import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export class TerminalSession {
  private xterm: XTerm;
  private fitAddon: FitAddon;
  private resizeObserver?: ResizeObserver;
  private cleanup?: () => void;
  private isConnected = false;
  private shouldAutoFocus = false;
  
  // Callbacks
  private onConnectionChange?: (connected: boolean) => void;
  private onTitleChange?: (title: string) => void;

  constructor(container: HTMLElement) {
    // Create xterm instance
    this.xterm = new XTerm({
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

    // Create and load addons
    this.fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.loadAddon(webLinksAddon);

    // Open terminal in container
    this.xterm.open(container);
    this.fitAddon.fit();

    // Set up resize handling
    this.setupResize(container);
  }

  private setupResize(container: HTMLElement) {
    const handleResize = () => {
      this.fitAddon.fit();
    };

    this.resizeObserver = new ResizeObserver(handleResize);
    this.resizeObserver.observe(container);

    // Also handle window resize
    window.addEventListener("resize", handleResize);
    
    // Store cleanup function
    const originalCleanup = this.cleanup;
    this.cleanup = () => {
      originalCleanup?.();
      this.resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }

  async connectToBackend(options: {
    terminalId: string;
    workingDirectory?: string;
    initialCommand?: string;
    worktreePath?: string;
    autoFocus?: boolean;
  }) {
    const { terminalId, workingDirectory, initialCommand, worktreePath, autoFocus = false } = options;
    
    // Store the autoFocus preference
    this.shouldAutoFocus = autoFocus;
    console.log(`Terminal ${terminalId} autoFocus:`, autoFocus);

    // Clean up existing connection
    this.cleanup?.();

    try {
      // Import tRPC client
      const { client } = await import("../main");
      
      // Request new terminal session from main process
      await client.createTerminalSession.mutate({
        terminalId,
        workingDirectory,
        cols: this.xterm.cols,
        rows: this.xterm.rows,
        initialCommand,
        worktreePath,
      });

      this.setConnected(true);

      // Set up IPC handlers
      const dataHandler = window.electronAPI.onTerminalData?.(
        terminalId,
        (data: string) => {
          try {
            this.xterm.write(data);
          } catch (error) {
            console.error("Error writing to terminal:", error);
          }
        }
      );

      const exitHandler = window.electronAPI.onTerminalExit?.(terminalId, () => {
        try {
          this.setConnected(false);
          this.xterm.write("\r\n[Terminal session ended]\r\n");
        } catch (error) {
          console.error("Error handling terminal exit:", error);
        }
      });

      const titleHandler = window.electronAPI.onTerminalTitle?.(
        terminalId,
        (title: string) => {
          try {
            this.onTitleChange?.(title);
          } catch (error) {
            console.error("Error handling title change:", error);
          }
        }
      );

      // Set up XTerm event handlers
      const dataDisposable = this.xterm.onData(async (data) => {
        try {
          await client.sendTerminalData.mutate({ terminalId, data });
        } catch (error) {
          console.error("Error sending terminal data:", error);
        }
      });

      const resizeDisposable = this.xterm.onResize(async ({ cols, rows }) => {
        try {
          await client.resizeTerminal.mutate({ terminalId, cols, rows });
        } catch (error) {
          console.error("Error resizing terminal:", error);
        }
      });

      // Set initial title
      this.onTitleChange?.(`Terminal ${terminalId.slice(-4)}`);

      // Store cleanup function
      this.cleanup = () => {
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
        this.xterm.write("\r\n[Failed to start terminal session]\r\n");
      } catch (writeError) {
        console.error("Error writing failure message:", writeError);
      }
      this.setConnected(false);
    }
  }

  setCallbacks(callbacks: {
    onConnectionChange?: (connected: boolean) => void;
    onTitleChange?: (title: string) => void;
  }) {
    this.onConnectionChange = callbacks.onConnectionChange;
    this.onTitleChange = callbacks.onTitleChange;
  }

  private setConnected(connected: boolean) {
    this.isConnected = connected;
    this.onConnectionChange?.(connected);
    
    // Auto-focus terminal when it connects if enabled
    if (connected && this.shouldAutoFocus) {
      console.log('Auto-focusing terminal');
      // Use a small delay to ensure the terminal is fully rendered
      setTimeout(() => {
        console.log('Calling xterm.focus()');
        this.xterm.focus();
      }, 100);
    }
  }

  getConnectionStatus() {
    return this.isConnected;
  }

  fit() {
    this.fitAddon.fit();
  }

  focus() {
    this.xterm.focus();
  }

  dispose() {
    this.cleanup?.();
    this.xterm.dispose();
  }
}