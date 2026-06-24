import React, { useEffect, useRef, useState } from "react";
import { Fzf } from "fzf";
import { getRpcClient } from "../rpc-client";

// Shared building blocks for the file quick-open palettes (projects + worktree):
// loading the flat file list, fuzzy ranking with contextual tiers, and
// match highlighting.

export const baseName = (p: string) =>
  p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

export const dirName = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
};

// A root directory whose files feed the palette (a project node or a worktree).
export interface PaletteRoot {
  path: string;
  label: string; // shown as the per-file prefix / origin (project or worktree name)
}

export interface PaletteFile {
  rel: string; // path relative to its root
  name: string; // basename
  abs: string; // absolute path
  rootPath: string;
  rootLabel: string;
  dir: string; // absolute directory, for tier matching
}

// Loads the flat file list for each root (via fs.allFiles) when `enabled`, and
// caches it across opens, refetching only when the root set changes. fzf then
// matches in-memory, so there's no per-keystroke RPC.
export function usePaletteFiles(
  roots: PaletteRoot[],
  enabled: boolean,
): { files: PaletteFile[] | null; loading: boolean } {
  const [files, setFiles] = useState<PaletteFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const key = roots.map((r) => r.path).join("|");
    if (loadedKeyRef.current === key && files) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const perRoot = await Promise.all(
          roots.map((r) =>
            getRpcClient().query("fs.allFiles", { dirPath: r.path }).then((rels) => ({ r, rels })),
          ),
        );
        if (cancelled) return;
        const out: PaletteFile[] = [];
        for (const { r, rels } of perRoot) {
          const sep = r.path.includes("\\") ? "\\" : "/";
          for (const rel of rels) {
            const abs = r.path + sep + rel;
            out.push({ rel, name: baseName(rel), abs, rootPath: r.path, rootLabel: r.label, dir: dirName(abs) });
          }
        }
        setFiles(out);
        loadedKeyRef.current = key;
      } catch (err) {
        if (!cancelled) {
          console.error("[palette] failed to load file list:", err);
          setFiles([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, roots, files]);

  return { files, loading };
}

// A contextual priority band. Files matching earlier boosts rank above later
// ones (e.g. files in the focused file's directory, then files under the
// selected directory), with all other files falling through to the lowest band.
export interface Boost {
  dir: string;
  mode: "exactDir" | "subtree";
}

const isUnder = (abs: string, dir: string) =>
  abs === dir || abs.startsWith(dir + "/") || abs.startsWith(dir + "\\");

export function fileTier(file: PaletteFile, boosts: Boost[]): number {
  for (let i = 0; i < boosts.length; i++) {
    const b = boosts[i];
    const hit = b.mode === "exactDir" ? file.dir === b.dir : isUnder(file.abs, b.dir);
    if (hit) return i;
  }
  return boosts.length;
}

export interface RankedFile {
  file: PaletteFile;
  positions: Set<number>;
}

// Fuzzy-match (or list, when query is empty) then order by contextual tier.
// Array.sort is stable, so within a tier fzf's score order (or the original
// file order for an empty query) is preserved.
export function rankFiles(
  query: string,
  files: PaletteFile[],
  fzf: Fzf<PaletteFile[]>,
  boosts: Boost[],
  limit: number,
): RankedFile[] {
  const matched: RankedFile[] = query
    ? fzf.find(query).map((r) => ({ file: r.item, positions: r.positions }))
    : files.map((file) => ({ file, positions: new Set<number>() }));
  const withTier = matched.map((r) => ({ r, tier: fileTier(r.file, boosts) }));
  withTier.sort((a, b) => a.tier - b.tier);
  return withTier.slice(0, limit).map((x) => x.r);
}

// Render text with the fzf-matched character positions emphasized.
export function highlight(text: string, positions: Set<number>): React.ReactNode {
  if (positions.size === 0) return text;
  const parts: React.ReactNode[] = [];
  let run = "";
  let runHi = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(
      runHi ? (
        <span key={key} className="text-primary font-semibold">{run}</span>
      ) : (
        <span key={key}>{run}</span>
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hi = positions.has(i);
    if (hi !== runHi) {
      flush(i);
      runHi = hi;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}
