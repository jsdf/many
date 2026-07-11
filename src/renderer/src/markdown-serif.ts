// Toggles the `markdown-serif` class on the document root, which switches all
// rendered markdown surfaces (WYSIWYG editor, file preview, Claude session
// history + UI) to a serif font. Driven by the global setting.
export function applyMarkdownSerif(enabled: boolean): void {
  document.documentElement.classList.toggle("markdown-serif", enabled);
}
