import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getRpcClient } from "../rpc-client";
import { ChatMessage, coalesceMessages, type SessionMessage, type DisplayItem } from "./ChatMessage";

interface SessionHistoryTabProps {
  sessionId: string;
  worktreePath: string;
}

const PAGE_SIZE = 200;

const SessionHistoryTab: React.FC<SessionHistoryTabProps> = ({ sessionId, worktreePath }) => {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const parentRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const result = await getRpcClient().query("claude.sessionMessages", {
        sessionId,
        worktreePath,
        offset,
        limit: PAGE_SIZE,
      }) as any;
      if (offset === 0) {
        setMessages(result.messages);
      } else {
        setMessages((prev) => [...prev, ...result.messages]);
      }
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to load session messages:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, worktreePath]);

  useEffect(() => {
    loadMessages(0);
  }, [loadMessages]);

  const displayItems = useMemo(() => coalesceMessages(messages), [messages]);

  const hasMore = messages.length < total;

  const virtualizer = useVirtualizer({
    count: displayItems.length + (hasMore ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  });

  // Auto-scroll to bottom on initial load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (displayItems.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(displayItems.length - 1, { align: "end" });
      });
    }
  }, [displayItems.length, virtualizer]);

  // Load more when scrolling near bottom
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || loading || !hasMore) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 200) {
      loadMessages(messages.length);
    }
  }, [hasMore, loading, loadMessages, messages.length]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="h-full flex flex-col bg-base-100">
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {items.map((virtualItem) => {
              const isLoaderRow = virtualItem.index >= displayItems.length;
              const item = isLoaderRow ? null : displayItems[virtualItem.index];

              return (
                <div
                  key={virtualItem.index}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {isLoaderRow ? (
                    <div className="flex justify-center p-6">
                      {loading ? (
                        <span className="loading loading-spinner loading-sm" />
                      ) : (
                        <span className="text-xs text-base-content/40">
                          {total} messages total
                        </span>
                      )}
                    </div>
                  ) : (
                    <ChatMessage
                      message={item!.message}
                      toolUses={item!.toolUses}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionHistoryTab;
