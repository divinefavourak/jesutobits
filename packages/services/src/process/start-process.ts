import { spawn, type ChildProcess } from "node:child_process";
import { ErrorCodes, JesutobitsError } from "@jesutobits/protocol";
import { cmdShimCommandLine } from "./cmd-escape.js";
import { childEnvironment, resolveExecutable, type Env } from "./environment.js";
import { killTree } from "./run-command.js";

export interface StartOptions {
  cwd: string;
  env?: Env;
  /** Every line the process prints, stdout and stderr alike, without the line break. */
  onLine(line: string, stream: "stdout" | "stderr"): void;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  /** Settles with the exit code (null after a signal or a kill) once the process is gone. */
  readonly exited: Promise<number | null>;
  /** Closes stdin, then stops the whole tree if it has not exited within `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Starts a long-running process such as a dev server (ADR-0011): argv only, no shell, the
 * allowlisted environment, stdin held open (the preview launcher exits when it closes), and
 * the whole tree stopped on `stop()`. Its output arrives line by line.
 */
export async function startProcess(
  argv: readonly string[],
  options: StartOptions,
): Promise<ProcessHandle> {
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
  let child: ChildProcess;
  try {
    child =
      executable.kind === "cmd-shim"
        ? spawn(
            env.ComSpec ?? "cmd.exe",
            ["/d", "/s", "/c", `"${cmdShimCommandLine(executable.path, args)}"`],
            {
              cwd: options.cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              windowsVerbatimArguments: true,
            },
          )
        : spawn(executable.path, args, {
            cwd: options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
          });
  } catch (error) {
    throw new JesutobitsError(ErrorCodes.processSpawnFailed, `${command} could not be started`, {
      details: { command, reason: error instanceof Error ? error.message : String(error) },
    });
  }

  forwardLines(child.stdout, (line) => options.onLine(line, "stdout"));
  forwardLines(child.stderr, (line) => options.onLine(line, "stderr"));
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });

  return {
    pid: child.pid,
    exited,
    async stop(graceMs = 3000) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.end();
      const timer = setTimeout(() => killTree(child, true), graceMs);
      timer.unref();
      await exited;
      clearTimeout(timer);
    },
  };
}

function forwardLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > 64 * 1024) {
      onLine(buffer);
      buffer = "";
    }
  });
  stream.on("end", () => {
    if (buffer !== "") onLine(buffer);
  });
}
