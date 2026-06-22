import { ClaudeSession } from "@libclaude/core";
import { RpcServer, type Procedures } from "@libclaude/rpc";

/**
 * Wire a {@link ClaudeSession} to the libclaude RPC contract. Returns an
 * {@link RpcServer} ready to bind to any {@link ServerTransport}.
 */
export function createRpcServer(session: ClaudeSession): RpcServer<Procedures> {
  const server = new RpcServer<Procedures>();

  server.subscription("status", (_input, push) => {
    push(session.status); // initial snapshot
    const onStatus = () => push(session.status);
    session.on("status", onStatus);
    return () => session.off("status", onStatus);
  });

  server.subscription("turn", (input, push) => {
    const gen = session.query(input.prompt);
    let cancelled = false;
    (async () => {
      try {
        while (true) {
          const { value, done } = await gen.next();
          if (cancelled) return;
          if (done) {
            push({ kind: "done", result: value });
            return;
          }
          push({ kind: "event", event: value });
        }
      } catch (err) {
        if (!cancelled) throw err;
      }
    })().catch(() => {
      /* surfaced to the subscriber as a stream end; nothing else to do */
    });
    return () => {
      cancelled = true;
      void gen.return(undefined as never);
      session.interrupt();
    };
  });

  server.query("reset", () => {
    session.reset();
    return { ok: true };
  });

  server.query("interrupt", () => {
    session.interrupt();
    return { ok: true };
  });

  return server;
}
