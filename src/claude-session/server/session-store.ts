/**
 * Session store: reads Claude session history from JSONL files via the SDK.
 * Provides session listing and message retrieval for read-only mode.
 */

import type {
  SessionInfo,
  SessionMessage,
  ContentBlock,
} from "../shared/protocol.js";

// Re-export SDK types we need at the type level only
import type {
  SDKSessionInfo,
  SessionMessage as SDKSessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

export class SessionStore {
  /** List sessions for a directory */
  async listSessions(opts: {
    dir: string;
    limit?: number;
    offset?: number;
  }): Promise<SessionInfo[]> {
    const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");

    const sessions = await listSessions({
      dir: opts.dir,
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      includeWorktrees: true,
    });

    return sessions.map(
      (s): SessionInfo => ({
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        createdAt: s.createdAt,
        isActive: false, // Caller overlays active status from ClaudeService
      })
    );
  }

  /** Get messages for a historical session */
  async getMessages(opts: {
    sessionId: string;
    dir?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ messages: SessionMessage[]; hasMore: boolean }> {
    const { getSessionMessages } = await import(
      "@anthropic-ai/claude-agent-sdk"
    );

    const limit = opts.limit ?? 100;
    const sdkMessages = await getSessionMessages(opts.sessionId, {
      dir: opts.dir,
      limit: limit + 1, // fetch one extra to check hasMore
      offset: opts.offset ?? 0,
    });

    const hasMore = sdkMessages.length > limit;
    const slice = hasMore ? sdkMessages.slice(0, limit) : sdkMessages;

    const messages = slice.map((m) => this.translateMessage(m));

    return { messages, hasMore };
  }

  private translateMessage(m: SDKSessionMessage): SessionMessage {
    const content: ContentBlock[] = [];
    const rawMessage = m.message as any;

    if (!rawMessage) {
      return {
        id: m.uuid ?? crypto.randomUUID(),
        role: m.type as "user" | "assistant",
        content: [],
        timestamp: null,
      };
    }

    // Assistant messages have content as an array of blocks
    // User messages have content as string or array
    const rawContent = rawMessage.content ?? rawMessage;

    if (typeof rawContent === "string") {
      content.push({ type: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          content.push({
            type: "thinking",
            thinking: block.thinking ?? "",
          });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            toolUse: {
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            },
          });
        } else if (block.type === "tool_result") {
          const output =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          content.push({
            type: "tool_result",
            toolResult: {
              toolUseId: block.tool_use_id,
              output,
              isError: block.is_error ?? false,
            },
          });
        }
      }
    }

    return {
      id: m.uuid ?? crypto.randomUUID(),
      role: m.type as "user" | "assistant",
      content,
      timestamp: null,
    };
  }
}
