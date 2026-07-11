import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle, LanguageDescription } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { search, setSearchQuery, SearchQuery, SearchCursor } from "@codemirror/search";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import Image from "@tiptap/extension-image";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import PropertiesPanel from "./PropertiesPanel";
import { parseFrontmatter, serializeFrontmatter, PropertyValue } from "../frontmatter";
import { urlLinker } from "../url-linker";
import { createDomFinder } from "../dom-find";

// Task lists are conventionally tight (no blank lines between checkboxes), but
// tiptap-markdown only teaches bulletList/orderedList about the `tight` attribute,
// so taskList serializes loose and inserts a blank line between every item. Add the
// attribute here so task lists round-trip tight, matching how TODO files are written.
const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-tight") !== "false",
        renderHTML: (attrs: { tight?: boolean }) => ({ "data-tight": attrs.tight ? "true" : "false" }),
      },
    };
  },
});

// GFM tables can only hold single-line cells, so collapse newlines and escape
// pipes to keep the cell from splitting the row on reparse.
function escapeTableCell(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\|/g, "\\|");
}

interface MdSerializerState {
  out: string;
  write(s: string): void;
  ensureNewLine(): void;
  renderInline(node: ProsemirrorNode): void;
  closeBlock(node: ProsemirrorNode): void;
}

// tiptap-markdown's built-in table serializer relies on prosemirror-markdown
// escaping pipes/newlines inside cells, but the installed prosemirror-markdown
// (1.13.4) does neither, so a literal "|" or a multi-line cell corrupts the
// table on save. Re-implement the GFM serializer here with explicit escaping,
// flattening all of a cell's blocks into one line (GFM has no multi-line cells).
const RoundtripTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MdSerializerState, node: ProsemirrorNode) {
          node.forEach((row, _rowOffset, rowIndex) => {
            state.write("| ");
            row.forEach((cell, _cellOffset, colIndex) => {
              if (colIndex) state.write(" | ");
              let firstBlock = true;
              cell.forEach((block) => {
                if (!block.textContent.trim()) return;
                if (!firstBlock) state.write(" ");
                const start = state.out.length;
                state.renderInline(block);
                state.out = state.out.slice(0, start) + escapeTableCell(state.out.slice(start));
                firstBlock = false;
              });
            });
            state.write(" |");
            state.ensureNewLine();
            if (rowIndex === 0) {
              const delimiter = Array.from({ length: row.childCount }, () => "---").join(" | ");
              state.write(`| ${delimiter} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// Uniform find-in-document controls implemented per editor mode (CodeMirror
// selection-based search vs. CSS Custom Highlight API for read-only DOM views).
export interface SearchHandle {
  setQuery(query: string, caseSensitive: boolean): void;
  next(): void;
  prev(): void;
  clear(): void;
}

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
  filePath: string;
  data: FileData;
  onChange: (content: string) => void;
  onSave: () => void;
}

function isMarkdownFile(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName);
}

type MediaKind = "image" | "video" | "audio";

function mediaKind(fileName: string): MediaKind | null {
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i.test(fileName)) return "image";
  if (/\.(mp4|m4v|webm|mov|ogv)$/i.test(fileName)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|oga|ogg)$/i.test(fileName)) return "audio";
  return null;
}

// Build a token-guarded URL to the server's /api/file endpoint. Mirrors how
// rpc-client.ts resolves the token from the page URL (falling back to "dev").
function fileApiUrl(filePath: string): string {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? (import.meta.env.DEV ? "dev" : "");
  return `/api/file?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`;
}

function dirname(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return i < 0 ? "" : filePath.slice(0, i);
}

// Collapse "." and ".." segments in a "/"-separated path, preserving a leading slash.
function normalizePath(p: string): string {
  const parts = p.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      if (out.length === 0 && part === "") out.push("");
      continue;
    }
    if (part === ".." && out.length && out[out.length - 1] !== "" && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

// Markdown image sources reference files relative to the .md file's directory.
// Resolve those to the token-guarded /api/file URL so the browser can load them,
// while leaving remote/data URLs untouched. The original src stays in the doc's
// attributes (only the rendered <img> is rewritten), so it round-trips to markdown.
function resolveImageSrc(src: string, baseDir: string): string {
  if (!src) return src;
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^data:/i.test(src)) return src;
  const absolute = src.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(src);
  const abs = absolute ? normalizePath(src) : normalizePath(`${baseDir}/${src}`);
  return fileApiUrl(abs);
}

function MediaViewer({ kind, filePath, fileName }: { kind: MediaKind; filePath: string; fileName: string }) {
  const src = fileApiUrl(filePath);
  return (
    <div className="flex items-center justify-center h-full overflow-auto bg-base-200 p-4">
      {kind === "image" ? (
        <img src={src} alt={fileName} className="max-w-full max-h-full object-contain" />
      ) : kind === "video" ? (
        <video src={src} controls className="max-w-full max-h-full" />
      ) : (
        <audio src={src} controls />
      )}
    </div>
  );
}

function isYamlFile(fileName: string): boolean {
  return /\.(yaml|yml)$/i.test(fileName);
}

// --- CodeMirror source editor (editable) ---
function CodeEditor({
  initialDoc,
  fileName,
  onChange,
  onSave,
  searchRef,
  onMatches,
}: {
  initialDoc: string;
  fileName: string;
  onChange: (content: string) => void;
  onSave: () => void;
  searchRef?: React.Ref<SearchHandle>;
  onMatches?: (count: number, index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialDocRef = useRef(initialDoc);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onMatchesRef = useRef(onMatches);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onMatchesRef.current = onMatches;

  const viewRef = useRef<EditorView | null>(null);
  const matchesRef = useRef<{ from: number; to: number }[]>([]);
  const currentRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const languageConf = new Compartment();
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      search({ top: true }),
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
    if (isYamlFile(fileName)) extensions.push(...urlLinker);

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: initialDocRef.current, extensions }),
    });
    viewRef.current = view;

    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (desc) {
      desc.load().then((support) => {
        if (!cancelled) view.dispatch({ effects: languageConf.reconfigure(support) });
      });
    }

    return () => {
      cancelled = true;
      viewRef.current = null;
      view.destroy();
    };
    // Mount once; the latest doc is re-read on remount (e.g. mode toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(searchRef, () => ({
    setQuery(query: string, caseSensitive: boolean) {
      const view = viewRef.current;
      if (!view) return;
      if (!query) {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
        matchesRef.current = [];
        currentRef.current = 0;
        onMatchesRef.current?.(0, 0);
        return;
      }
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, caseSensitive })) });
      const norm = caseSensitive ? undefined : (s: string) => s.toLowerCase();
      const q = caseSensitive ? query : query.toLowerCase();
      const cursor = new SearchCursor(view.state.doc, q, 0, view.state.doc.length, norm);
      const matches: { from: number; to: number }[] = [];
      while (!cursor.next().done) matches.push({ from: cursor.value.from, to: cursor.value.to });
      matchesRef.current = matches;
      const selFrom = view.state.selection.main.from;
      const firstAtOrAfter = matches.findIndex((m) => m.from >= selFrom);
      currentRef.current = firstAtOrAfter >= 0 ? firstAtOrAfter : 0;
      if (matches.length) {
        const m = matches[currentRef.current];
        view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      }
      onMatchesRef.current?.(matches.length, matches.length ? currentRef.current + 1 : 0);
    },
    next() {
      const view = viewRef.current;
      const matches = matchesRef.current;
      if (!view || !matches.length) return;
      currentRef.current = (currentRef.current + 1) % matches.length;
      const m = matches[currentRef.current];
      view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      onMatchesRef.current?.(matches.length, currentRef.current + 1);
    },
    prev() {
      const view = viewRef.current;
      const matches = matchesRef.current;
      if (!view || !matches.length) return;
      currentRef.current = (currentRef.current - 1 + matches.length) % matches.length;
      const m = matches[currentRef.current];
      view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      onMatchesRef.current?.(matches.length, currentRef.current + 1);
    },
    clear() {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      matchesRef.current = [];
      currentRef.current = 0;
      onMatchesRef.current?.(0, 0);
    },
  }), []);

  return <div ref={containerRef} className="h-full overflow-hidden text-[13px]" />;
}

// --- TipTap WYSIWYG editor ---
function ToolbarButton({
  label,
  title,
  active,
  disabled,
  onClick,
}: {
  label: React.ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={`btn btn-xs ${active ? "btn-primary" : "btn-ghost"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function TiptapEditor({
  initialMarkdown,
  baseDir,
  onChange,
}: {
  initialMarkdown: string;
  baseDir: string;
  onChange: (content: string) => void;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Rewrite the rendered <img src> to the token-guarded /api/file URL while
  // keeping the raw markdown path in the node's src attribute (so it serializes
  // back unchanged). baseDir is captured once at mount, matching the uncontrolled
  // editor's read-once model.
  const [ResolvedImage] = useState(() =>
    Image.extend({
      addAttributes() {
        const parent: Record<string, unknown> = this.parent?.() ?? {};
        return {
          ...parent,
          src: {
            ...(parent.src as object),
            renderHTML: (attrs: { src?: string }) =>
              attrs.src ? { src: resolveImageSrc(attrs.src, baseDir) } : {},
          },
        };
      },
      // Inline images live inside paragraphs, matching markdown semantics; the
      // default block image merges with the following paragraph on serialization.
    }).configure({ inline: true }),
  );

  // StarterKit bundles the UndoRedo (history) extension, so Cmd/Ctrl+Z works.
  // tiptap-markdown parses the initial markdown string and re-serializes on
  // every change via editor.storage.markdown.getMarkdown().
  const editor = useEditor({
    extensions: [
      StarterKit,
      TightTaskList,
      TaskItem.configure({ nested: true }),
      ResolvedImage,
      RoundtripTable,
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false }),
    ],
    content: initialMarkdown,
    onUpdate: ({ editor }) => {
      const markdown = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;
      onChangeRef.current(markdown.getMarkdown());
    },
  });

  const toolbarState = useEditorState({
    editor,
    selector: (ctx) => {
      const e = ctx.editor;
      if (!e) return null;
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        heading1: e.isActive("heading", { level: 1 }),
        heading2: e.isActive("heading", { level: 2 }),
        heading3: e.isActive("heading", { level: 3 }),
        paragraph: e.isActive("paragraph"),
        bulletList: e.isActive("bulletList"),
        orderedList: e.isActive("orderedList"),
        taskList: e.isActive("taskList"),
        blockquote: e.isActive("blockquote"),
        codeBlock: e.isActive("codeBlock"),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  return (
    <>
      {editor && (
        <BubbleMenu
          editor={editor}
          updateDelay={300}
          options={{ placement: "top", offset: 6 }}
          className="tiptap-toolbar flex flex-wrap gap-1 items-center max-w-md p-1 rounded-box border border-base-300 bg-base-100 shadow-lg"
        >
          <ToolbarButton label={<span className="font-bold">B</span>} title="Bold" active={toolbarState?.bold} onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton label={<span className="italic">I</span>} title="Italic" active={toolbarState?.italic} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton label={<span className="line-through">S</span>} title="Strikethrough" active={toolbarState?.strike} onClick={() => editor.chain().focus().toggleStrike().run()} />
          <ToolbarButton label="</>" title="Inline code" active={toolbarState?.code} onClick={() => editor.chain().focus().toggleCode().run()} />
          <div className="w-px h-4 bg-base-300 mx-1" />
          <ToolbarButton label="H1" title="Heading 1" active={toolbarState?.heading1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
          <ToolbarButton label="H2" title="Heading 2" active={toolbarState?.heading2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <ToolbarButton label="H3" title="Heading 3" active={toolbarState?.heading3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
          <ToolbarButton label="P" title="Paragraph" active={toolbarState?.paragraph} onClick={() => editor.chain().focus().setParagraph().run()} />
          <div className="w-px h-4 bg-base-300 mx-1" />
          <ToolbarButton label="•" title="Bullet list" active={toolbarState?.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton label="1." title="Ordered list" active={toolbarState?.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton label="☑" title="Task list" active={toolbarState?.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()} />
          <div className="w-px h-4 bg-base-300 mx-1" />
          <ToolbarButton label={'"'} title="Blockquote" active={toolbarState?.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolbarButton label="{ }" title="Code block" active={toolbarState?.codeBlock} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
          <ToolbarButton label="HR" title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()} />
          <ToolbarButton label="⊞" title="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
          <div className="w-px h-4 bg-base-300 mx-1" />
          <ToolbarButton label="↶" title="Undo" disabled={!toolbarState?.canUndo} onClick={() => editor.chain().focus().undo().run()} />
          <ToolbarButton label="↷" title="Redo" disabled={!toolbarState?.canRedo} onClick={() => editor.chain().focus().redo().run()} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </>
  );
}

function MarkdownEditor({
  initialMarkdown,
  baseDir,
  onChange,
  onSave,
  searchRef,
  onMatches,
}: {
  initialMarkdown: string;
  baseDir: string;
  onChange: (content: string) => void;
  onSave: () => void;
  searchRef?: React.Ref<SearchHandle>;
  onMatches?: (count: number, index: number) => void;
}) {
  // Split frontmatter from body once on mount; both editors are uncontrolled
  // (they read their initial value once), so we recombine via refs on change.
  const [parsed] = useState(() => parseFrontmatter(initialMarkdown));
  const propsRef = useRef<Record<string, PropertyValue>>(parsed.properties);
  const bodyRef = useRef<string>(parsed.body);

  const emit = () => onChange(serializeFrontmatter(propsRef.current, bodyRef.current));

  const hostRef = useRef<HTMLDivElement>(null);
  const onMatchesRef = useRef(onMatches);
  onMatchesRef.current = onMatches;
  // The finder only reads the DOM (CSS Custom Highlight API), so it never
  // touches ProseMirror's own DOM management.
  const [finder] = useState(() => createDomFinder(() => hostRef.current));

  useEffect(() => () => finder.clear(), [finder]);

  useImperativeHandle(searchRef, () => ({
    setQuery(query: string, caseSensitive: boolean) {
      const { count, index } = finder.setQuery(query, caseSensitive);
      onMatchesRef.current?.(count, index);
    },
    next() {
      const { count, index } = finder.next();
      onMatchesRef.current?.(count, index);
    },
    prev() {
      const { count, index } = finder.prev();
      onMatchesRef.current?.(count, index);
    },
    clear() {
      finder.clear();
      onMatchesRef.current?.(0, 0);
    },
  }), [finder]);

  return (
    <div
      ref={hostRef}
      className="tiptap-host h-full overflow-auto"
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
      <TiptapEditor
        initialMarkdown={parsed.body}
        baseDir={baseDir}
        onChange={(md) => {
          bodyRef.current = md;
          emit();
        }}
      />
    </div>
  );
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
});

// Render a ```mermaid fenced block as an SVG diagram. mermaid.render is async
// and needs a unique element id per diagram.
function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    mermaid
      .render(idRef.current, code)
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return <pre className="text-error text-xs whitespace-pre-wrap">{error}</pre>;
  }
  return <div className="my-2 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function isMermaidCode(el: React.ReactNode): boolean {
  return React.isValidElement(el) && /\blanguage-mermaid\b/.test(String((el.props as { className?: string }).className ?? ""));
}

// Shared chat renderer (react-markdown + remark-gfm) plus a mermaid code block
// renderer. Kept separate from MarkdownContent so chat surfaces are unaffected.
const PREVIEW_REMARK_PLUGINS = [remarkGfm];
const PREVIEW_COMPONENTS: Components = {
  code({ node: _node, className, children, ...rest }) {
    if (/\blanguage-mermaid\b/.test(className ?? "")) {
      return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  // Unwrap the <pre> around a mermaid block so the diagram isn't styled as code.
  pre({ node: _node, children, ...rest }) {
    if (isMermaidCode(children)) return <>{children}</>;
    return <pre {...rest}>{children}</pre>;
  },
};

// Read-only preview using the shared chat markdown renderer, with mermaid
// diagram support. Frontmatter is stripped (matching the WYSIWYG view, which
// surfaces it via PropertiesPanel) so raw YAML isn't rendered as body text.
function MarkdownPreview({
  content,
  searchRef,
  onMatches,
}: {
  content: string;
  searchRef?: React.Ref<SearchHandle>;
  onMatches?: (count: number, index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onMatchesRef = useRef(onMatches);
  onMatchesRef.current = onMatches;
  const [finder] = useState(() => createDomFinder(() => containerRef.current));

  useEffect(() => () => finder.clear(), [finder]);

  useImperativeHandle(searchRef, () => ({
    setQuery(query: string, caseSensitive: boolean) {
      const { count, index } = finder.setQuery(query, caseSensitive);
      onMatchesRef.current?.(count, index);
    },
    next() {
      const { count, index } = finder.next();
      onMatchesRef.current?.(count, index);
    },
    prev() {
      const { count, index } = finder.prev();
      onMatchesRef.current?.(count, index);
    },
    clear() {
      finder.clear();
      onMatchesRef.current?.(0, 0);
    },
  }), [finder]);

  return (
    <div ref={containerRef} className="h-full overflow-auto p-4">
      <div className="chat-markdown">
        <ReactMarkdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_COMPONENTS}>
          {parseFrontmatter(content).body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

const CodeIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);
const PreviewIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const WysiwygIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="14" y2="17" />
  </svg>
);
const ChevronUpIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);
const ChevronDownIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const CloseIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function FindBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  count,
  index,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (caseSensitive: boolean) => void;
  count: number;
  index: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="absolute top-2 left-2 z-10 flex items-center gap-1 p-1 rounded-box border border-base-300 bg-base-100 shadow-md">
      <input
        ref={inputRef}
        type="text"
        className="input input-xs w-[180px]"
        placeholder="Find in document"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="text-xs text-base-content/60 tabular-nums w-10 text-center">
        {count ? `${index}/${count}` : "0/0"}
      </span>
      <button className="btn btn-xs btn-ghost" title="Previous match" disabled={count === 0} onClick={onPrev}>
        {ChevronUpIcon}
      </button>
      <button className="btn btn-xs btn-ghost" title="Next match" disabled={count === 0} onClick={onNext}>
        {ChevronDownIcon}
      </button>
      <button
        className={`btn btn-xs ${caseSensitive ? "btn-primary" : "btn-ghost"}`}
        title="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        Aa
      </button>
      <button className="btn btn-xs btn-ghost" title="Close" onClick={onClose}>
        {CloseIcon}
      </button>
    </div>
  );
}

const FileEditorTab: React.FC<FileEditorTabProps> = ({ fileName, filePath, data, onChange, onSave }) => {
  const markdown = isMarkdownFile(fileName);
  const media = mediaKind(fileName);
  const [mode, setMode] = useState<"code" | "wysiwyg" | "preview">(markdown ? "wysiwyg" : "code");

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findCount, setFindCount] = useState(0);
  const [findIndex, setFindIndex] = useState(0);
  const searchRef = useRef<SearchHandle | null>(null);

  useEffect(() => {
    if (!findOpen) {
      searchRef.current?.clear();
      return;
    }
    searchRef.current?.setQuery(findQuery, findCaseSensitive);
    // Re-applied whenever the editor remounts (mode switch) or the on-disk
    // content is reloaded, since the underlying editors are uncontrolled.
  }, [findOpen, findQuery, findCaseSensitive, mode, data.version]);

  const onMatches = (count: number, index: number) => {
    setFindCount(count);
    setFindIndex(index);
  };

  const showFindBar = findOpen && !media && !data.error && data.loaded && !data.tooLarge && !data.binary;

  // Media is rendered from the file URL directly, so it bypasses the editor's
  // content read (and its binary / too-large limits).
  if (media) {
    return <MediaViewer kind={media} filePath={filePath} fileName={fileName} />;
  }

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
    <div
      className="relative h-full"
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setFindOpen(true);
        }
      }}
    >
      {showFindBar && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          caseSensitive={findCaseSensitive}
          onCaseSensitiveChange={setFindCaseSensitive}
          count={findCount}
          index={findIndex}
          onNext={() => searchRef.current?.next()}
          onPrev={() => searchRef.current?.prev()}
          onClose={() => setFindOpen(false)}
        />
      )}
      {markdown && (
        <div className="absolute top-2 right-2 z-10 join shadow-md">
          <button
            className={`join-item btn btn-xs ${mode === "wysiwyg" ? "btn-primary" : "btn-outline btn-neutral"}`}
            title="WYSIWYG"
            onClick={() => setMode("wysiwyg")}
          >
            {WysiwygIcon}
          </button>
          <button
            className={`join-item btn btn-xs ${mode === "code" ? "btn-primary" : "btn-outline btn-neutral"}`}
            title="Source"
            onClick={() => setMode("code")}
          >
            {CodeIcon}
          </button>
          <button
            className={`join-item btn btn-xs ${mode === "preview" ? "btn-primary" : "btn-outline btn-neutral"}`}
            title="Preview"
            onClick={() => setMode("preview")}
          >
            {PreviewIcon}
          </button>
        </div>
      )}
      {markdown && mode === "preview" ? (
        <MarkdownPreview key="preview" content={data.content} searchRef={searchRef} onMatches={onMatches} />
      ) : markdown && mode === "wysiwyg" ? (
        <MarkdownEditor
          key="wysiwyg"
          initialMarkdown={data.content}
          baseDir={dirname(filePath)}
          onChange={onChange}
          onSave={onSave}
          searchRef={searchRef}
          onMatches={onMatches}
        />
      ) : (
        <CodeEditor
          key="code"
          initialDoc={data.content}
          fileName={fileName}
          onChange={onChange}
          onSave={onSave}
          searchRef={searchRef}
          onMatches={onMatches}
        />
      )}
    </div>
  );
};

export default FileEditorTab;
