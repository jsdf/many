import { ClaudeSession } from "./session.js";
import type { SessionOptions } from "./types.js";

export { ClaudeSession } from "./session.js";
export type {
  SessionOptions,
  SessionStatus,
  PermissionMode,
  TurnResult,
  ClaudeEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  SystemInitEvent,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "./types.js";

/** Convenience factory mirroring the Agent SDK's entrypoint style. */
export function createSession(options: SessionOptions = {}): ClaudeSession {
  return new ClaudeSession(options);
}
