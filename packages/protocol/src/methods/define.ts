import type { z } from "zod";

/**
 * Who may send a method. The Host allowlist (ADR-0003, decision 3) is generated from the
 * methods that list `workbench`. `host` methods are sent by the Host itself and are never
 * relayed from the Workbench.
 */
export type Caller = "host" | "workbench";

export interface MethodDefinition<
  Name extends string = string,
  Params extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
  Callers extends readonly Caller[] = readonly Caller[],
> {
  readonly name: Name;
  readonly description: string;
  /** Kept as a literal tuple so `WorkbenchMethod` is exact at the type level. */
  readonly callers: Callers;
  readonly params: Params;
  readonly result: Result;
}

export function defineMethod<
  const Name extends string,
  Params extends z.ZodType,
  Result extends z.ZodType,
  const Callers extends readonly Caller[],
>(
  definition: MethodDefinition<Name, Params, Result, Callers>,
): MethodDefinition<Name, Params, Result, Callers> {
  return definition;
}
