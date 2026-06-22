import { ViewPlugin, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

const URL_REGEX = /https?:\/\/[^\s'"`,<>()[\]{}\\]+/g;

const linkMark = Decoration.mark({ class: "cm-url-link" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(text)) !== null) {
      builder.add(from + match.index, from + match.index + match[0].length, linkMark);
    }
  }
  return builder.finish();
}

class UrlLinker {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

export const urlLinker = [
  ViewPlugin.fromClass(UrlLinker, {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(event: MouseEvent, view: EditorView) {
        if (!event.metaKey && !event.ctrlKey) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        const lineText = view.state.doc.sliceString(line.from, line.to);
        URL_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = URL_REGEX.exec(lineText)) !== null) {
          const start = line.from + match.index;
          const end = start + match[0].length;
          if (pos >= start && pos <= end) {
            event.preventDefault();
            window.open(match[0], "_blank", "noopener,noreferrer");
            return true;
          }
        }
        return false;
      },
    },
  }),
  EditorView.baseTheme({
    ".cm-url-link": {
      color: "var(--color-primary, #4a9eff)",
      textDecoration: "underline",
      cursor: "pointer",
    },
  }),
];
