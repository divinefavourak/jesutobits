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
> {
  readonly name: Name;
  readonly description: string;
  readonly callers: readonly Caller[];
  readonly params: Params;
  readonly result: Result;
}

export function defineMethod<
  const Name extends string,
  Params extends z.ZodType,
  Result extends z.ZodType,
>(definition: MethodDefinition<Name, Params, Result>): MethodDefinition<Name, Params, Result> {
  return definition;
}
