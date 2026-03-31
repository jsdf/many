import React, { useRef, useEffect } from "react";
import type { SessionMessage } from "../../shared/protocol.js";
import { ChatMessage } from "./ChatMessage.js";

export function MessageList({
  messages,
}: {
  messages: SessionMessage[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  // Auto-scroll to bottom when new messages arrive (if user is near bottom)
  useEffect(() => {
    if (shouldScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    shouldScrollRef.current = nearBottom;
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
        No messages yet
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto"
      onScroll={handleScroll}
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
