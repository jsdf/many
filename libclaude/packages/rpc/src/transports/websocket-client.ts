import type { ClientTransport } from "../transport.ts";
import type { ClientMessage, ServerMessage } from "../wire.ts";

export interface WebSocketClientOptions {
  /** Reconnect delay in ms after an unexpected close. Default 1000. 0 disables. */
  reconnectDelayMs?: number;
}

/**
 * Browser/standard-WebSocket-backed {@link ClientTransport}. Auto-reconnects on
 * unexpected close; the {@link RpcClient} re-subscribes its live subscriptions
 * on each reopen. Modelled on the mux RPC client's reconnect behaviour.
 */
export class WebSocketClientTransport implements ClientTransport {
  private ws: WebSocket | null = null;
  private messageCb: ((msg: ServerMessage) => void) | null = null;
  private openCbs: (() => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly reconnectDelayMs: number;

  constructor(private readonly url: string, options: WebSocketClientOptions = {}) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      for (const cb of this.openCbs) cb();
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.messageCb?.(msg);
    };
    ws.onclose = () => {
      for (const cb of this.closeCbs) cb();
      if (this.closed || this.reconnectDelayMs <= 0) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(cb: (msg: ServerMessage) => void): void {
    this.messageCb = cb;
  }

  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
    if (this.ws?.readyState === WebSocket.OPEN) cb();
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
