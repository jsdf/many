import React, { useEffect, useState } from "react";
import { getRpcClient } from "../rpc-client";

export type FsAction =
  | { mode: "newFile"; dirPath: string }
  | { mode: "newFolder"; dirPath: string }
  | { mode: "rename"; targetPath: string; currentName: string; isDirectory: boolean }
  | { mode: "delete"; targetPath: string; name: string; isDirectory: boolean };

interface FsActionDialogProps {
  action: FsAction;
  onClose: () => void;
  // Called with a directory path that should be expanded so the result is
  // visible (e.g. the parent of a newly created entry).
  onReveal: (dirPath: string) => void;
}

function parentDir(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const i = p.lastIndexOf(sep);
  return i > 0 ? p.slice(0, i) : p;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

const TITLES: Record<FsAction["mode"], string> = {
  newFile: "New File",
  newFolder: "New Folder",
  rename: "Rename",
  delete: "Delete",
};

const FsActionDialog: React.FC<FsActionDialogProps> = ({ action, onClose, onReveal }) => {
  const isDelete = action.mode === "delete";
  const [name, setName] = useState(action.mode === "rename" ? action.currentName : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    const client = getRpcClient();
    const trimmed = name.trim();
    if (!isDelete && !trimmed) {
      setError("Please enter a name");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      switch (action.mode) {
        case "newFile":
          await client.query("fs.createFile", { filePath: joinPath(action.dirPath, trimmed) });
          onReveal(action.dirPath);
          break;
        case "newFolder":
          await client.query("fs.createDir", { dirPath: joinPath(action.dirPath, trimmed) });
          onReveal(action.dirPath);
          break;
        case "rename": {
          const dir = parentDir(action.targetPath);
          await client.query("fs.rename", { oldPath: action.targetPath, newPath: joinPath(dir, trimmed) });
          break;
        }
        case "delete":
          await client.query("fs.delete", { path: action.targetPath });
          break;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[2100]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl" style={{ width: "90%", maxWidth: 440 }}>
        <div className="flex justify-between items-center p-4 border-b border-base-300">
          <h3 className="text-base font-semibold m-0">{TITLES[action.mode]}</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-4">
            {isDelete ? (
              <p className="text-sm">
                Delete {action.isDirectory ? "folder" : "file"} <span className="font-semibold">{action.name}</span>
                {action.isDirectory ? " and all its contents" : ""}? This cannot be undone.
              </p>
            ) : (
              <input
                type="text"
                className="input input-bordered w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={action.mode === "newFolder" ? "folder name" : "file name"}
                autoFocus
                disabled={busy}
              />
            )}
            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>
          <div className="flex justify-end gap-3 p-4 border-t border-base-300">
            <button type="button" className="btn btn-outline btn-neutral btn-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn btn-sm ${isDelete ? "btn-error" : "btn-primary"}`}
              disabled={busy || (!isDelete && !name.trim())}
            >
              {busy ? "Working..." : isDelete ? "Delete" : "OK"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default FsActionDialog;
