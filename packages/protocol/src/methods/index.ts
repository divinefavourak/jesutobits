import type { z } from "zod";
import type { Caller, MethodDefinition } from "./define.js";
import { runtimeInitialize, runtimePing, runtimeShutdown } from "./runtime.js";

export { defineMethod } from "./define.js";
export type { Caller, MethodDefinition } from "./define.js";
export { runtimeInitialize, runtimePing, runtimeShutdown } from "./runtime.js";

/** Every runtime method. Adding one here is step one of ADR-0003's "two changes" rule. */
export const METHODS = {
  [runtimeInitialize.name]: runtimeInitialize,
  [runtimePing.name]: runtimePing,
  [runtimeShutdown.name]: runtimeShutdown,
} as const;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;

/** Methods the Workbench may call through the Host relay. */
export type WorkbenchMethod = {
  [M in MethodName]: "workbench" extends (typeof METHODS)[M]["callers"][number] ? M : never;
}[MethodName];

export function getMethod(name: string): MethodDefinition | undefined {
  return Object.hasOwn(METHODS, name) ? METHODS[name as MethodName] : undefined;
}

export function methodsCallableBy(caller: Caller): MethodName[] {
  return (Object.keys(METHODS) as MethodName[])
    .filter((name) => (METHODS[name].callers as readonly Caller[]).includes(caller))
    .sort();
}
