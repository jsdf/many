/**
 * React hooks for the unified RPC client.
 * useSubscription for live data, useQuery for one-shot fetches.
 */

import { useState, useEffect, useCallback } from "react";
import { getRpcClient } from "./rpc-client";
import type {
  QueryProcedure,
  SubscriptionProcedure,
  ProcedureInput,
  ProcedureOutput,
} from "../../shared/protocol";

/**
 * Subscribe to a server-pushed data stream.
 * Auto-subscribes on mount, unsubscribes on unmount or input change.
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
 * Subscribe to live worktree updates for a repository.
 * Drop-in replacement for the old useWorktreeSubscription hook.
 */
export function useWorktreeSubscription(repoPath: string | null) {
  const [data, setData] = useState<ProcedureOutput<"worktree.updates"> | null>(null);

  useEffect(() => {
    if (!repoPath) {
      setData(null);
      return;
    }

    const client = getRpcClient();
    const unsubscribe = client.subscribe(
      "worktree.updates",
      (value) => setData(value),
      { repoPath }
    );

    return unsubscribe;
  }, [repoPath]);

  return data;
}
