import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

/**
 * Shared markdown renderer for chat surfaces (session history + live Claude UI).
 *
 * Styling lives in the `.chat-markdown` block in styles.css rather than the
 * Tailwind typography plugin (which isn't installed), matching how the TipTap
 * editor restores prose styling that Tailwind's preflight strips.
 */
export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS}>{text}</Markdown>
    </div>
  );
});
