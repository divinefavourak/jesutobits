# ADR-0010: Preview isolation

- **Status:** Accepted (provisional, confirmed by Spike S3)
- **Date:** 2026-10-19
- **Related:** ADR-0001, ADR-0009, RN-05, RN-06, RN-07, docs/VISUAL_EDITING.md, docs/SECURITY.md

## Context

The preview shows the user's app, running on a local dev server, inside the Jesutobits window. That app is **untrusted code**: the user may have opened a cloned repository, and the agent may have written code influenced by prompt injection. The preview must not be able to call Tauri IPC, read the Workbench DOM, read secrets, or approve actions.

The agent also needs to inspect the running app (console errors, failed requests, screenshots) to verify its work, independent of what the user is looking at.

## Decision

### User-facing preview

1. The preview is a **cross-origin `<iframe>`** in the Workbench pointing at `http://127.0.0.1:<port>/`. Not a Tauri child webview (unstable, RN-07).
2. The dev server binds to `127.0.0.1` only, never `0.0.0.0`.
3. The Workbench capabilities in Tauri grant IPC only to the app's own origin. No capability lists `localhost` or `127.0.0.1` as a remote origin. Tauri's invoke key blocks IPC from sub-frames (RN-06). We keep Tauri patched for origin-confusion bugs (RN-05).
4. iframe attributes: `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"` (the app keeps its own origin, which it needs for storage and HMR; it is still cross-origin to the Workbench). `allow` (permissions policy) is empty by default: no camera, microphone, geolocation, clipboard-read. `referrerpolicy="no-referrer"`.
5. Workbench CSP: `frame-src http://127.0.0.1:* http://localhost:*`. Nothing else may be framed.
6. Shell ↔ preview communication uses `window.postMessage` with: an exact origin check on both sides, a per-preview-session random `nonce` delivered to the bridge through the dev server plugin, and Zod validation of every message. The bridge can only **report** (selection, hover, layout, console summary) and **apply draft styles**. It cannot ask the Workbench to do anything privileged.
7. Everything the bridge reports is treated as untrusted data. When element text or attributes go into agent context, they are wrapped as untrusted content (AGENT_HARNESS.md section 4.5).
8. Popups and navigations away from the dev server origin open in the user's default browser, not inside Jesutobits.

### Agent-facing verification browser

9. The runtime drives a **separate headless browser** through `playwright-core`, preferring an installed Chromium-family browser (Edge on Windows via `channel: "msedge"`, Chrome elsewhere) and offering an on-demand download otherwise. It loads the same dev server URL in an isolated, throwaway profile.
10. This browser collects console errors, failed requests, DOM text snapshots and screenshots for the `check_preview` tool. It never receives Jesutobits credentials or the user's browser profile.

## Alternatives considered

| Option | Why not |
|---|---|
| Tauri child webview for the preview | Better process isolation, but behind `unstable` (RN-07) and harder to overlay UI on. Revisit if the iframe approach fails Spike S3. |
| Proxy the dev server through a Jesutobits custom protocol | Lets us rewrite headers and inject the bridge, but breaks HMR WebSockets and adds complexity. Kept as fallback for mixed-content problems. |
| Use the user-facing iframe for agent verification | Couples verification to what the user is doing and to the OS webview engine. |
| Open previews only in an external browser | Loses the visual-editing experience, which is a defining feature. |

## Trade-offs

- `allow-same-origin` plus `allow-scripts` lets the framed app use its own origin's storage. This is safe because the frame is cross-origin to the Workbench. It would be unsafe if the preview were ever served from the Workbench's origin, so the Host must never serve user project files from the app protocol.
- Two browsers (user-facing webview and headless) can disagree on rendering. The timeline labels screenshots with the engine used.

## Consequences

- Spike S3 must confirm `http://127.0.0.1` frames load inside each OS webview when the Workbench origin is `http://tauri.localhost` (Windows default) or `tauri://localhost` (macOS/Linux), and record behaviour if `useHttpsScheme` is enabled.
- Preview sessions are bound to a project. Closing a project stops its dev server.

## Revisit when

Spike S3 finds mixed-content or cookie problems that the proxy fallback cannot fix, or a real attack path from the preview to the Workbench is found.
