/**
 * Quoting for running a Windows `.cmd`/`.bat` shim through `cmd.exe /d /s /c` (ADR-0011,
 * RN-16), following cross-spawn's rules: each argument is quoted for the program's own
 * argument parser, then every cmd.exe metacharacter is escaped with `^`, twice.
 *
 * Twice, because a shim forwards its arguments with `%*` and cmd.exe parses them again inside
 * the batch file. cross-spawn escapes twice only for `node_modules/.bin` shims, but npm.cmd
 * and pnpm.cmd forward `%*` too: escaped once, an argument with a `"` flips cmd's quote state
 * in the second pass and a later `&` starts a new command (tested in process.test.ts).
 */

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCommand(command: string): string {
  return command.replace(META_CHARS, "^$1");
}

export function escapeArgument(argument: string): string {
  let arg = argument;
  // Backslashes before a double quote: double them, then escape the quote.
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Backslashes at the end will precede the closing quote: double them.
  arg = arg.replace(/(\\*)$/, "$1$1");
  arg = `"${arg}"`;
  return arg.replace(META_CHARS, "^$1").replace(META_CHARS, "^$1");
}

/** The full command line handed to `cmd.exe /d /s /c "<this>"`. */
export function cmdShimCommandLine(file: string, args: readonly string[]): string {
  return [escapeCommand(file), ...args.map(escapeArgument)].join(" ");
}
