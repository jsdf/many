import React, { useState, useEffect, useMemo, useSyncExternalStore } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { client } from "../main";

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

const FileDiffEntry: React.FC<{ patch: string; diffStyle: DiffStyle; defaultCollapsed?: boolean }> = ({ patch, diffStyle, defaultCollapsed = false }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const filename = useMemo(() => getFilename(patch), [patch]);
  const isDark = useDarkMode();

  return (
    <div className="border border-base-300 rounded overflow-hidden">
      <div
        className="px-2.5 py-1.5 bg-base-300 cursor-pointer select-none font-mono text-sm text-base-content/80 hover:bg-base-300/80"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span>{collapsed ? "▶" : "▼"} {filename}</span>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto">
          <PatchDiff
            patch={patch}
            options={{
              theme: isDark ? "github-dark" : "github-light",
              diffStyle,
            }}
          />
        </div>
      )}
    </div>
  );
};

interface BranchDiffContentProps {
  worktreePath: string;
  repoPath: string;
  refreshKey: number;
}

const BranchDiffContent: React.FC<BranchDiffContentProps & { diffStyle: DiffStyle }> = ({
  worktreePath,
  repoPath,
  refreshKey,
  diffStyle,
}) => {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filePatches = useMemo(() => (diff ? splitPatch(diff) : []), [diff]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.getBranchDiff
      .query({ worktreePath, repoPath })
      .then((result) => {
        if (!cancelled) setDiff(result.diff);
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
  }, [worktreePath, repoPath, refreshKey]);

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
          <FileDiffEntry key={i} patch={filePatch} diffStyle={diffStyle} defaultCollapsed={filePatches.length > 10} />
        ))}
      </div>
    </div>
  );
};

interface BranchChangesProps {
  worktreePath: string;
  repoPath: string;
}

const BranchChanges: React.FC<BranchChangesProps> = ({
  worktreePath,
  repoPath,
}) => {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem("branchChangesCollapsed");
    return stored !== null ? stored === "true" : true;
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
        <h3 className="text-base font-semibold cursor-pointer select-none" onClick={toggleCollapsed}>
          {collapsed ? "▶" : "▼"} Branch Changes
        </h3>
        {!collapsed && (
          <div className="flex gap-2">
            <button
              className="btn btn-soft btn-neutral btn-sm"
              onClick={toggleDiffStyle}
              title={`Switch to ${diffStyle === "unified" ? "split" : "unified"} view`}
            >
              {diffStyle === "unified" ? "Split" : "Unified"}
            </button>
            <button
              className="btn btn-soft btn-neutral btn-sm"
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
          diffStyle={diffStyle}
        />
      )}
    </div>
  );
};

export default BranchChanges;
