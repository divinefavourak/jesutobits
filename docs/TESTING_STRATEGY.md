# Testing Strategy

> Status: Agreed. Applies from Phase 0. Tools per ADR-0013: Vitest, Playwright, cargo test, WebdriverIO + tauri-driver.

## 1. Principles

1. **No paid model calls in CI.** Every agent behaviour is testable with scripted model streams (NFR-016). Real-model evaluations are a separate, opt-in suite.
2. **Test at the boundary that owns the behaviour.** Permissions are tested in the broker, not through the UI. Path confinement is tested in `WorkspaceService`, not per tool.
3. **The runtime is testable without Tauri.** Integration tests spawn the bundled runtime with Node and talk JSON-RPC over pipes, exactly like the Host does (ADR-0003).
4. **The Workbench is testable without Tauri.** It runs in a browser against `MockHostBridge` or against a real runtime through a small Node relay.
5. **Failure paths are first-class.** Every failure listed in section 5 has at least one automated test.

## 2. Suites

| Suite | Scope | Tooling | Runs |
|---|---|---|---|
| Unit (TS) | Pure modules: policy engine, command classifier, path guard, context budgeting, compaction triggers, token estimation, Tailwind mapping, editability analysis, companion controller, theme compiler | Vitest | Every PR |
| Unit (Rust) | Method allowlist, secret refs, archive safety checks, settings migration, job object wrapper (Windows) | cargo test | Every PR |
| Protocol contract | Every JSON-RPC method and event schema round-trips; Host allowlist equals the set of Workbench-callable methods in `packages/protocol` | Vitest + a Rust test reading a generated method list | Every PR |
| Provider adapter | OpenRouter mapping of requests, SSE parsing (comments, tool-call fragments, usage chunk, mid-stream errors, `[DONE]`), error categorisation, retries | Vitest + mock HTTP server replaying recorded SSE fixtures | Every PR |
| Agent loop | Full turns driven by `ScriptedProvider` cassettes: tool sequencing, approvals, denials, limits, loop guard, compaction, verification labels, summaries | Vitest + runtime in-process | Every PR |
| Tool contracts | For each built-in tool: schema rejects bad input, path confinement, cancellation within 2 s, error mapping, output truncation | Vitest, temp project directories | Every PR |
| Tool permissions | Policy matrix (SECURITY.md 4.2) for every preset × risk class; prohibited list; rule matching; script fingerprint invalidation; agent-written-file flag | Vitest table tests | Every PR |
| File operations | Atomic writes, line endings and BOM preserved, stale-read detection, checkpoints and revert, symlink and junction escape attempts, reserved names | Vitest on real temp dirs (Windows CI covers junctions) | Every PR |
| Process supervisor | argv spawning, `.cmd` shims on Windows, env allowlist, timeouts, tree kill, orphan ledger reaping | Vitest + `fixtures/bin/fake-cmd.mjs` | Every PR (Windows and Linux runners) |
| Preview manager | Adapter detection, port allocation, collision retry, readiness probing, crash detection, log ring buffer | Vitest + fake dev server script; one real Vite fixture | Every PR (fake), nightly (real) |
| Visual editing (transform) | Vite plugin instrumentation golden tests (input `.tsx` → output with attributes and valid source map); `SourceTransformer` edits produce minimal diffs | Vitest snapshot tests | Every PR |
| Visual editing (E2E) | Real `vite-react-tailwind` fixture in a browser: select, draft, apply, HMR, re-select, undo | Playwright (Chromium and WebKit) | Nightly and before release |
| Extension validation | Every rule in EXTENSION_SYSTEM.md section 7 with a malformed fixture package | Vitest | Every PR |
| Extension permissions | Stage 1: kinds cannot request permissions; Host serves only manifest files. Stage 2 (later): broker denies ungranted calls from sandboxed iframes | Vitest; Playwright for Stage 2 | Every PR |
| Companion | Controller state tables, truthfulness property test, reduced motion | Vitest (+ fast-check), Playwright | Every PR |
| Workbench components | Panels, approval cards, inspector forms, timeline virtualisation, accessibility (axe) | Vitest + Testing Library, `@axe-core/playwright` | Every PR |
| Workbench E2E (browser) | User journeys J-01 to J-15 against `MockHostBridge` + real runtime + `ScriptedProvider` | Playwright | Every PR (smoke subset), nightly (full) |
| Desktop integration | Real Tauri app: startup, runtime handshake, IPC allowlist, preview frame cannot reach IPC (`scripts/spikes/s3-run.mjs` until the suite exists), PTY, keychain round-trip, crash restart, orphan cleanup | WebdriverIO + tauri-driver (Windows, Linux) (RN-08) | Nightly, release |
| Packaging | Installer builds, installs silently, launches, runtime ready, sidecars present with expected hashes, uninstalls cleanly | Scripted on CI runners | Release candidates |
| Security canaries | Fake API key never appears on disk, in logs, in events or in child env; remote images never fetched; frames cannot reach IPC | Vitest + desktop integration | Every PR (runtime parts), nightly (desktop) |
| Performance | Startup (NFR-001/002), relay latency (NFR-006), timeline with 5k events (NFR-003), hover at 60 fps (NFR-022), idle memory (NFR-004) | Scripted benchmarks with thresholds | Nightly, release |
| Agent evals (real models) | Task success on fixture projects using real providers | Custom runner, budget-capped | Manual or weekly, never blocking PRs |

## 3. Test infrastructure

### 3.1 `ScriptedProvider` and cassettes

Cassettes are JSONL files in `packages/runtime/test/cassettes/`. One line per model step:

```json
{"step":0,"expect":{"lastUserTextIncludes":"date helper"},"events":[
  {"type":"text_delta","text":"I'll look at the helper first."},
  {"type":"tool_call_start","callId":"c1","name":"read_file"},
  {"type":"tool_call_args_delta","callId":"c1","delta":"{\"path\":\"src/lib/date.ts\"}"},
  {"type":"tool_call_end","callId":"c1"},
  {"type":"usage","inputTokens":2100,"outputTokens":40,"costUsd":0.003},
  {"type":"finish","reason":"tool_calls"}]}
{"step":1,"expect":{"lastToolResultIncludes":"export function formatWeek"},"events":[
  {"type":"tool_call_start","callId":"c2","name":"edit_file"}, "..."]}
```

- `expect` assertions check what the harness sent, so cassettes test context building too.
- Special events simulate failures: `{"type":"stall","ms":95000}`, `{"type":"http_error","status":429,"retryAfterMs":2000}`, `{"type":"error","afterContent":true,...}`.
- `RecordingProvider` wraps a real adapter to record new cassettes during development, with the `SecretRegistry` redacting keys.

### 3.2 Fakes and fixtures

| Item | Purpose |
|---|---|
| `FakeClock` | Timeouts, budgets, dwell timers, backoff |
| `TempProject` factory | Creates a temp folder from a fixture template, optional `git init`, cleans up |
| `fixtures/bin/fake-cmd.mjs` | Configurable child process: prints lines, sleeps, exits with a code, spawns grandchildren, ignores SIGTERM (for kill tests), writes files |
| `fixtures/bin/fake-dev-server.mjs` | Listens on a port after a delay, prints Vite-like URLs, can crash on demand |
| `fixtures/bin/port-hog.mjs` | Holds a port to test collisions |
| `fixtures/bin/fake-runtime.mjs` | Stand-in runtime for Host lifecycle tests: answers the handshake, starts a grandchild and ignores stdin EOF, so only the job object can clean up. Loaded through the debug-only `JESUTOBITS_RUNTIME_ENTRY` override (`scripts/spikes/s1-orphans.mjs`). Flags for the supervisor tests: `--cooperative`, `--crash-at-init <n>`, `--crash-after-ready <n>`, `--ignore-pings`, `--silent`, `--protocol <v>` |
| `MockHostBridge` | In-memory `HostBridge` for Workbench tests; `RelayHostBridge` extends it to relay runtime calls and events to a real runtime through `scripts/dev-relay.mjs` |
| `RuntimeHarness` | Spawns the runtime bundle with Node over stdio, exposes typed RPC helpers and an event recorder |

### 3.3 Fixture projects (`fixtures/projects/`)

| Fixture | Used for |
|---|---|
| `vite-react-tailwind` | Instrumented preview, full visual editing, checks |
| `vite-react-inline` | Inline-style editing path |
| `vite-react-css-modules` | Inspect-only classification |
| `next-app` | Generic preview, "visual editing unavailable" UX |
| `broken-build` | Failing typecheck and build, fix-attempt limits |
| `no-scripts` | No preview strategy |
| `prompt-injection` | `README.md` and `AGENTS.md` with hostile instructions (SECURITY.md T1, T2) |
| `symlink-escape` | Symlinks and junctions pointing outside the project |
| `secrets` | `.env`, `id_rsa`, `.npmrc` with tokens for redaction tests |
| `large-tree` | Generator for 100k files (NFR-019): `scripts/gen-large-tree.mjs`, used by `packages/services/test/large-tree.perf.test.ts` when `JESUTOBITS_PERF=1` (nightly) |

Fixture `node_modules` are installed once per CI cache key, never during unit tests.

### 3.4 Extension fixtures (`fixtures/extensions/`)

Valid: `theme-basic`, `theme-extends`, `companion-static`, `companion-lottie`. Invalid, one per rule: `zip-slip`, `oversize`, `bad-manifest-json`, `unknown-kind`, `theme-with-permissions`, `missing-required-state`, `svg-with-script`, `lottie-with-expressions`, `lottie-external-asset`, `low-contrast-theme`, `incompatible-engine`, `dependency-cycle`.

## 4. Journey tests

Each journey in PRODUCT_VISION.md section 6 maps to at least one Playwright spec in `apps/desktop/e2e/journeys/`. Specs use the real runtime, `ScriptedProvider` and fixture projects. Examples:

| Journey | Spec asserts |
|---|---|
| J-02 Provider | Invalid key shows 401 message; key never appears in `settings.json` (read by the test through the mock host's store) |
| J-07 Watch agent | Timeline rows match cassette tool calls; companion state sequence matches; no "working" state after `turn.completed` |
| J-10 Manual edit | Draft badge appears; Apply writes the expected one-line diff; Undo restores the file hash |
| J-14 Approvals | Card shows exact argv; Enter does not approve; deny sends the user message to the model (asserted via cassette `expect`) |
| J-15 Recovery | Kill the runtime mid-turn; turn shows Interrupted after restart; no temp files left; Retry works |

## 5. Failure scenarios

| Failure | How it is produced | Expected behaviour tested |
|---|---|---|
| Model first-byte timeout | Cassette `stall` before first event, `FakeClock` | One retry, then `provider.timeout`, turn failed with guidance |
| Idle stream timeout | `stall` mid-stream, comments disabled | Partial step discarded, step retried once |
| Mid-stream provider error | SSE fixture with `finish_reason: "error"` | No tool from that step executed; retry; second failure fails turn |
| 429 rate limit | `http_error 429` with `Retry-After` | Waits, emits warning, retries ≤ 3 |
| 402 credits | `http_error 402` | No retry; correct category and message |
| Tool throws unexpectedly | Fault-injected tool | Converted to `internal` ToolError; loop continues; logged with stack |
| Tool ignores cancellation | Test tool that never resolves | Harness force-resolves at 2 s; turn cancelled; leak reported in test |
| Interrupted session | `RuntimeHarness.kill()` mid-tool | On restart: turn `interrupted`, approval not reused, managed processes reaped |
| Malformed extension | Each invalid fixture | Specific error code and message; nothing written to `extensions/` |
| Unavailable port | `port-hog` on preferred port; then on the next three | Alternate port chosen; after 3 failures, `preview.port_unavailable` error |
| Dev server never ready | `fake-dev-server --never-listen` | Failed after timeout with last log lines |
| Failed build | `broken-build` fixture with cassette that "fixes" wrongly 3 times | Fix-attempt limit stops the turn; label Failing; diagnostics in Problems |
| Approval denied | Cassette expects `permission_denied` result | Model receives denial; same call not retried (loop guard) |
| File changed during agent edit | Test edits file between `read_file` and `edit_file` | `stale_read` returned; agent re-reads (cassette) |
| Disk full or permission error | Mock `fs` throwing `ENOSPC`/`EPERM` | Write fails atomically; original intact; clear error |
| Runtime crash loop | `fake-runtime.mjs --crash-at-init` (cargo test, `runtime_supervisor/tests.rs`) | Host backoff sequence; `failed` state after 5 crashes in 2 minutes; Restart from `failed` works |
| Corrupt database | Truncated `jesutobits.db` | Moved aside, new DB, notice shown |
| Corrupt settings | Invalid JSON | Defaults loaded, `.corrupt` copy kept |

## 6. Cross-platform and packaging

- **CI matrix:** Windows (primary, all suites), Ubuntu (all suites except Windows-only), macOS (unit and browser E2E with WebKit from Phase 1, desktop integration later via the embedded driver if adopted, RN-08).
- Windows-specific tests: `.cmd` spawning (RN-16), junction escapes, reserved names, CRLF preservation, job-object cleanup when the Host is killed with `taskkill /F`.
- **Packaging tests (release candidates):** build installer; silent install in a clean VM image; launch; wait for runtime `ready`; run a scripted turn against a local mock provider; quit; assert no `jesutobits-node`, `node` or dev-server processes remain; uninstall; assert app data is kept (user data) and install dir removed.
- Verify sidecar binaries' SHA-256 against the build manifest at install-test time.

## 7. Quality gates

| Gate | Must pass |
|---|---|
| **Pull request** | Lint (including boundary rules), typecheck, unit (TS, Rust), protocol contract, provider adapter, agent loop, tool contracts, permissions, file ops, process supervisor (Windows + Linux), extension validation, companion controller, component tests with axe (no serious violations), E2E smoke subset, security canaries (runtime) |
| **Nightly** | All of the above plus full journey E2E, real-Vite preview tests, visual-editing E2E (Chromium + WebKit), desktop integration (Windows, Linux), performance benchmarks with thresholds |
| **Release candidate** | Nightly green for 3 consecutive days, packaging tests, manual accessibility pass (NVDA on Windows), manual exploratory checklist, threat-model regression list (SECURITY.md section 15) reviewed |

Coverage targets (line coverage, as a smoke signal, not a goal): `permissions/`, `workspace/`, `process/` ≥ 90%; `agent/`, `providers/`, `visual/` ≥ 80%; Workbench features ≥ 60%.

## 8. Agent quality evaluations (optional, real models)

- Runner: `pnpm eval --model <id> --budget-usd 5` executes tasks such as "add a dark mode toggle", "fix the failing test", "make the hero button larger" on fixture projects.
- Graders are automated: checks pass, expected files changed, no prohibited attempts, verification label is honest (a task claimed Verified must have fresh passing evidence).
- Results are stored locally as JSON for comparison across prompt versions (`prompt_version`). Never run on pull requests.
