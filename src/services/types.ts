// Service layer types

export type ProgressEvent =
  | { type: "step"; text: string }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; text: string };

export type OnProgress = (event: ProgressEvent) => void;

/**
 * Caller-provided command runner. Allows server to pipe stdout/stderr to SSE,
 * CLI to use stdio: "inherit", and tests to mock.
 * Returns the exit code.
 */
export type RunCommand = (
  command: string,
  cwd: string,
  onProgress?: OnProgress
) => Promise<number>;
