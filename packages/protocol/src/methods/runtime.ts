import { z } from "zod";
import { SEMVER_PATTERN } from "../version.js";
import { defineMethod } from "./define.js";

const SemverSchema = z.string().regex(SEMVER_PATTERN, "Expected a semver version");

/**
 * Handshake. The Host sends it once, after assigning the runtime to its job object
 * (ADR-0011) and before relaying anything else. A major protocol mismatch fails with
 * `runtime.protocol_mismatch`.
 */
export const runtimeInitialize = defineMethod({
  name: "runtime.initialize",
  description: "Handshake: agree on the protocol version before any other call.",
  callers: ["host"],
  params: z.object({
    protocolVersion: SemverSchema,
    client: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
  }),
  result: z.object({
    protocolVersion: SemverSchema,
    runtimeVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
  }),
});

/** Health check. The Host pings every 5 s; the Workbench may ping to measure relay latency. */
export const runtimePing = defineMethod({
  name: "runtime.ping",
  description: "Health check and relay latency probe.",
  callers: ["host", "workbench"],
  params: z.object({
    /** Returned unchanged, so latency probes can measure realistic payload sizes both ways. */
    echo: z.string().max(65_536).optional(),
  }),
  result: z.object({
    uptimeMs: z.number().nonnegative(),
    echo: z.string().optional(),
  }),
});

/**
 * Graceful stop (ADR-0002): cancel the active turn, stop managed processes, flush storage,
 * reply, then exit with code 0. The Host kills the runtime if it has not exited within 5 s.
 */
export const runtimeShutdown = defineMethod({
  name: "runtime.shutdown",
  description: "Graceful stop; the runtime replies and then exits with code 0.",
  callers: ["host"],
  params: z.object({}),
  result: z.object({}),
});
