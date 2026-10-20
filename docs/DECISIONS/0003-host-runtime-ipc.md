# ADR-0003: Host to runtime IPC: JSON-RPC 2.0 over stdio, relayed by the Host

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related:** ADR-0001, ADR-0002, docs/ARCHITECTURE.md section 6

## Context

Three parties need to talk: the **Workbench** (React UI in the webview), the **Host** (Tauri Rust core) and the **Runtime** (Node sidecar). The runtime streams a lot of data (tokens, tool events, process output). The Workbench renders untrusted content (model output, file contents, extension UI), so it is the most exposed component.

## Decision

1. **Transport:** JSON-RPC 2.0 messages, one per line (NDJSON), over the runtime's stdin and stdout. Stderr carries only unstructured diagnostic text, which the Host writes to the runtime log file.
2. **Topology:** the Workbench never talks to the runtime directly. It calls the Host with `invoke('rpc_call', ...)` and receives runtime notifications through a Tauri `Channel`. The Host relays.
3. **The Host enforces an allowlist** of runtime methods the Workbench may call. The Host parses only the envelope (`jsonrpc`, `id`, `method`); payloads stay opaque to Rust, except for `host.*` methods the Host implements itself.
4. **Reverse calls:** the runtime may call the Host for a small set of privileged services, all under the `host.` prefix: `host.secrets.get`, `host.log` and `host.notify` (OS notification when an approval is waiting and the window is unfocused). The Host rejects any other `host.*` method. Folder pickers and PTYs are Workbench-to-Host features and never go through the runtime.
5. **Schemas live in `packages/protocol`** as Zod schemas. Both the runtime and the Workbench validate every message they receive. Rust uses `serde` types only for the `host.*` methods.
6. **Versioning:** `initialize` carries `protocolVersion` (semver). Major mismatch fails the handshake with a clear error.
7. **Limits:** a single message may not exceed 4 MiB. Larger payloads (big files, long logs) are paged by the method's own `offset`/`limit` parameters, never by fragmenting messages.

### Message shapes

```jsonc
// Workbench -> Host -> Runtime (request)
{"jsonrpc":"2.0","id":"w-118","method":"agent.sendMessage",
 "params":{"sessionId":"s_01J9...","text":"Make the hero button bigger",
           "attachments":[{"kind":"selectedElement","selectionId":"sel_7"}]}}

// Runtime -> Host -> Workbench (notification, streamed on a Channel)
{"jsonrpc":"2.0","method":"event",
 "params":{"seq":5521,"type":"tool.started","sessionId":"s_01J9...",
           "turnId":"t_14","callId":"c_3","tool":"edit_file",
           "category":"editing","summary":"Editing src/components/Hero.tsx",
           "ts":"2026-10-19T21:04:11.201Z"}}

// Runtime -> Host (reverse request)
{"jsonrpc":"2.0","id":"r-9","method":"host.secrets.get",
 "params":{"ref":"provider:openrouter:default"}}
```

Event notifications carry a monotonically increasing `seq` per runtime process. The Workbench uses `seq` to detect gaps and calls `events.replay({ sinceSeq })` to recover (the runtime keeps a 10,000-event ring buffer and persists turn-level events to SQLite).

## Alternatives considered

| Option | Why not |
|---|---|
| Workbench connects to a localhost WebSocket served by the runtime | Opens a port any local process can probe, needs token auth, and bypasses the Host's allowlist. Kept as a fallback if relay latency becomes a problem. |
| Tauri shell plugin with `Command.sidecar` from JavaScript | Puts process control in the most exposed component and requires broad shell capabilities in the webview. |
| gRPC or Cap'n Proto | Extra tooling for no real gain at this message rate. |
| Length-prefixed binary frames | Harder to debug. NDJSON is safe because JSON escapes newlines inside strings. |

## Trade-offs

- Every message crosses the Rust relay. Expected overhead is well under 1 ms per message. NFR-006 sets the budget and Spike S1 measures it. **Measured (2026-10-20, `docs/spikes/S1.md`):** the relay adds about 0.25 ms per 1 KB round trip at p50, even in a debug build. Tauri's own webview IPC costs 3 to 4 ms per `invoke` round trip on WebView2, so Workbench code must avoid chatty call patterns; streams already use Channels. Channel (event) latency under token streaming is still to be measured in Phase 2.
- The Host must stay dumb about payloads, or we end up duplicating the protocol in Rust. The allowlist is a list of method names, nothing more.

## Consequences

- The runtime can be driven by a pure Node test harness over pipes, which makes integration tests independent of Tauri (see TESTING_STRATEGY.md).
- Adding a Workbench-callable runtime method requires two changes: the schema in `packages/protocol` and the allowlist in the Host. A unit test fails if they drift.
- Logs on stdout would corrupt the protocol. The runtime's logger writes to its own log file and stderr only. A lint rule bans `console.log` in `packages/runtime`.

## Revisit when

Relay latency for token streaming exceeds the NFR-006 budget on the reference machine, or a second client (for example a CLI) needs to attach to a running runtime.
