import React from "react";
import type { PermissionRequest } from "../../shared/protocol.js";

export function PermissionBanner({
  request,
  onRespond,
}: {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}) {
  // Pick a short preview of what the tool wants to do
  const preview =
    (request.toolInput as any).command ??
    (request.toolInput as any).file_path ??
    (request.toolInput as any).pattern ??
    "";
  const previewText =
    typeof preview === "string" && preview.length > 120
      ? preview.slice(0, 120) + "…"
      : String(preview);

  return (
    <div className="border-t border-warning/30 bg-warning/10 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-warning">⚠</span>
        <span className="font-medium">
          {request.displayName ?? request.toolName}
        </span>
        {request.description && (
          <span className="opacity-60 text-xs">{request.description}</span>
        )}
      </div>

      {previewText && (
        <pre className="text-xs bg-base-300 rounded p-2 max-h-24 overflow-auto font-mono">
          {previewText}
        </pre>
      )}

      <div className="flex gap-2">
        <button
          className="btn btn-sm btn-success"
          onClick={() => onRespond(true)}
        >
          Allow
        </button>
        <button
          className="btn btn-sm btn-error btn-outline"
          onClick={() => onRespond(false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
