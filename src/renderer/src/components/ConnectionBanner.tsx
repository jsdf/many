import { WifiOff, ShieldAlert } from "lucide-react";
import type { ConnectionStatus } from "../rpc-client";

/**
 * Full-width banner shown at the top of the app when the WebSocket RPC
 * connection to the backend is not usable. The acid theme's error-content is
 * dark, so we force light text for legible contrast on the red background.
 */
export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status === "connected") return null;

  const { Icon, message } =
    status === "unauthorized"
      ? {
          Icon: ShieldAlert,
          message: "Not authorized. Reopen the app from the link with a valid access token.",
        }
      : {
          Icon: WifiOff,
          message: "Lost connection to the backend. Reconnecting...",
        };

  return (
    <div role="alert" className="alert alert-error text-white rounded-none shrink-0 py-2">
      <Icon size={16} />
      <span>{message}</span>
    </div>
  );
}
