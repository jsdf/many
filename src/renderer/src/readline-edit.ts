import type React from "react";

// Readline-style editing for prompt textareas, matching a terminal:
//   Ctrl+W  delete the word before the cursor
//   Ctrl+U  delete from the cursor back to the start of the line
// macOS textareas already handle the other emacs bindings (Ctrl+A/E/K, etc.)
// natively, so we only fill these two gaps.

const WHITESPACE = /\s/;

// Index where the word before `cursor` begins: skip trailing whitespace, then
// the word characters, mirroring bash's unix-word-rubout (Ctrl+W).
export function wordStartBefore(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && WHITESPACE.test(value[i - 1]!)) i--;
  while (i > 0 && !WHITESPACE.test(value[i - 1]!)) i--;
  return i;
}

// Index of the start of the line containing `cursor` (char after the previous
// newline, or 0).
export function lineStartBefore(value: string, cursor: number): number {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

// Handles Ctrl+W / Ctrl+U on a textarea. Mutates the element's value and
// selection in place, then calls `setValue` so the controlled component's state
// stays in sync (setRangeText does not fire an input event). Returns true if the
// event was handled.
export function handleReadlineEdit(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  setValue: (value: string) => void,
): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.currentTarget;
  const { selectionStart, selectionEnd, value } = el;
  if (selectionStart === null || selectionEnd === null) return false;

  let from: number;
  if (e.key === "w") {
    from = selectionStart === selectionEnd ? wordStartBefore(value, selectionStart) : selectionStart;
  } else if (e.key === "u") {
    from = lineStartBefore(value, selectionStart);
  } else {
    return false;
  }

  e.preventDefault();
  el.setRangeText("", from, selectionEnd, "end");
  setValue(el.value);
  return true;
}
