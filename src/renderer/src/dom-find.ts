// Find-in-page for read-only DOM content (markdown preview, WYSIWYG host),
// implemented with the CSS Custom Highlight API so it never mutates the DOM
// (unlike wrapping matches in <mark> elements, which would corrupt ProseMirror).
export interface DomFinder {
  setQuery(query: string, caseSensitive: boolean): { count: number; index: number };
  next(): { count: number; index: number };
  prev(): { count: number; index: number };
  clear(): void;
}

const ALL_HIGHLIGHT = "many-find-all";
const CURRENT_HIGHLIGHT = "many-find-current";

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

export function createDomFinder(getRoot: () => HTMLElement | null): DomFinder {
  let ranges: Range[] = [];
  let currentIndex = 0;

  function clear(): void {
    ranges = [];
    currentIndex = 0;
    if (!highlightsSupported()) return;
    CSS.highlights.delete(ALL_HIGHLIGHT);
    CSS.highlights.delete(CURRENT_HIGHLIGHT);
  }

  function showCurrent(): void {
    if (!highlightsSupported()) return;
    const range = ranges[currentIndex];
    if (!range) {
      CSS.highlights.delete(CURRENT_HIGHLIGHT);
      return;
    }
    CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(range));
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }

  function result(): { count: number; index: number } {
    return { count: ranges.length, index: ranges.length ? currentIndex + 1 : 0 };
  }

  function setQuery(query: string, caseSensitive: boolean): { count: number; index: number } {
    if (!highlightsSupported()) return { count: 0, index: 0 };
    if (!query) {
      clear();
      return { count: 0, index: 0 };
    }
    const root = getRoot();
    if (!root) {
      clear();
      return { count: 0, index: 0 };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; start: number }[] = [];
    let flat = "";
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text;
      nodes.push({ node: text, start: flat.length });
      flat += text.data;
    }

    const haystack = caseSensitive ? flat : flat.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();

    function nodeAt(offset: number): { node: Text; localOffset: number } | null {
      // nodes is sorted by start; find the last node whose start <= offset.
      let lo = 0;
      let hi = nodes.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].start <= offset) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (idx < 0) return null;
      const entry = nodes[idx];
      return { node: entry.node, localOffset: offset - entry.start };
    }

    const found: Range[] = [];
    let searchFrom = 0;
    while (needle.length > 0) {
      const matchStart = haystack.indexOf(needle, searchFrom);
      if (matchStart < 0) break;
      const matchEnd = matchStart + needle.length;
      const start = nodeAt(matchStart);
      const end = nodeAt(matchEnd - 1);
      if (start && end) {
        const range = document.createRange();
        range.setStart(start.node, start.localOffset);
        range.setEnd(end.node, end.localOffset + 1);
        found.push(range);
      }
      searchFrom = matchEnd;
    }

    ranges = found;
    currentIndex = 0;
    CSS.highlights.set(ALL_HIGHLIGHT, new Highlight(...ranges));
    showCurrent();
    return result();
  }

  function next(): { count: number; index: number } {
    if (!ranges.length) return result();
    currentIndex = (currentIndex + 1) % ranges.length;
    showCurrent();
    return result();
  }

  function prev(): { count: number; index: number } {
    if (!ranges.length) return result();
    currentIndex = (currentIndex - 1 + ranges.length) % ranges.length;
    showCurrent();
    return result();
  }

  return { setQuery, next, prev, clear };
}
