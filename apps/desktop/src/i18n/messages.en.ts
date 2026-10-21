/**
 * English UI strings (NFR-020). Keys are stable IDs grouped by feature; values follow the
 * copy guidelines in UX_AND_INTERFACE.md section 11. `{name}` is a parameter; a plural is
 * an object of Intl.PluralRules categories with the count in `{count}`.
 */
export const en = {
  "app.name": "Jesutobits",
  "app.scaffold": "Workbench scaffold. Protocol {version}.",

  "runtime.status.starting": "Starting agent runtime…",
  "runtime.status.ready": "Ready",
  "runtime.status.degraded": "Agent runtime is slow to respond",
  "runtime.status.restarting": "Restarting agent runtime…",
  "runtime.status.failed": "Agent runtime stopped",
  "runtime.restart": "Restart runtime",

  "projects.openFolder": "Open folder…",
  "projects.openFolder.title": "Open folder",
  "projects.opened": "Opened {name} ({trust})",
  "projects.cancelled": "Cancelled",
  "projects.failed": "Failed: {reason}",

  "files.count": { one: "{count} file", other: "{count} files" },

  "diagnostics.roundTrip.title": "Round-trip latency",
  "diagnostics.roundTrip.scope":
    "Workbench to runtime and back, including the webview's own IPC. The Host relay's share is measured separately (docs/spikes/S1.md).",
  "diagnostics.roundTrip.run": "Measure 1,000 round trips (1 KB)",
  "diagnostics.roundTrip.running": "Measuring…",
} as const;

export type Messages = typeof en;
