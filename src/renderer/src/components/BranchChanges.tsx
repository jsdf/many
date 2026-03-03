import React, { useState, useEffect, useMemo } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { client } from "../main";

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

const FileDiffEntry: React.FC<{ patch: string; diffStyle: DiffStyle }> = ({ patch, diffStyle }) => {
  const [collapsed, setCollapsed] = useState(false);
  const filename = useMemo(() => getFilename(patch), [patch]);

  return (
    <div className="file-diff-entry">
      <div
        className="file-diff-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span>{collapsed ? "▶" : "▼"} {filename}</span>
      </div>
      {!collapsed && (
        <div className="file-diff-body">
          <PatchDiff
            patch={patch}
            options={{
              theme: "github-dark",
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
      <div className="branch-changes-content">
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="branch-changes-content">
        <p className="text-error">{error}</p>
      </div>
    );
  }

  if (filePatches.length === 0) {
    return (
      <div className="branch-changes-content">
        <p style={{ margin: 0, color: "#8c8c8c", fontStyle: "italic" }}>
          No changes on this branch
        </p>
      </div>
    );
  }

  return (
    <div className="branch-changes-content">
      <div className="branch-changes-diff">
        {filePatches.map((filePatch, i) => (
          <FileDiffEntry key={i} patch={filePatch} diffStyle={diffStyle} />
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
    <div className="branch-changes">
      <div className="branch-changes-header">
        <h3 onClick={toggleCollapsed} style={{ cursor: "pointer" }}>
          {collapsed ? "▶" : "▼"} Branch Changes
        </h3>
        {!collapsed && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className="btn btn-secondary"
              onClick={toggleDiffStyle}
              title={`Switch to ${diffStyle === "unified" ? "split" : "unified"} view`}
            >
              {diffStyle === "unified" ? "Split" : "Unified"}
            </button>
            <button
              className="btn btn-secondary"
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
