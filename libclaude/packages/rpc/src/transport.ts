import type { ClientMessage, ServerMessage } from "./wire.ts";

/**
 * Pluggable client-side transport. The {@link RpcClient} talks to the server
 * exclusively through this interface, so any duplex channel (WebSocket, postMessage,
 * an in-process pipe for tests, etc.) can back it. A WebSocket implementation
 * ships in `./transports/websocket-client.ts`.
 */
export interface ClientTransport {
  /** Send a framed client message. No-op if the channel is not open. */
  send(msg: ClientMessage): void;
  /** Register the handler for inbound server messages. */
  onMessage(cb: (msg: ServerMessage) => void): void;
  /** Fires whenever the channel (re)opens. */
  onOpen(cb: () => void): void;
  /** Fires whenever the channel closes (before any reconnect). */
  onClose(cb: () => void): void;
  /** True when messages can be sent right now. */
  isOpen(): boolean;
  /** Tear down the channel permanently. */
  close(): void;
}

/** One accepted connection on the server side. */
export interface ServerConnection {
  send(msg: ServerMessage): void;
  onMessage(cb: (msg: ClientMessage) => void): void;
  onClose(cb: () => void): void;
}

/**
 * Pluggable server-side transport. The {@link RpcServer} subscribes to incoming
 * connections through this interface. A `ws`-backed implementation ships in
 * `./transports/websocket-server.ts`.
 */
export interface ServerTransport {
  onConnection(cb: (conn: ServerConnection) => void): void;
}
