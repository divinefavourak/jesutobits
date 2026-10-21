import { z } from "zod";

/**
 * Reverse calls: methods the runtime sends to the Host (ARCHITECTURE.md section 6.3). Like
 * runtime methods they are schemas first; `pnpm gen` lists them in methods.json and the
 * Host's allowlist, and the Host answers only these.
 */
export interface ReverseMethodDefinition<
  Name extends string = string,
  Params extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly description: string;
  readonly params: Params;
  readonly result: Result;
}

function defineReverseMethod<
  const Name extends string,
  Params extends z.ZodType,
  Result extends z.ZodType,
>(definition: ReverseMethodDefinition<Name, Params, Result>) {
  return definition;
}

/**
 * Moves a file or folder to the OS trash (ADR-0014). The runtime sends it only after
 * WorkspaceService confined the path; the Host checks again before acting.
 */
export const hostFsTrash = defineReverseMethod({
  name: "host.fs.trash",
  description: "Move a confined project path to the OS trash.",
  params: z.object({
    /** Absolute path inside a workspace root. */
    path: z.string().min(1),
  }),
  result: z.object({}),
});

/**
 * Opens the OS file manager with a path selected (ADR-0014, same split as the trash). The
 * runtime confined the path; the Host checks it is absolute and exists.
 */
export const hostOsReveal = defineReverseMethod({
  name: "host.os.reveal",
  description: "Show a confined project path in the OS file manager.",
  params: z.object({
    /** Absolute path inside a workspace root. */
    path: z.string().min(1),
  }),
  result: z.object({}),
});

export const REVERSE_METHODS = {
  [hostFsTrash.name]: hostFsTrash,
  [hostOsReveal.name]: hostOsReveal,
} as const;

export type ReverseMethod = keyof typeof REVERSE_METHODS;
export type ReverseParams<M extends ReverseMethod> = z.input<(typeof REVERSE_METHODS)[M]["params"]>;
export type ReverseResult<M extends ReverseMethod> = z.output<
  (typeof REVERSE_METHODS)[M]["result"]
>;
