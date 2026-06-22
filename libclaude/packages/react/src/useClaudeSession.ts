import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient, Procedures, SessionStatus, ClaudeEvent, TurnResult } from "@libclaude/rpc";

export interface TurnRecord {
  /** Monotonic local id for the turn. */
  id: number;
  prompt: string;
  events: ClaudeEvent[];
  result: TurnResult | null;
  running: boolean;
}

export interface UseClaudeSession {
  status: SessionStatus | null;
  turns: TurnRecord[];
  /** True while a turn is streaming. */
  busy: boolean;
  sendPrompt: (prompt: string) => void;
  reset: () => Promise<void>;
  interrupt: () => Promise<void>;
}

/**
 * React binding over an {@link RpcClient} speaking the libclaude {@link Procedures}.
 * Subscribes to live status and exposes a turn log that streams events as the
 * agent works. Transport-agnostic — pass any client (WebSocket, in-process, ...).
 */
export function useClaudeSession(rpc: RpcClient<Procedures>): UseClaudeSession {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const nextId = useRef(1);
  const activeUnsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsub = rpc.subscribe("status", setStatus);
    return () => unsub();
  }, [rpc]);

  const patchTurn = useCallback((id: number, patch: (t: TurnRecord) => TurnRecord) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? patch(t) : t)));
  }, []);

  const sendPrompt = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const id = nextId.current++;
      setTurns((prev) => [...prev, { id, prompt: trimmed, events: [], result: null, running: true }]);

      const unsub = rpc.subscribe(
        "turn",
        (update) => {
          if (update.kind === "event") {
            patchTurn(id, (t) => ({ ...t, events: [...t.events, update.event] }));
          } else {
            patchTurn(id, (t) => ({ ...t, result: update.result, running: false }));
            activeUnsub.current?.();
            activeUnsub.current = null;
          }
        },
        { prompt: trimmed },
      );
      activeUnsub.current = unsub;
    },
    [rpc, patchTurn],
  );

  const reset = useCallback(async () => {
    activeUnsub.current?.();
    activeUnsub.current = null;
    await rpc.query("reset");
    setTurns([]);
  }, [rpc]);

  const interrupt = useCallback(async () => {
    await rpc.query("interrupt");
  }, [rpc]);

  return {
    status,
    turns,
    busy: turns.some((t) => t.running),
    sendPrompt,
    reset,
    interrupt,
  };
}
