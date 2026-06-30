import React, { useState, useRef, useCallback } from "react";
import { handleReadlineEdit } from "../../../renderer/src/readline-edit";

export function SessionInput({
  onSend,
  disabled,
}: {
  onSend: (message: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }, [text, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleReadlineEdit(e, setText)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-base-300 p-3 flex flex-col h-full min-h-0">
      <div className="flex gap-2 items-end flex-1 min-h-0">
        <textarea
          ref={textareaRef}
          className="textarea textarea-bordered flex-1 h-full min-h-[40px] resize-none text-sm leading-relaxed"
          placeholder={disabled ? "Session not active" : "Send a message…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
