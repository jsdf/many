import { useState, type FormEvent, type CSSProperties } from "react";
import type { RpcClient, Procedures } from "@libclaude/rpc";
import { useClaudeSession, type TurnRecord } from "./useClaudeSession.ts";
import { eventsToBlocks, stringify } from "./render.ts";

export interface ClaudeViewProps {
  rpc: RpcClient<Procedures>;
}

/**
 * Self-contained, dependency-free interactive view of a Claude session. Renders
 * the turn log (prompts, streamed text, tool calls) plus a composer and session
 * controls. Styling is inline so it drops into any app; restyle as needed.
 */
export function ClaudeView({ rpc }: ClaudeViewProps) {
  const { status, turns, busy, sendPrompt, reset, interrupt } = useClaudeSession(rpc);
  const [draft, setDraft] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendPrompt(draft);
    setDraft("");
  };

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <strong>libclaude</strong>
        <span style={styles.status}>
          {status
            ? `${status.ready ? "ready" : "down"} · ${status.busy ? "busy" : "idle"}` +
              (status.queued ? ` · ${status.queued} queued` : "") +
              (status.sessionId ? ` · ${status.sessionId.slice(0, 8)}` : "")
            : "connecting…"}
        </span>
        <span style={styles.spacer} />
        <button type="button" onClick={() => void interrupt()} disabled={!busy} style={styles.btn}>
          interrupt
        </button>
        <button type="button" onClick={() => void reset()} style={styles.btn}>
          reset
        </button>
      </header>

      <div style={styles.log}>
        {turns.length === 0 && <div style={styles.empty}>No turns yet. Send a prompt below.</div>}
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
      </div>

      <form onSubmit={onSubmit} style={styles.composer}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) onSubmit(e);
          }}
          placeholder="Prompt the agent…  (Enter to send, Shift+Enter for newline)"
          rows={3}
          style={styles.textarea}
        />
        <button type="submit" disabled={!draft.trim()} style={styles.send}>
          Send
        </button>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: TurnRecord }) {
  const blocks = eventsToBlocks(turn.events);
  return (
    <div style={styles.turn}>
      <div style={styles.prompt}>{turn.prompt}</div>
      {blocks.map((b, i) => {
        if (b.kind === "text") return <div key={i} style={styles.text}>{b.text}</div>;
        if (b.kind === "tool_use")
          return (
            <pre key={i} style={styles.tool}>
              {`→ ${b.name}\n${stringify(b.input)}`}
            </pre>
          );
        return (
          <pre key={i} style={{ ...styles.tool, ...(b.isError ? styles.toolError : null) }}>
            {`← ${b.isError ? "error" : "result"}\n${stringify(b.content)}`}
          </pre>
        );
      })}
      {turn.running && <div style={styles.running}>…working</div>}
      {turn.result && turn.result.isError && (
        <div style={styles.error}>error: {turn.result.subtype ?? "failed"}</div>
      )}
    </div>
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
const styles: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", fontFamily: "system-ui, sans-serif", color: "#e5e5e5", background: "#0d0d0d" },
  header: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #222", fontSize: 13 },
  status: { color: "#888", fontFamily: mono, fontSize: 12 },
  spacer: { flex: 1 },
  btn: { background: "#1a1a1a", color: "#ccc", border: "1px solid #333", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" },
  log: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 16 },
  empty: { color: "#666", fontSize: 13 },
  turn: { display: "flex", flexDirection: "column", gap: 8 },
  prompt: { alignSelf: "flex-end", maxWidth: "80%", background: "#1e3a5f", padding: "8px 12px", borderRadius: 10, whiteSpace: "pre-wrap", fontSize: 14 },
  text: { whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.5 },
  tool: { background: "#141414", border: "1px solid #2a2a2a", borderRadius: 8, padding: 10, fontFamily: mono, fontSize: 12, overflowX: "auto", margin: 0, color: "#bbb" },
  toolError: { borderColor: "#5f1e1e", color: "#f0a0a0" },
  running: { color: "#888", fontSize: 13, fontStyle: "italic" },
  error: { color: "#f0a0a0", fontSize: 13 },
  composer: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #222" },
  textarea: { flex: 1, resize: "none", background: "#141414", color: "#e5e5e5", border: "1px solid #333", borderRadius: 8, padding: 10, fontSize: 14, fontFamily: "inherit" },
  send: { alignSelf: "flex-end", background: "#2563eb", color: "white", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 14, cursor: "pointer" },
};
