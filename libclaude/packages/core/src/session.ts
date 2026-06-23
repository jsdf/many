import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import crypto from "node:crypto";
import type {
  ClaudeEvent,
  PermissionMode,
  SessionOptions,
  SessionStatus,
  TurnResult,
} from "./types.js";

/**
 * A persistent, multi-turn Claude session backed by a single long-lived
 * `claude -p` process in bidirectional stream-json mode. Each prompt is one
 * turn in the *same* conversation. Turns are serialized: one runs at a time and
 * extra prompts queue.
 *
 * This is the same approach as the `claude-line` HTTP wrapper, lifted into a
 * reusable Node API surface modelled on the Claude Agent SDK's `query()`.
 *
 * Emits:
 *  - "event"  (event: ClaudeEvent)        every raw CLI event, across all turns
 *  - "status" (status: SessionStatus)     whenever ready/busy/queue/session change
 *  - "error"  (err: Error)                non-fatal background errors
 */
/** Single-quote a string for safe interpolation into a shell command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private ready = false;
  private sessionId: string | null = null;
  private crashes = 0;
  private shuttingDown = false;

  private readonly queue: Job[] = [];
  private current: Job | null = null;

  private readonly cwd: string;
  private readonly model: string;
  private permissionMode: string;
  private readonly claudeBin: string;
  private readonly loginShell: boolean;
  private readonly shell: string;
  private readonly extraArgs: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly maxCrashes: number;

  constructor(options: SessionOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model ?? "";
    this.permissionMode = options.permissionMode ?? "auto";
    this.claudeBin = options.claudeBin ?? "claude";
    this.loginShell = options.loginShell ?? false;
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/bash";
    this.extraArgs = options.extraArgs ?? [];
    this.env = options.env ?? process.env;
    this.maxCrashes = options.maxCrashes ?? 5;
    this.spawnClaude();
  }

  get status(): SessionStatus {
    return {
      ready: this.ready,
      busy: this.current !== null,
      queued: this.queue.length,
      sessionId: this.sessionId,
      pid: this.proc?.pid ?? null,
    };
  }

  /**
   * Run one turn and stream its events as they arrive. The generator's return
   * value is the buffered {@link TurnResult} for the turn.
   *
   *   for await (const event of session.query("hello")) { ... }
   */
  async *query(prompt: string): AsyncGenerator<ClaudeEvent, TurnResult, void> {
    const sink = new EventSink();
    const job: Job = {
      prompt,
      events: [],
      text: [],
      settled: false,
      onEvent: (e) => sink.push(e),
      onDone: (r) => sink.close(r),
      onError: (err) => sink.fail(err),
    };
    this.enqueue(job);
    yield* sink.iterate();
    return sink.result!;
  }

  /** Run one turn and return its buffered result. */
  prompt(prompt: string): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      const job: Job = {
        prompt,
        events: [],
        text: [],
        settled: false,
        onDone: resolve,
        onError: reject,
      };
      this.enqueue(job);
    });
  }

  /** Restart the underlying claude process with a fresh, empty conversation. */
  reset(): void {
    this.failInFlight(new Error("session reset"));
    this.shuttingDown = false;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.sessionId = null;
    this.crashes = 0;
    this.spawnClaude();
  }

  /** Best-effort interrupt of the in-flight turn via a stream-json control request. */
  interrupt(): void {
    if (!this.proc || !this.current) return;
    const msg = {
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "interrupt" },
    };
    try {
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Change the permission mode of the running session via a stream-json control
   * request. The new mode also applies to any future respawn after a crash.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    if (!this.proc) return;
    const msg = {
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    };
    try {
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Shut down the session and its child process. */
  dispose(): void {
    this.shuttingDown = true;
    this.failInFlight(new Error("session disposed"));
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.removeAllListeners();
  }

  // ---- internals ----

  private buildArgs(): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.permissionMode,
    ];
    if (this.model) args.push("--model", this.model);
    if (this.extraArgs.length) args.push(...this.extraArgs);
    return args;
  }

  private spawnClaude(): void {
    const [command, args] = this.loginShell
      ? [
          this.shell,
          [
            "-li",
            "-c",
            [this.claudeBin, ...this.buildArgs().map(shellQuote)].join(" "),
          ],
        ]
      : [this.claudeBin, this.buildArgs()];
    const proc = spawn(command, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: this.env,
    });
    this.proc = proc;
    // claude emits its init event only after the first input, so readiness is
    // gated on the process being spawned with a writable stdin, not on init.
    this.ready = true;
    this.crashes = 0;
    this.sessionId = null;
    this.emitStatus();
    process.nextTick(() => this.pump());

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: ClaudeEvent;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON noise
      }
      this.handleEvent(evt);
    });

    proc.on("exit", (code, signal) => {
      this.ready = false;
      this.emitStatus();
      this.failInFlight(new Error(`claude exited (code=${code} signal=${signal})`));
      if (this.shuttingDown) return;
      this.crashes += 1;
      if (this.crashes > this.maxCrashes) {
        this.emit("error", new Error("claude crashed too many times; not respawning"));
        return;
      }
      setTimeout(() => this.spawnClaude(), 500);
    });

    proc.on("error", (err) => {
      this.emit("error", err);
      this.failInFlight(new Error(`failed to spawn claude: ${err.message}`));
    });
  }

  private handleEvent(evt: ClaudeEvent): void {
    if (evt.type === "system" && (evt as { subtype?: string }).subtype === "init") {
      this.sessionId = (evt.session_id as string) || this.sessionId;
      this.emitStatus();
      return;
    }
    if (evt.session_id) this.sessionId = evt.session_id;

    this.emit("event", evt);

    const job = this.current;
    if (!job) return; // stray events between turns

    job.events.push(evt);
    job.onEvent?.(evt);

    if (evt.type === "assistant") {
      const content = (evt as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "text" && typeof block.text === "string") {
            job.text.push(block.text);
          }
        }
      }
    }

    if (evt.type === "result") {
      this.finishCurrent(evt);
    }
  }

  private finishCurrent(resultEvt: ClaudeEvent): void {
    const job = this.current;
    this.current = null;
    if (!job || job.settled) {
      this.pump();
      return;
    }
    job.settled = true;

    const r = resultEvt as {
      is_error?: boolean;
      subtype?: string;
      result?: string;
      session_id?: string;
      num_turns?: number;
      duration_ms?: number;
      total_cost_usd?: number;
    };
    const isError = r.is_error === true || String(r.subtype ?? "").startsWith("error");
    const result =
      typeof r.result === "string" && r.result.length ? r.result : job.text.join("");

    const turn: TurnResult = {
      ok: !isError,
      result,
      sessionId: r.session_id ?? this.sessionId,
      isError,
      subtype: r.subtype,
      numTurns: r.num_turns,
      durationMs: r.duration_ms,
      costUsd: r.total_cost_usd,
      events: job.events,
    };
    job.onDone?.(turn);
    this.emitStatus();
    this.pump();
  }

  private failInFlight(err: Error): void {
    const jobs: Job[] = [];
    if (this.current) {
      jobs.push(this.current);
      this.current = null;
    }
    while (this.queue.length) jobs.push(this.queue.shift()!);
    for (const job of jobs) {
      if (job.settled) continue;
      job.settled = true;
      job.onError?.(err);
    }
    this.emitStatus();
  }

  private enqueue(job: Job): void {
    this.queue.push(job);
    this.emitStatus();
    this.pump();
  }

  private pump(): void {
    if (!this.ready || this.current || this.queue.length === 0) return;
    this.current = this.queue.shift()!;
    const userMessage = {
      type: "user",
      message: { role: "user", content: this.current.prompt },
    };
    try {
      this.proc!.stdin!.write(JSON.stringify(userMessage) + "\n");
      this.emitStatus();
    } catch (err) {
      const job = this.current;
      this.current = null;
      job.settled = true;
      job.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitStatus(): void {
    this.emit("status", this.status);
  }
}

interface Job {
  prompt: string;
  events: ClaudeEvent[];
  text: string[];
  settled: boolean;
  onEvent?: (e: ClaudeEvent) => void;
  onDone?: (r: TurnResult) => void;
  onError?: (err: Error) => void;
}

/**
 * Bridges the push-based event callbacks into a pull-based async iterator for
 * {@link ClaudeSession.query}. Buffers events that arrive before the consumer
 * asks for them.
 */
class EventSink {
  result: TurnResult | null = null;
  private buffer: ClaudeEvent[] = [];
  private done = false;
  private error: Error | null = null;
  private waiting: (() => void) | null = null;

  push(e: ClaudeEvent): void {
    this.buffer.push(e);
    this.wake();
  }

  close(r: TurnResult): void {
    this.result = r;
    this.done = true;
    this.wake();
  }

  fail(err: Error): void {
    this.error = err;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  async *iterate(): AsyncGenerator<ClaudeEvent, void, void> {
    while (true) {
      while (this.buffer.length) yield this.buffer.shift()!;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
