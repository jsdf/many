import React, { useState, useEffect, useMemo, useSyncExternalStore } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { getRpcClient } from "../rpc-client";
import { ChevronRight, ChevronDown } from "lucide-react";

function useDarkMode(): boolean {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  return useSyncExternalStore(
    (cb) => { query.addEventListener("change", cb); return () => query.removeEventListener("change", cb); },
    () => query.matches,
  );
}

/** Split a multi-file unified diff into individual file patches */
function splitPatch(patch: string): string[] {
  const files: string[] = [];
  const lines = patch.split("\n");
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      files.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0 && current.some((l) => l.startsWith("diff --git "))) {
    files.push(current.join("\n"));
  }

  return files;
}

/** Extract filename from a single-file patch */
function getFilename(patch: string): string {
  const match = patch.match(/^diff --git a\/(.+?) b\//m);
  return match ? match[1] : "unknown";
}

type DiffStyle = "unified" | "split";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-xs btn-ghost btn-neutral opacity-0 group-hover/file:opacity-100 transition-opacity"
      title={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

const FILE_PATCH_MAX_LINES = 5000;

const FileDiffEntry: React.FC<{ patch: string; diffStyle: DiffStyle; defaultCollapsed?: boolean; worktreePath: string }> = ({ patch, diffStyle, defaultCollapsed = false, worktreePath }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const filename = useMemo(() => getFilename(patch), [patch]);
  const absPath = `${worktreePath}/${filename}`;
  const isDark = useDarkMode();

  const { displayPatch, patchTruncated } = useMemo(() => {
    const lines = patch.split("\n");
    if (lines.length <= FILE_PATCH_MAX_LINES) return { displayPatch: patch, patchTruncated: false };
    return { displayPatch: lines.slice(0, FILE_PATCH_MAX_LINES).join("\n"), patchTruncated: true };
  }, [patch]);

  return (
    <div className="border border-base-300 rounded overflow-hidden group/file">
      <div
        className="px-2.5 py-1.5 bg-base-300 cursor-pointer select-none font-mono text-sm text-base-content/80 hover:bg-base-300/80 flex items-center gap-2"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="flex-1 min-w-0 truncate inline-flex items-center gap-1">{collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />} <span className="truncate">{filename}</span></span>
        <span className="flex-shrink-0 flex gap-1" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={filename} label="rel" />
          <CopyButton text={absPath} label="abs" />
          <button
            className="btn btn-xs btn-ghost btn-neutral opacity-0 group-hover/file:opacity-100 transition-opacity"
            title="Open in editor"
            onClick={() => {
              getRpcClient().query("action.openEditor", { path: absPath })
                .catch((err) => console.error("[action] openEditor failed:", err));
            }}
          >
            Open
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto">
          <PatchDiff
            patch={displayPatch}
            options={{
              theme: isDark ? "github-dark" : "github-light",
              diffStyle,
            }}
          />
          {patchTruncated && (
            <div className="text-warning text-xs p-2 bg-warning/10">
              Diff truncated - file has too many changed lines to display.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface BranchDiffContentProps {
  worktreePath: string;
  repoPath: string;
  refreshKey: number;
  commit?: string;
}

const BranchDiffContent: React.FC<BranchDiffContentProps & { diffStyle: DiffStyle }> = ({
  worktreePath,
  repoPath,
  refreshKey,
  commit,
  diffStyle,
}) => {
  const [diff, setDiff] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filePatches = useMemo(() => (diff ? splitPatch(diff) : []), [diff]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRpcClient().query("worktree.branchDiff", { worktreePath, repoPath })
      .then((result) => {
        if (!cancelled) {
          setDiff(result.diff);
          setTruncated(result.truncated ?? false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load branch diff:", err);
          setError(err instanceof Error ? err.message : "Failed to load diff");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, repoPath, refreshKey, commit]);

  if (loading && !diff) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-lg p-4">
        <p className="text-base-content/60 italic m-0">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-lg p-4">
        <p className="text-error m-0">{error}</p>
      </div>
    );
  }

  if (filePatches.length === 0) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-lg p-4">
        <p className="text-base-content/60 italic m-0">No changes on this branch</p>
      </div>
    );
  }

  return (
    <div className="bg-base-200 border border-base-300 rounded-lg p-4 overflow-hidden w-full max-w-full">
      <div className="text-sm overflow-hidden flex flex-col gap-2">
        {filePatches.map((filePatch, i) => (
          <FileDiffEntry key={i} patch={filePatch} diffStyle={diffStyle} defaultCollapsed={filePatches.length > 10} worktreePath={worktreePath} />
        ))}
        {truncated && (
          <div className="text-warning text-xs p-2 bg-warning/10 rounded">
            Output truncated - diff is too large to display in full.
          </div>
        )}
      </div>
    </div>
  );
};

interface BranchChangesProps {
  worktreePath: string;
  repoPath: string;
  /** Current commit hash - when this changes, the diff is re-fetched */
  commit?: string;
}

const BranchChanges: React.FC<BranchChangesProps> = ({
  worktreePath,
  repoPath,
  commit,
}) => {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem("branchChangesCollapsed");
    return stored !== null ? stored === "true" : false;
  });
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() => {
    return (localStorage.getItem("diffStyle") as DiffStyle) || "unified";
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("branchChangesCollapsed", String(next));
  };

  const toggleDiffStyle = () => {
    const next: DiffStyle = diffStyle === "unified" ? "split" : "unified";
    setDiffStyle(next);
    localStorage.setItem("diffStyle", next);
  };

  return (
    <div className="mt-5 w-full min-w-0">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-base font-semibold cursor-pointer select-none inline-flex items-center gap-1" onClick={toggleCollapsed}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} Branch Changes
        </h3>
        {!collapsed && (
          <div className="flex gap-2">
            <button
              className="btn btn-outline btn-neutral btn-sm"
              onClick={toggleDiffStyle}
              title={`Switch to ${diffStyle === "unified" ? "split" : "unified"} view`}
            >
              {diffStyle === "unified" ? "Split" : "Unified"}
            </button>
            <button
              className="btn btn-outline btn-neutral btn-sm"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              Refresh
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <BranchDiffContent
          worktreePath={worktreePath}
          repoPath={repoPath}
          refreshKey={refreshKey}
          commit={commit}
          diffStyle={diffStyle}
        />
      )}
    </div>
  );
};

export default BranchChanges;
