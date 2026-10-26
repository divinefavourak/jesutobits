import {
  ErrorCodes,
  isJesutobitsError,
  type RiskClass,
  type ToolError,
} from "@jesutobits/protocol";
import type { WorkspaceService } from "@jesutobits/services";
import { prohibitedReason, type ProhibitedPlaces } from "../../permissions/prohibited.js";
import { isSecretPatternFile } from "../../permissions/secret-patterns.js";
import { toolError, type ToolResult } from "./types.js";

/** How a path a tool wants to touch classifies (SECURITY.md sections 4.1, 5.2 and 6.2). */
export interface PathCheck {
  /** Project-relative, `/` separated; the input itself when it could not be resolved. */
  relative: string;
  classes: RiskClass[];
  /** Set when the path is never allowed, with the reason shown to the user and the model. */
  prohibited?: string;
}

/**
 * Resolves a path for classification without touching the file. A path that leaves the
 * workspace, directly or through a link, is `outside_workspace` (always denied); a
 * malformed one is prohibited with the guard's reason.
 */
export async function checkPath(
  ctx: { workspace: WorkspaceService; prohibited: ProhibitedPlaces },
  input: string,
  base: RiskClass,
): Promise<PathCheck> {
  try {
    const resolved = await ctx.workspace.resolve(input);
    const classes: RiskClass[] = [base];
    if (base === "read" && isSecretPatternFile(resolved.relative)) classes.push("sensitive_read");
    const prohibited = prohibitedReason(resolved.real, ctx.prohibited);
    return { relative: resolved.relative, classes, ...(prohibited && { prohibited }) };
  } catch (error) {
    if (isJesutobitsError(error) && error.code === ErrorCodes.fsOutsideWorkspace) {
      return { relative: input, classes: [base, "outside_workspace"] };
    }
    const reason = isJesutobitsError(error) ? error.message : "The path is not valid";
    return { relative: input, classes: [base], prohibited: reason };
  }
}

/** Maps a service error to the ToolError the model receives (AGENT_HARNESS.md section 5.2). */
export function toToolError(error: unknown): ToolError {
  if (!isJesutobitsError(error)) {
    return { code: "internal", message: "The tool failed unexpectedly", retryable: false };
  }
  const code: ToolError["code"] = (() => {
    switch (error.code) {
      case ErrorCodes.fsNotFound:
        return "not_found";
      case ErrorCodes.fsOutsideWorkspace:
        return "outside_workspace";
      case ErrorCodes.fsConflict:
        return "stale_read";
      case ErrorCodes.fsAlreadyExists:
      case ErrorCodes.fsNotEmpty:
        return "conflict";
      case ErrorCodes.fsTooLarge:
        return "too_large";
      case ErrorCodes.fsInvalidPath:
      case ErrorCodes.fsNotAFile:
      case ErrorCodes.fsNotADirectory:
      case ErrorCodes.fsBinary:
      case ErrorCodes.fsInvalidQuery:
        return "invalid_input";
      case ErrorCodes.fsPermissionDenied:
        return "permission_denied";
      default:
        return "internal";
    }
  })();
  return {
    code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details && { details: error.details }),
  };
}

/** A failed tool result from a thrown service error. */
export function errorResult(error: unknown): ToolResult {
  const mapped = toToolError(error);
  return toolError(mapped.code, mapped.message, {
    retryable: mapped.retryable,
    ...(mapped.details && { details: mapped.details }),
  });
}
