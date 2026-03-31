/**
 * React hooks for claude-session RPC client.
 * Mux-style: useSubscription for live data, useQuery for one-shot fetches.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getRpcClient } from "./rpc-client.js";
import type {
  QueryProcedure,
  SubscriptionProcedure,
  ProcedureInput,
  ProcedureOutput,
} from "../shared/protocol.js";

/**
 * Subscribe to a server-pushed data stream.
 * Automatically subscribes on mount, unsubscribes on unmount or input change.
 */
export function useSubscription<K extends SubscriptionProcedure>(
  procedure: K,
  input: ProcedureInput<K>
): { data: ProcedureOutput<K> | null; error: Error | null } {
  const [data, setData] = useState<ProcedureOutput<K> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    const client = getRpcClient();
    const unsubscribe = client.subscribe(
      procedure,
      (value) => {
        setData(value);
        setError(null);
      },
      input
    );

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procedure, inputKey]);

  return { data, error };
}

/**
 * One-shot query. Returns a trigger function and the result state.
 */
export function useQuery<K extends QueryProcedure>(
  procedure: K
): {
  query: (input: ProcedureInput<K>) => Promise<ProcedureOutput<K>>;
  data: ProcedureOutput<K> | null;
  loading: boolean;
  error: Error | null;
} {
  const [data, setData] = useState<ProcedureOutput<K> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const queryFn = useCallback(
    async (input: ProcedureInput<K>): Promise<ProcedureOutput<K>> => {
      setLoading(true);
      setError(null);
      try {
        const client = getRpcClient();
        const result = await client.query(procedure, input);
        setData(result);
        return result;
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [procedure]
  );

  return { query: queryFn, data, loading, error };
}

/**
 * Convenience: subscribe to session events for a specific session.
 */
export function useSessionEvents(sessionId: string | null) {
  return useSubscription("session.events", {
    sessionId: sessionId ?? "",
  });
}

/**
 * Convenience: accumulate session messages from events.
 * Handles both initial load (read-only) and live streaming.
 */
export function useSessionMessages(
  sessionId: string | null,
  opts?: { dir?: string }
) {
  const [messages, setMessages] = useState<
    import("../shared/protocol.js").SessionMessage[]
  >([]);
  const [status, setStatus] = useState<
    import("../shared/protocol.js").SessionStatus
  >("idle");
  const [permissionRequest, setPermissionRequest] = useState<
    import("../shared/protocol.js").PermissionRequest | null
  >(null);
  const [result, setResult] = useState<
    import("../shared/protocol.js").SessionResult | null
  >(null);

  const loadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);

  // Reset when session changes
  useEffect(() => {
    if (sessionId !== sessionIdRef.current) {
      sessionIdRef.current = sessionId;
      setMessages([]);
      setStatus("idle");
      setPermissionRequest(null);
      setResult(null);
      loadedRef.current = false;
    }
  }, [sessionId]);

  // Load historical messages
  useEffect(() => {
    if (!sessionId || loadedRef.current) return;
    loadedRef.current = true;

    const client = getRpcClient();
    client
      .query("session.messages", {
        sessionId,
        dir: opts?.dir,
      })
      .then((res) => {
        setMessages(res.messages);
      })
      .catch(() => {});
  }, [sessionId, opts?.dir]);

  // Subscribe to live events
  useEffect(() => {
    if (!sessionId) return;

    const client = getRpcClient();
    const unsubscribe = client.subscribe(
      "session.events",
      (event) => {
        switch (event.type) {
          case "message":
            setMessages((prev) => [...prev, event.message]);
            break;
          case "status":
            setStatus(event.status);
            break;
          case "permission_request":
            setPermissionRequest(event.request);
            break;
          case "permission_resolved":
            setPermissionRequest(null);
            break;
          case "result":
            setResult(event.result);
            break;
        }
      },
      { sessionId }
    );

    return unsubscribe;
  }, [sessionId]);

  return { messages, status, permissionRequest, result };
}
