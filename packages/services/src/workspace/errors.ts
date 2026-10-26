import { ErrorCodes, JesutobitsError, type JesutobitsErrorCode } from "@jesutobits/protocol";

const ERRNO_CODES: Record<string, JesutobitsErrorCode> = {
  ENOENT: ErrorCodes.fsNotFound,
  ENOTDIR: ErrorCodes.fsNotADirectory,
  EISDIR: ErrorCodes.fsNotAFile,
  EEXIST: ErrorCodes.fsAlreadyExists,
  ENOTEMPTY: ErrorCodes.fsNotEmpty,
  EACCES: ErrorCodes.fsPermissionDenied,
  EPERM: ErrorCodes.fsPermissionDenied,
};

const MESSAGES: Partial<Record<JesutobitsErrorCode, string>> = {
  [ErrorCodes.fsNotFound]: "does not exist",
  [ErrorCodes.fsNotADirectory]: "is not a folder",
  [ErrorCodes.fsNotAFile]: "is not a file",
  [ErrorCodes.fsAlreadyExists]: "already exists",
  [ErrorCodes.fsNotEmpty]: "is a folder that is not empty",
  [ErrorCodes.fsPermissionDenied]: "cannot be accessed (permission denied)",
};

/**
 * Turns a Node file-system error into a JesutobitsError that names the project-relative
 * path, never the absolute one or the raw OS message (ARCHITECTURE.md section 9.2).
 */
export function fsError(error: unknown, relative: string): JesutobitsError {
  if (error instanceof JesutobitsError) return error;
  const errno = (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
  const code = ERRNO_CODES[errno] ?? ErrorCodes.fsIo;
  const what = MESSAGES[code] ?? `could not be accessed (${errno})`;
  return new JesutobitsError(code, `${display(relative)} ${what}`, {
    retryable: code === ErrorCodes.fsIo,
    details: { path: relative, errno },
  });
}

/** How a project-relative path appears in messages; "" is the project folder itself. */
export function display(relative: string): string {
  return relative === "" ? "The project folder" : relative;
}
