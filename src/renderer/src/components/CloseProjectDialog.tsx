import React, { useEffect } from "react";

interface CloseProjectDialogProps {
  projectName: string;
  terminalCount: number;
  fileCount?: number;
  onConfirm: () => void;
  onClose: () => void;
}

// Confirms closing a project when doing so would kill running terminals.
// Open files autosave, so closing them is non-destructive; Claude sessions are
// left running.
const CloseProjectDialog: React.FC<CloseProjectDialogProps> = ({
  projectName,
  terminalCount,
  fileCount = 0,
  onConfirm,
  onClose,
}) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[2200]" onClick={onClose}>
      <div
        className="bg-base-200 border border-base-300 rounded-xl"
        style={{ width: "90%", maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-4 border-b border-base-300">
          <h3 className="text-base font-semibold m-0">Close project</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm">
            Close <span className="font-semibold">{projectName}</span>? This will kill{" "}
            {terminalCount} terminal{terminalCount === 1 ? "" : "s"}
            {fileCount > 0 ? ` and close ${fileCount} open file${fileCount === 1 ? "" : "s"}` : ""}.
          </p>
          <p className="text-xs text-base-content/60 mt-2">Claude sessions are left running.</p>
        </div>
        <div className="flex justify-end gap-3 p-4 border-t border-base-300">
          <button type="button" className="btn btn-neutral btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-error btn-sm" onClick={onConfirm}>
            Close project
          </button>
        </div>
      </div>
    </div>
  );
};

export default CloseProjectDialog;
