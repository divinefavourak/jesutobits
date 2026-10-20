# ADR-0001: Desktop framework: Tauri 2 over Electron

- **Status:** Accepted (provisional)
- **Date:** 2026-10-19
- **Related:** ADR-0002, ADR-0003, ADR-0010, RN-01 to RN-09

## Context

Jesutobits needs a desktop shell that hosts a React UI, manages a long-running agent runtime written in TypeScript, embeds live previews of user web apps, and enforces a strong security boundary between the UI, the runtime, previews and extensions.

The two realistic options are Tauri 2 (Rust core, OS webview) and Electron (bundled Chromium and Node.js).

Facts that shape the decision:

- Tauri does not ship Node.js. Our runtime is Node, so Tauri means shipping Node ourselves as a sidecar (RN-01, RN-02). That removes much of Tauri's bundle-size advantage.
- Tauri uses three different webview engines (RN-09). The preview of a user's app renders in WebKit on macOS and Linux, Chromium on Windows.
- Electron gives one Chromium everywhere and direct DevTools Protocol access to an embedded preview, which helps inspection and screenshots.
- Tauri's capability system lets us declare exactly which commands each webview may call, which matters because the Workbench renders model output and extension content.
- Multi-webview layouts in Tauri are behind the `unstable` feature (RN-07).
- The first development machine is Windows, where Tauri uses WebView2 (Chromium).

## Decision

Use **Tauri 2** (latest 2.x patch, at least 2.11.1 for RN-05) as the desktop shell, with these guardrails:

1. The Workbench UI talks to the Host only through a thin `HostBridge` TypeScript interface. No component imports `@tauri-apps/api` directly.
2. The agent runtime never depends on Tauri. It speaks JSON-RPC over stdio (ADR-0003), so it can run under Electron, under a test harness, or headless.
3. Previews use a plain cross-origin iframe, not the unstable multi-webview API (ADR-0010).
4. Agent verification of previews uses a separate headless browser in the runtime (ADR-0010), so it does not depend on the shell's webview engine.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| **Electron** | Strongest fit for preview fidelity and inspection. Rejected for now because it gives weaker default isolation between UI and privileged code, larger idle memory, and the product preference is Tauri. It remains the documented fallback. |
| **Tauri with a Rust agent runtime** | Removes the Node sidecar, but loses the TypeScript ecosystem (Zod, provider SDKs, shared types with the UI) and would make the runtime much harder to build. |
| **Pure web app + local server** | No installable desktop experience, no OS keychain, weak process supervision. |
| **Electrobun / Bun-based shells** | Too young for a product whose core risk is process and security management. |

## Trade-offs

| Gains | Costs |
|---|---|
| Capability-based IPC permissions for the UI webview | We must package, start, supervise and update a Node binary (ADR-0002) |
| Lower idle memory than a second Chromium | Preview engine differs per OS (WebKit on macOS/Linux) |
| Rust Host is a good place for keychain access, Job Objects and PTYs | Team needs some Rust |
| Smaller attack surface in the shell | Desktop E2E automation is weaker on macOS (RN-08) |

## Consequences

- Installer size is driven by the bundled Node binary, not by Tauri. Budget: see NFR-005.
- Preview fidelity on macOS and Linux matches Safari-family engines. The preview toolbar offers "Open in browser" so users can check Chromium or Firefox.
- We must keep the `HostBridge` interface clean enough that an Electron host could implement it.
- We track Tauri security advisories and update patch versions promptly (RN-05, RN-06).
- Spike S1 (2026-10-20, `docs/spikes/S1.md`) found nothing against Tauri for sidecar lifecycle: handshake under 0.6 s, zero orphans with a job object, relay overhead under 1 ms. The sidecar work took about a day, far inside this ADR's two-week revisit trigger. Status stays provisional until Spike S3 (preview iframe) reports.

## Revisit when

Any of these is observed:

- Sidecar packaging, signing or lifecycle work exceeds two weeks of effort across Phases 0 to 2.
- Preview inspection features need engine capabilities WebKit does not provide, and the headless-browser workaround is not enough.
- macOS or Linux users report preview rendering differences as a top-three complaint after those platforms ship.
- Tauri 3 forces a migration whose cost approaches a move to Electron.

A move to Electron would replace `apps/desktop/src-tauri` and the `HostBridge` implementation. The runtime, protocol and most of the Workbench would stay.
