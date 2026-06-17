import React, { useEffect, useRef, useState } from "react";
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle, LanguageDescription } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { nord } from "@milkdown/theme-nord";
import PropertiesPanel from "./PropertiesPanel";
import { parseFrontmatter, serializeFrontmatter, PropertyValue } from "../frontmatter";

export interface FileData {
  content: string;
  saved: string;
  tooLarge: boolean;
  binary: boolean;
  error?: string;
  loaded: boolean;
  // Bumped when the on-disk content is adopted, forcing the (uncontrolled)
  // editor to remount and re-read the new content.
  version: number;
}

interface FileEditorTabProps {
  fileName: string;
  data: FileData;
  onChange: (content: string) => void;
  onSave: () => void;
}

function isMarkdownFile(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName);
}

// --- CodeMirror source editor (editable) ---
function CodeEditor({
  initialDoc,
  fileName,
  onChange,
  onSave,
}: {
  initialDoc: string;
  fileName: string;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef(initialDoc);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const languageConf = new Compartment();
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      languageConf.of([]),
    ];
    extensions.push(isDark ? oneDark : syntaxHighlighting(defaultHighlightStyle, { fallback: true }));

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: initialDocRef.current, extensions }),
    });

    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (desc) {
      desc.load().then((support) => {
        if (!cancelled) view.dispatch({ effects: languageConf.reconfigure(support) });
      });
    }

    return () => {
      cancelled = true;
      view.destroy();
    };
    // Mount once; the latest doc is re-read on remount (e.g. mode toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full overflow-hidden text-[13px]" />;
}

// --- Milkdown WYSIWYG editor ---
function MilkdownInner({
  initialMarkdown,
  onChange,
}: {
  initialMarkdown: string;
  onChange: (content: string) => void;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdown);
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => onChangeRef.current(markdown));
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      .use(listener)
  );

  return <Milkdown />;
}

function MarkdownEditor({
  initialMarkdown,
  onChange,
  onSave,
}: {
  initialMarkdown: string;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  // Split frontmatter from body once on mount; both editors are uncontrolled
  // (they read their initial value once), so we recombine via refs on change.
  const [parsed] = useState(() => parseFrontmatter(initialMarkdown));
  const propsRef = useRef<Record<string, PropertyValue>>(parsed.properties);
  const bodyRef = useRef<string>(parsed.body);

  const emit = () => onChange(serializeFrontmatter(propsRef.current, bodyRef.current));

  return (
    <div
      className="milkdown-host h-full overflow-auto"
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          onSave();
        }
      }}
    >
      <PropertiesPanel
        initialProperties={parsed.properties}
        onChange={(properties) => {
          propsRef.current = properties;
          emit();
        }}
      />
      <MilkdownProvider>
        <MilkdownInner
          initialMarkdown={parsed.body}
          onChange={(md) => {
            bodyRef.current = md;
            emit();
          }}
        />
      </MilkdownProvider>
    </div>
  );
}

const CodeIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);
const WysiwygIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="14" y2="17" />
  </svg>
);

const FileEditorTab: React.FC<FileEditorTabProps> = ({ fileName, data, onChange, onSave }) => {
  const markdown = isMarkdownFile(fileName);
  const [mode, setMode] = useState<"code" | "wysiwyg">(markdown ? "wysiwyg" : "code");

  if (data.error) {
    return <div className="p-4 text-sm text-error">Failed to read file: {data.error}</div>;
  }
  if (!data.loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }
  if (data.tooLarge) {
    return <div className="p-4 text-sm text-base-content/60">File is too large to edit.</div>;
  }
  if (data.binary) {
    return <div className="p-4 text-sm text-base-content/60">Binary file - cannot edit.</div>;
  }

  return (
    <div className="relative h-full">
      {markdown && (
        <div className="absolute top-2 right-2 z-10 join shadow-md">
          <button
            className={`join-item btn btn-xs ${mode === "wysiwyg" ? "btn-primary" : "btn-neutral"}`}
            title="WYSIWYG"
            onClick={() => setMode("wysiwyg")}
          >
            {WysiwygIcon}
          </button>
          <button
            className={`join-item btn btn-xs ${mode === "code" ? "btn-primary" : "btn-neutral"}`}
            title="Source"
            onClick={() => setMode("code")}
          >
            {CodeIcon}
          </button>
        </div>
      )}
      {markdown && mode === "wysiwyg" ? (
        <MarkdownEditor key="wysiwyg" initialMarkdown={data.content} onChange={onChange} onSave={onSave} />
      ) : (
        <CodeEditor key="code" initialDoc={data.content} fileName={fileName} onChange={onChange} onSave={onSave} />
      )}
    </div>
  );
};

export default FileEditorTab;
