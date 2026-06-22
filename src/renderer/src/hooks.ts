import { useState, useEffect } from "react";
import type { SubscriptionProcedure, ProcedureInput, ProcedureOutput } from "../../shared/protocol";
import { getRpcClient } from "./rpc-client";

/**
 * Subscribe to a live-updating resource.
 * Returns the latest data pushed by the server, updating automatically on change.
 * Returns null until the first push arrives.
 */
export function useSubscription<K extends SubscriptionProcedure>(
  procedure: K,
  input: ProcedureInput<K>
): { data: ProcedureOutput<K> | null } {
  const [data, setData] = useState<ProcedureOutput<K> | null>(null);
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    setData(null);
    const unsub = getRpcClient().subscribe(procedure, (d) => setData(d), input as ProcedureInput<K>);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procedure, inputKey]);

  return { data };
}
