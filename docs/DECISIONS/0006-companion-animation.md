# ADR-0006: Companion animation technology

- **Status:** Accepted (provisional)
- **Date:** 2026-10-19
- **Related:** RN-29, RN-30, RN-31, docs/COMPANION_SYSTEM.md

## Context

The companion animates according to real runtime states (idle, thinking, editing, waiting for approval, and so on). Companion skins are third-party content, so their asset formats are part of the extension security surface. Candidates are **Rive** and **Lottie**.

Facts:

- Rive has a mature runtime state machine and small binary files. Its runtimes are MIT. **Exporting `.riv` for runtime requires a paid editor plan** (RN-29), which raises the bar for community skin authors.
- Lottie is an open JSON format with many authoring tools. `dotlottie-web` renders via a WASM engine and has a state machine API that its own docs call experimental (RN-30).
- `lottie-web` evaluates Lottie expressions with `eval` (RN-31). A skin file must never be able to run code.

## Decision

1. **The state machine belongs to Jesutobits, not to the animation file.** The Workbench's `CompanionController` computes the current companion state from runtime events. A skin only maps each state to a *clip*. This keeps the runtime and the state logic independent of any animation library.
2. Renderers implement one interface, `CompanionRenderer`. MVP ships two:
   - **StaticRenderer**: one SVG or PNG per state plus CSS transitions. Always available. Used for reduced motion and as fallback.
   - **LottieRenderer** using `@lottiefiles/dotlottie-web` with its WASM file self-hosted. Clips are addressed by **marker name** inside a `.lottie` or by separate animation IDs. Jesutobits does not use the dotLottie state machine API in MVP.
3. `lottie-web` is **not** used anywhere, because of expression evaluation (RN-31).
4. **RiveRenderer** is a post-MVP addition (Phase 6 stretch or later). Rive skins map states to state machine inputs. It is worth adding for expressive, interactive companions once the extension format is stable.
5. The default built-in companion is a subtle, abstract mark (not a character) drawn as SVG with a dotLottie variant for motion. It must look professional when static.

## Alternatives considered

| Option | Assessment |
|---|---|
| Rive first | Best runtime interactivity and file size. Rejected as the first format because authors need a paid plan to export, and our skins should be easy to make. |
| dotLottie state machines as the source of truth | Would move our state logic into skin files and couple us to an API marked as changing. |
| CSS/SVG only | Simplest and safest, but too limited for character skins. Kept as the fallback renderer. |
| Video (WebM) clips | Easy to author, heavy, no smooth state blending, transparency support varies by webview. |

## Trade-offs

- Lottie files can be large. The validator caps package size and frame rate (EXTENSION_SYSTEM.md section 7).
- Without state-machine blending, transitions between clips are cross-fades or designed "transition" clips. Acceptable for a subtle companion.
- WASM requires `wasm-unsafe-eval` in the Workbench CSP. It is scoped to the companion feature's worker if possible; otherwise it applies to the main document and is noted in SECURITY.md.

## Consequences

- Skin manifests declare `renderer: "static" | "lottie"` (and later `"rive"`). Unknown renderers fail validation with a clear message.
- The companion can be fully disabled, which unloads the renderer and its WASM.

## Revisit when

Rive changes its export licensing, or user research shows that expressive skins are a primary reason people choose Jesutobits, or dotLottie state machines are declared stable.
