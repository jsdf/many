import { useState, useEffect, useCallback } from "react";
import { getRpcClient } from "../rpc-client";
import type { ProjectNode } from "../types";
import type { ProjectMetadata } from "../../../shared/protocol";

export interface ProjectMetadataState {
  // Sidecar metadata for the current project, or null while it loads. Always
  // consistent with `project`: never the previous project's data during a
  // switch.
  meta: ProjectMetadata | null;
  loading: boolean;
  reload: () => void;
  // Refetches PR state from GitHub via `gh`, writes statuses back to prs.yml,
  // and updates `meta`. Resolves with the refresh outcome for user feedback.
  refreshPrs: () => Promise<{ refreshed: number; errors: string[] }>;
  refreshingPrs: boolean;
}

// Loads a project's sidecar metadata (PROJECT.md frontmatter, prs.yml,
// tasks.yml) and keeps it consistent with the selected project.
//
// The data is stored together with the project path it was loaded for, in a
// single state value, so it can never be read as belonging to a different
// project. `meta` derives to null whenever the loaded path doesn't match the
// current selection, which makes stale metadata from a previous project (still
// in flight during a switch) invisible to callers.
export function useProjectMetadata(project: ProjectNode | null): ProjectMetadataState {
  const [loaded, setLoaded] = useState<{ path: string; data: ProjectMetadata } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingPrs, setRefreshingPrs] = useState(false);

  const projectPath = project?.path ?? null;
  const meta = loaded && projectPath && loaded.path === projectPath ? loaded.data : null;

  const reload = useCallback(() => {
    if (!projectPath) {
      setLoaded(null);
      return;
    }
    setLoading(true);
    getRpcClient()
      .query("project.metadata", { projectPath })
      .then((result) => setLoaded({ path: projectPath, data: result }))
      .catch((err) => {
        console.error("Failed to load project metadata:", err);
        setLoaded((prev) => (prev?.path === projectPath ? null : prev));
      })
      .finally(() => setLoading(false));
  }, [projectPath]);

  const refreshPrs = useCallback(async () => {
    if (!projectPath) return { refreshed: 0, errors: [] };
    setRefreshingPrs(true);
    try {
      const result = await getRpcClient().query("project.refreshPrs", { projectPath });
      setLoaded({ path: projectPath, data: result.metadata });
      return { refreshed: result.refreshed, errors: result.errors };
    } finally {
      setRefreshingPrs(false);
    }
  }, [projectPath]);

  // Reload when the selected project changes. No manual clearing needed: `meta`
  // already reads as null for any project whose metadata hasn't loaded yet.
  useEffect(() => {
    reload();
  }, [reload]);

  return { meta, loading, reload, refreshPrs, refreshingPrs };
}
