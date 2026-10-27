import { execFile, spawn, type ChildProcess } from "node:child_process";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { cmdShimCommandLine } from "./cmd-escape.js";
import { childEnvironment, resolveExecutable, type Env } from "./environment.js";

/** ADR-0011: commands time out after 120 s unless told otherwise. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** After a graceful stop on timeout, a hard kill follows this soon (ADR-0011). */
const HARD_KILL_AFTER_MS = 5_000;
/** A cancel must stop within 2 s (AGENTS.md), so its hard kill comes sooner (ADR-0011). */
const CANCEL_HARD_KILL_AFTER_MS = 1_500;
/** Captured output per stream; the rest is counted, not kept. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunOptions {
  /** Working folder; callers confine it to the project first (ADR-0011). */
  cwd: string;
  timeoutMs?: number;
  /** Cancels the command; it stops within 2 s (AGENTS.md). */
  signal?: AbortSignal;
  /** Added to the allowlisted environment. */
  env?: Env;
  maxOutputBytes?: number;
}

export interface RunResult {
  /** Null when the process was ended by a signal or a kill. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Output beyond `maxOutputBytes` was dropped. */
  truncated: boolean;
  durationMs: number;
}

/**
 * Runs `argv` without a shell (ADR-0011) and collects its output. A process exit, even a
 * failing one, is a result, not an error; errors are for "could not run", timeouts and
 * cancellation, after which the whole process tree has been stopped.
 *
 * This is the spawning core the Phase 3 ProcessSupervisor builds on (approvals, the orphan
 * ledger and managed processes come with it). Today only fixed, Jesutobits-chosen commands
 * use it, such as the toolchain check.
 */
export async function runCommand(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [command, ...args] = argv;
  if (!command || argv.some((part) => part.includes("\0"))) {
    throw new JesutobitsError(
      ErrorCodes.processInvalidCommand,
      "The command is empty or malformed",
    );
  }
  const env = childEnvironment(process.env, options.env ?? {});
  const executable = await resolveExecutable(command, env);
  if (!executable) {
    throw new JesutobitsError(
      ErrorCodes.processNotFound,
      `${command} is not installed or not on PATH`,
      {
        details: { command },
      },
    );
  }

  const started = performance.now();
  const isShim = executable.kind === "cmd-shim";
  let child: ChildProcess;
  try {
    child = isShim
      ? spawn(
          env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `"${cmdShimCommandLine(executable.path, args)}"`],
          {
            cwd: options.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executable.path, args, {
          cwd: options.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // Its own process group on POSIX, so the whole tree can be stopped (ADR-0011).
          detached: process.platform !== "win32",
        });
  } catch (error) {
    throw spawnFailed(command, error);
  }

  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = capture(child.stdout, max);
  const stderr = capture(child.stderr, max);

  return new Promise<RunResult>((resolve, reject) => {
    let stopping: "timeout" | "cancelled" | undefined;
    const stop = (reason: "timeout" | "cancelled") => {
      if (stopping) return;
      stopping = reason;
      killTree(child, false);
      const grace = reason === "cancelled" ? CANCEL_HARD_KILL_AFTER_MS : HARD_KILL_AFTER_MS;
      setTimeout(() => killTree(child, true), grace).unref();
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop("cancelled");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(spawnFailed(command, error));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const durationMs = Math.round(performance.now() - started);
      if (stopping === "timeout") {
        reject(
          new JesutobitsError(
            ErrorCodes.processTimeout,
            `${command} took longer than ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms and was stopped`,
            {
              retryable: true,
              details: { command, durationMs },
            },
          ),
        );
        return;
      }
      if (stopping === "cancelled") {
        reject(
          new JesutobitsError(ErrorCodes.processCancelled, `${command} was cancelled`, {
            details: { command, durationMs },
          }),
        );
        return;
      }
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated() || stderr.truncated(),
        durationMs,
      });
    });
  });
}

function capture(stream: NodeJS.ReadableStream | null, max: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = false;
  stream?.on("data", (chunk: Buffer) => {
    if (kept >= max) {
      dropped = true;
      return;
    }
    const room = max - kept;
    if (chunk.length > room) dropped = true;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    chunks.push(piece);
    kept += piece.length;
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => dropped,
  };
}

/** Stops the process and everything it started. */
export function killTree(child: ChildProcess, hard: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    // A job object owns the runtime's tree (ADR-0011); a single command's tree uses taskkill.
    execFile(
      "taskkill",
      ["/T", "/F", "/PID", String(child.pid)],
      { windowsHide: true },
      () => undefined,
    );
    return;
  }
  try {
    process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(hard ? "SIGKILL" : "SIGTERM");
  }
}

function spawnFailed(command: string, error: unknown): JesutobitsError {
  return new JesutobitsError(ErrorCodes.processSpawnFailed, `${command} could not be started`, {
    details: { command, reason: error instanceof Error ? error.message : String(error) },
  });
}
