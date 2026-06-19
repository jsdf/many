import React, { useEffect } from "react";

interface FileConflictModalProps {
  fileName: string;
  onKeepMine: () => void;
  onReloadDisk: () => void;
  onClose: () => void;
}

// Shown when a file changes on disk while it has unsaved edits in the editor.
// Forces an explicit choice so neither version is silently lost.
const FileConflictModal: React.FC<FileConflictModalProps> = ({ fileName, onKeepMine, onReloadDisk, onClose }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[2200]">
      <div className="bg-base-200 border border-base-300 rounded-xl" style={{ width: "90%", maxWidth: 480 }}>
        <div className="flex justify-between items-center p-4 border-b border-base-300">
          <h3 className="text-base font-semibold m-0">File changed on disk</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm">
            <span className="font-semibold">{fileName}</span> was modified on disk, but you have unsaved changes in
            the editor. How do you want to resolve this?
          </p>
        </div>
        <div className="flex justify-end gap-3 p-4 border-t border-base-300">
          <button type="button" className="btn btn-outline btn-neutral btn-sm" onClick={onReloadDisk}>
            Discard mine, reload from disk
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onKeepMine}>
            Keep my changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default FileConflictModal;
