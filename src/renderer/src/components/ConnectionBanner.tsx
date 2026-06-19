import { WifiOff } from "lucide-react";

/**
 * Full-width banner shown at the top of the app when the WebSocket RPC
 * connection to the backend is down. The client reconnects automatically,
 * so this just informs the user that data may be stale.
 */
export function ConnectionBanner({ connected }: { connected: boolean }) {
  if (connected) return null;

  return (
    <div role="alert" className="alert alert-error rounded-none shrink-0 py-2">
      <WifiOff size={16} />
      <span>Lost connection to the backend. Reconnecting...</span>
    </div>
  );
}
