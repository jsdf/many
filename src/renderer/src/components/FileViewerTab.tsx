import React, { useEffect, useRef, useState } from "react";
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { getRpcClient } from "../rpc-client";

interface FileViewerTabProps {
  filePath: string;
  fileName: string;
}

interface FileState {
  content: string;
  tooLarge: boolean;
  binary: boolean;
  size: number;
}

const FileViewerTab: React.FC<FileViewerTabProps> = ({ filePath, fileName }) => {
  const [state, setState] = useState<FileState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Load file contents whenever the path changes
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    getRpcClient()
      .query("fs.readFile", { filePath })
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // (Re)build the read-only editor when content arrives
  useEffect(() => {
    if (!state || state.tooLarge || state.binary || !containerRef.current) return;
    let cancelled = false;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const languageConf = new Compartment();
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      languageConf.of([]),
    ];
    if (isDark) {
      extensions.push(oneDark);
    } else {
      extensions.push(syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
    }

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: state.content, extensions }),
    });
    viewRef.current = view;

    // Lazily load and apply the matching language for syntax highlighting
    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (desc) {
      desc.load().then((support) => {
        if (!cancelled && viewRef.current) {
          viewRef.current.dispatch({ effects: languageConf.reconfigure(support) });
        }
      });
    }

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
  }, [state, fileName]);

  if (error) {
    return <div className="p-4 text-sm text-error">Failed to read file: {error}</div>;
  }
  if (!state) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }
  if (state.tooLarge) {
    return (
      <div className="p-4 text-sm text-base-content/60">
        File is too large to preview ({(state.size / 1024).toFixed(0)} KB).
      </div>
    );
  }
  if (state.binary) {
    return <div className="p-4 text-sm text-base-content/60">Binary file - cannot preview.</div>;
  }
  return <div ref={containerRef} className="h-full overflow-hidden text-[13px]" />;
};

export default FileViewerTab;
