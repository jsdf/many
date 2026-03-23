/**
 * Restricted shiki re-export that only bundles the languages and themes we
 * actually need. The bare "shiki" import is aliased to this file in
 * vite.config.ts (via a regex alias so subpath imports like "shiki/core" are
 * unaffected).
 *
 * This cuts ~300 language grammar chunks down to a handful.
 */

// Re-export everything from shiki/core (functions, types, etc.)
export * from "shiki/core";

// shiki/core exports createHighlighterCore, but consumers import
// createHighlighter by name — re-export the alias.
export { createHighlighterCore as createHighlighter } from "shiki/core";

// Engine re-export — only the JS engine, not the wasm-based oniguruma engine
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Only the languages relevant for a git diff viewer
export const bundledLanguages: Record<string, () => Promise<unknown>> = {
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
};

// Only the themes we use
export const bundledThemes: Record<string, () => Promise<unknown>> = {
  "github-dark": () => import("shiki/dist/themes/github-dark.mjs"),
  "github-light": () => import("shiki/dist/themes/github-light.mjs"),
};
