import { z } from "zod";
import { RuntimeSettingsSchema } from "../settings.js";
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
    /**
     * Startup stages in milliseconds since the runtime process started, logged by the Host
     * to explain slow starts (NFR-001, NFR-002).
     */
    startup: z
      .object({
        /** Node finished its own bootstrap (`performance.nodeTiming.bootstrapComplete`). */
        nodeBootstrapMs: z.number().nonnegative(),
        /** The runtime bundle finished evaluating and `main` started. */
        mainStartMs: z.number().nonnegative(),
        /** `runtime.initialize` arrived. */
        initializeReceivedMs: z.number().nonnegative(),
      })
      .optional(),
  }),
});

/**
 * The settings the runtime acts on (agent limits, the provider's default model and options,
 * privacy). The Host owns settings.json (ADR-0008), so it sends them after every handshake,
 * before reporting Ready, and again after every change. Until the first one arrives the
 * runtime uses the defaults.
 */
export const runtimeConfigure = defineMethod({
  name: "runtime.configure",
  description: "Settings the runtime acts on; sent by the Host on start and on every change.",
  callers: ["host"],
  params: z.object({
    settings: RuntimeSettingsSchema,
    /**
     * Jesutobits' own folders besides the data dir (config, logs). Agent tools may never
     * read or write them, even inside a project (SECURITY.md section 4.3).
     */
    appDirs: z.array(z.string().min(1)).max(10).default([]),
  }),
  result: z.object({}),
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
