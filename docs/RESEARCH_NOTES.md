# Research Notes: Verified Facts

> Status: Living document. Last verified: 19 October 2026.
> Purpose: keep **verified technical facts** separate from **architectural recommendations**. Every other document may cite an entry here by its ID (for example `RN-04`). If a fact here changes, update the entry and re-check the documents that cite it.

Rules for this file:

- An entry states what an external source says, with a link. It does not recommend anything.
- Recommendations live in the ADRs (`docs/DECISIONS/`) and the design documents.
- Entries marked **Unverified** are working assumptions that still need a spike or a better source. They are listed so nobody mistakes them for facts.

---

## Tauri

| ID | Fact | Source |
|---|---|---|
| RN-01 | Tauri 2 has an official guide for running a Node.js app as a **sidecar**: the Node app is packaged into a self-contained binary so end users do not need Node installed. The guide uses `pkg` as its packaging example. | https://v2.tauri.app/learn/sidecar-nodejs/ |
| RN-02 | Sidecars are declared under `bundle.externalBin` in `tauri.conf.json`. Each binary must exist with a **target-triple suffix** (for example `my-sidecar-x86_64-pc-windows-msvc.exe`). Running a sidecar from the webview requires a `shell:allow-execute` (or spawn) capability entry with `"sidecar": true`. | https://v2.tauri.app/develop/sidecar |
| RN-03 | Tauri does **not** kill a sidecar's descendants for you. Killing the direct child on Windows (`TerminateProcess`) leaves grandchildren running. Kill-on-exit is the app's responsibility. | Community lifecycle notes (https://claudskills.com/skills/tauri-sidecar-lifecycle/SKILL.md); consistent with Windows process semantics. **Observed in Spike S1 (2026-10-20):** with the job object disabled, force-killing a Tauri 2.12.4 Host left its runtime child and that child's grandchild running in 3 of 3 trials (the Host spawns the runtime with `tokio::process`, not the shell plugin). |
| RN-04 | Current Tauri releases are on the 2.x line (2.11.x through mid 2026, 2.12 by September 2026). A Tauri 3.0 alpha line exists. | https://tauri.app/release/tauri/ ; https://github.com/tauri-apps/tauri/releases |
| RN-05 | **CVE-2026-42184**: in Tauri 2.0 to 2.11.0, `is_local_url()` could classify remote URLs as trusted local origins on Windows and Android, because Tauri maps custom schemes to `http://<scheme>.localhost/` there. Fixed in 2.11.1 (and backported to 2.10.3). | https://fieldguide.lutrasecurity.com/CVE-2026-42184/ ; GHSA-7gmj-67g7-phm9 |
| RN-06 | **CVE-2024-35222**: remote-origin iframes could reach Tauri IPC without being allowed in capabilities. Patched in 2.0.0-beta.20 by an invoke key that blocks IPC from frames the Tauri core did not initialise. The key is explicitly **not** a defence against a compromised main webview. Spike S3 shows the key does not stop a cross-origin iframe that Tauri itself initialised from reaching the capability check (RN-37). | https://www.kodemsecurity.com/cve-archive/cve-2024-35222 |
| RN-07 | Multiple webviews in one window (`Window::add_child`, `WebviewBuilder`) are only available behind Tauri's **`unstable`** cargo feature. | https://docs.rs/tauri/2.12.0/tauri/ |
| RN-08 | Official `tauri-driver` WebDriver testing supports **Windows and Linux only** on desktop. macOS is unsupported because there is no WKWebView driver. Third-party options (WebdriverIO embedded provider, CrabNebula driver) claim macOS support. | https://v2.tauri.app/develop/tests/webdriver/ ; https://webdriver.io/docs/desktop-testing/tauri/platform-support |
| RN-09 | Tauri uses the OS webview: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux. Rendering differs between them, and WebKitGTK is the most frequent source of quirks. | https://capawesome.io/docs/blog/electron-vs-tauri-for-capacitor-apps/ (secondary; consistent with Tauri docs) |
| RN-10 | An official Stronghold plugin exists (`tauri-plugin-stronghold` 2.3.x). There is no official OS-keychain plugin; community plugins exist. The Rust `keyring` crate (v3) supports Windows Credential Manager, macOS Keychain and Linux Secret Service, with explicit feature flags. | https://docs.rs/tauri-plugin-stronghold ; https://docs.rs/crate/keyring/latest |

## Node.js

| ID | Fact | Source |
|---|---|---|
| RN-11 | Node.js **Single Executable Applications (SEA)** are at Stability 1.1 (Active development). `--build-sea` was added in v25.5.0. Native addons cannot load from the SEA virtual file system and must be written to a temp file then loaded with `process.dlopen()`. CI coverage: Windows, macOS arm64 only (x64 skipped), most Linux. | https://nodejs.org/dist/latest/docs/api/single-executable-applications.html |
| RN-12 | The original `vercel/pkg` project is archived. `@yao-pkg/pkg` is the maintained fork. | https://github.com/yao-pkg |
| RN-13 | `node:sqlite` is at Stability **1.2 (Release candidate)** in the Node 25/26 docs. Node 24 is the first line where it runs without an experimental warning. Known defects: TEXT values truncated at embedded NUL in Node 22.23.x, 24.15.0, 25.9.0 and 26.0.0 (fixed in 24.16.0 and 26.1.0); CVE-2026-58041 affects `createTagStore()` iterators up to 24.18.0 and 26.5.0. | https://nodejs.org/api/sqlite.html ; https://docs.openclaw.ai/install/node-compatibility ; https://stack.watch/vuln/CVE-2026-58041/ |
| RN-14 | Release schedule: Node 24 leaves Active LTS on 20 Oct 2026 (EOL April 2028). **Node 26 enters Active LTS on 28 Oct 2026** (EOL April 2029). From Node 27 there is one major release per year and every release becomes LTS. | https://ecorpit.com/nodejs-development-company/ (cites the Release WG schedule); https://infoq.com/news/2026/06/nodejs-release-changes |
| RN-15 | Corepack is **no longer bundled** from Node 25. It must be installed separately, or pnpm installed directly. | https://blog.openreplay.com/manage-package-managers-node-corepack/ |
| RN-16 | Since the April 2024 security release (CVE-2024-27980), `child_process.spawn` on Windows throws `EINVAL` when given a `.bat` or `.cmd` file without `shell: true`. This affects `npm.cmd`, `pnpm.cmd`, `npx.cmd`. | https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 |
| RN-17 | The Node **Permission Model** (`--permission`, `--allow-fs-read`, `--allow-fs-write`, `--allow-child-process`) is Stability 2 (Stable) in current docs. Permissions can be dropped at runtime with `process.permission.drop()` but not added. | https://nodejs.org/api/permissions.html |

## React, Vite and source mapping

| ID | Fact | Source |
|---|---|---|
| RN-18 | React 19 removed `fiber._debugSource` (PR #28265). React 19 exposes `fiber._debugStack`, which some tools resolve through source maps to recover JSX call sites. | https://github.com/facebook/react/issues/29092 ; https://github.com/shaojie-li/web-source-inspect/wiki |
| RN-19 | Current React is 19.2.x (19.2.7 as of June 2026). No React 20 release exists. | https://github.com/facebook/react/releases |
| RN-20 | Babel-plugin based inspectors (for example `@react-dev-inspector/babel-plugin`) add `data-inspector-*` attributes to DOM elements at build time. This is described by its users as the reliable way to get source locations across React versions. | https://github.com/uxfreak/react-context-mcp |
| RN-21 | Onlook (open-source visual editor for Next.js + Tailwind) injects a `data-oid` attribute into JSX at build time and maintains a map from IDs to code locations. It displays the app in an iframe and edits both the iframe and the code. | https://github.com/onlook-dev/onlook ; https://blog.logrocket.com/onlook-react-visual-editor |
| RN-22 | **Vite 8** (stable March 2026) uses Rolldown and Oxc. `@vitejs/plugin-react` v6 requires Vite 8 and **removed its Babel option**; Babel plugins now need `@rolldown/plugin-babel`. | https://vite.dev/blog/announcing-vite8 ; plugin-react 6.0.0 changelog |
| RN-23 | Vite's `createServer(inlineConfig)` accepts any user config plus `configFile`. If `configFile` is not set, Vite resolves the project's config file automatically. The docs do **not** spell out how inline `plugins` combine with the file's plugins. | https://vite.dev/guide/api-javascript |
| RN-24 | **Verified in Spike S2 (Vite 8.3.4).** Inline config plugins are concatenated with config-file plugins, **after** them (even among `enforce: "pre"` plugins). Originally stated: inline config plugins are concatenated with config-file plugins (Vite's `mergeConfig` concatenates arrays). Must be confirmed in Spike S2 before the preview launcher depends on it. | Source reading needed |

## Model provider (OpenRouter)

| ID | Fact | Source |
|---|---|---|
| RN-25 | OpenRouter's Chat Completions API is OpenAI-compatible with normalised schemas. Tool calling uses the `tools` field. Models that support tools can be listed with `GET /api/v1/models?supported_parameters=tools`; each model lists `supported_parameters` (for example `tools`, `tool_choice`, `structured_outputs`). | https://openrouter.ai/docs/api-reference/overview ; https://openrouter.ai/docs/guides/overview/models |
| RN-26 | Streaming uses SSE. OpenRouter sends comment lines such as `: OPENROUTER PROCESSING` that must be skipped before `JSON.parse`. A final chunk carries `usage`, and repeats `finish_reason`. | https://openrouter.ai/docs/api_reference/streaming |
| RN-27 | Errors before the response is committed come back as JSON with an HTTP status (400, 401, 402 insufficient credits, 429, 502, 503). Errors after commit arrive as an SSE event with a top-level `error` and `finish_reason: "error"`, and the stream then ends. A 200 can contain only an error event. Every provider error carries a canonical `error_type`. | https://openrouter.ai/docs/api/errors |
| RN-28 | Aborting the connection cancels a streaming request and stops billing **only for supported providers**. For others, the model keeps running and is billed in full. | https://openrouter.ai/docs/api_reference/streaming |

## Animation (companion)

| ID | Fact | Source |
|---|---|---|
| RN-29 | Rive runtimes are open source under MIT. The Rive editor is free to use, but **exporting `.riv` files for runtime requires a paid plan**. | https://rive.app/docs/editor/exporting/exporting-for-runtime ; https://rive.app/blog/rive-s-new-9-mo-plan |
| RN-30 | `@lottiefiles/dotlottie-web` supports state machines (`stateMachineLoad`, `stateMachineStart`, `stateMachineSetBooleanInput`, and so on). Its docs label the state machine API experimental and say it will change. It loads a WASM module, which needs CSP allowance (`wasm-unsafe-eval`) and should be self-hosted. | https://developers.lottiefiles.com/docs/dotlottie-player/dotlottie-web/interactivity ; https://github.com/LottieFiles/dotlottie-web/wiki/CSP-and-WASM-Self%E2%80%90Hosting-Guide |
| RN-31 | `lottie-web` evaluates Lottie **expressions with `eval`**. A malicious Lottie file can run JavaScript. The maintainers recommend the "light" build or disabling expressions for untrusted files. | https://lightrun.com/answers/airbnb-lottie-web-xss-vulnerability ; https://docs.lottiefiles.com/en/tools/relottie/ecosystem/security.md |

## Editors, standards, protocols

| ID | Fact | Source |
|---|---|---|
| RN-32 | Monaco requires web workers for language services and is several MB; CodeMirror 6 is modular and much smaller. Replit and Sourcegraph migrated from Monaco to CodeMirror for size and customisation reasons. | https://blog.repl.it/codemirror ; https://webflow.sourcegraph.com/blog/migrating-monaco-codemirror |
| RN-33 | `AGENTS.md` is an open Markdown convention for instructing coding agents, supported by many agents; nested files are allowed in monorepos. | https://infoq.com/news/2025/08/agents-md/ |
| RN-34 | The current Model Context Protocol revision is **2026-07-28**, which made the protocol core stateless. | https://github.com/modelcontextprotocol/specification/releases/tag/2026-07-28 |

## Tooling

| ID | Fact | Source |
|---|---|---|
| RN-35 | `typescript-eslint` 8.72.0 declares peer dependencies `typescript: ">=4.8.4 <6.1.0"` and `eslint: "^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0"`. TypeScript 7.0.2 (the native compiler) is the latest TypeScript; 6.0.3 is the latest 6.x. Checked 20 October 2026. | npm registry metadata (`npm view typescript-eslint@8.72.0 peerDependencies`; `npm view typescript versions`) |
| RN-36 | pnpm 11 refuses versions younger than `minimumReleaseAge` (minutes). When a requested range can only be met by such a version, `pnpm install` writes `minimumReleaseAgeExclude` entries into `pnpm-workspace.yaml` unless `minimumReleaseAgeStrict` is set. It also refuses dependency build scripts until they are listed under `allowBuilds` (`ERR_PNPM_IGNORED_BUILDS`). Observed with pnpm 11.15.1. | Observed behaviour, 20 October 2026; https://pnpm.io/settings |

## Webview and preview (observed in spikes)

| ID | Fact | Source |
|---|---|---|
| RN-37 | In Tauri 2.12.4 on Windows (WebView2 155), a cross-origin `http://127.0.0.1:<port>` iframe in the main webview has `window.__TAURI_INTERNALS__` (with `invoke`) and `window.chrome.webview`. Its `invoke` calls reach the capability check and are refused: "`<command>` not allowed on window "main", webview "main", URL: http://127.0.0.1:5899/ … allowed on: [windows: "main", URL: local]". That held for app commands and `core:default` plugin commands, with the Workbench on `http://127.0.0.1:1420`, `http://tauri.localhost` and `https://tauri.localhost`. | Spike S3, 20 October 2026 (`scripts/spikes/s3-run.mjs`, `docs/spikes/S3.md`) |
| RN-38 | In WebView2 155, an `https://tauri.localhost` page (`useHttpsScheme: true`) loads an `http://127.0.0.1:<port>` iframe and exchanges `postMessage` with it; no mixed-content blocking. Consistent with Chromium treating loopback origins as potentially trustworthy. | Spike S3, 20 October 2026 |
| RN-39 | In `@vitejs/plugin-react` 6.1.2, the `vite:react-babel` plugin (`enforce: "pre"`) has no `transform` hook; it configures Vite core's Oxc JSX transform (`oxc.jsx`), so JSX is compiled after every `pre` plugin. The package does not export `./package.json`. | `node_modules/@vitejs/plugin-react/dist/index.js`, read in Spike S2, 20 October 2026 |

## Open verification items (owned by spikes)

| Item | Owner | Needed before |
|---|---|---|
| ~~Inline Vite plugins merge with project plugins (RN-24)~~ Done: they merge, appended after the project's (`docs/spikes/S2.md`) | Spike S2 | Phase 5 |
| Whether `http://localhost:<port>` iframes load without mixed-content issues inside each OS webview, including when the app uses the HTTPS custom scheme on Windows. **Windows done** (RN-38); WebKitGTK and WKWebView open | Spike S3 | Phase 4 |
| ~~Windows Job Object assignment of the sidecar from the Host, and grandchild cleanup on crash~~ Done: 0 orphans in 10 forced kills (`docs/spikes/S1.md`) | Spike S1 | Phase 2 |
| ~~Performance of `node:sqlite` with WAL on Windows under event-heavy sessions~~ Done: 10k rows in 0.2 to 0.9 s when batched in transactions; 2.1 to 2.5 s autocommitted (`docs/spikes/S1.md`) | Spike S1 | Phase 2 |
| `portable-pty` (Rust) ConPTY behaviour with PowerShell and `cmd.exe` | Phase 3 task | Phase 3 |
