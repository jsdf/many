// WebSocket subscription hook for push-based reactive updates.
// Connects to /ws/subscribe and provides live data from the server.

import { useState, useEffect, useRef, useCallback } from "react";

const token = new URLSearchParams(window.location.search).get("token") ?? "";

function getSubscribeUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/subscribe?token=${encodeURIComponent(token)}`;
}

type MessageHandler = (data: any) => void;

// Singleton WebSocket connection shared across all subscriptions
let sharedWs: WebSocket | null = null;
let wsConnecting = false;
const handlers = new Map<string, Set<MessageHandler>>();
const subscriptions = new Set<string>(); // JSON-encoded subscription keys
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getWs(): WebSocket {
  if (sharedWs && sharedWs.readyState === WebSocket.OPEN) return sharedWs;
  if (wsConnecting && sharedWs) return sharedWs;

  wsConnecting = true;
  const ws = new WebSocket(getSubscribeUrl());
  sharedWs = ws;

  ws.onopen = () => {
    wsConnecting = false;
    // Re-subscribe all active subscriptions
    for (const key of subscriptions) {
      const parsed = JSON.parse(key);
      ws.send(JSON.stringify(parsed));
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Route to handlers by type+repoPath
      const handlerKey = `${msg.type}:${msg.repoPath || ""}`;
      const fns = handlers.get(handlerKey);
      if (fns) {
        for (const fn of fns) fn(msg.data);
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    wsConnecting = false;
    sharedWs = null;
    // Reconnect after a delay if there are active subscriptions
    if (subscriptions.size > 0) {
      reconnectTimer = setTimeout(() => {
        if (subscriptions.size > 0) getWs();
      }, 2000);
    }
  };

  ws.onerror = () => {
    // onclose will fire after this
  };

  return ws;
}

function subscribe(
  procedure: string,
  repoPath: string,
  handler: MessageHandler
): () => void {
  const subMsg = { type: "subscribe", procedure, repoPath };
  const key = JSON.stringify(subMsg);
  const handlerKey = `${procedure}:${repoPath}`;

  // Register handler
  if (!handlers.has(handlerKey)) {
    handlers.set(handlerKey, new Set());
  }
  handlers.get(handlerKey)!.add(handler);

  // Track subscription
  subscriptions.add(key);

  // Send subscribe message
  const ws = getWs();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(subMsg));
  }
  // Otherwise onopen will re-subscribe

  return () => {
    // Unregister handler
    const fns = handlers.get(handlerKey);
    if (fns) {
      fns.delete(handler);
      if (fns.size === 0) handlers.delete(handlerKey);
    }

    // Only unsubscribe from server if no more handlers
    if (!handlers.has(handlerKey)) {
      subscriptions.delete(key);
      if (sharedWs && sharedWs.readyState === WebSocket.OPEN) {
        sharedWs.send(JSON.stringify({ type: "unsubscribe", procedure, repoPath }));
      }
    }

    // Close shared WS if no subscriptions remain
    if (subscriptions.size === 0 && reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
}

/**
 * Subscribe to live worktree updates for a repository.
 * Returns the latest worktree list, updated automatically when git state changes.
 */
export function useWorktreeSubscription(repoPath: string | null) {
  const [data, setData] = useState<any[] | null>(null);

  useEffect(() => {
    if (!repoPath) {
      setData(null);
      return;
    }

    const unsub = subscribe("worktrees", repoPath, (worktrees) => {
      setData(worktrees);
    });

    return unsub;
  }, [repoPath]);

  return data;
}
