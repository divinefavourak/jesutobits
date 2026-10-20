# Development Setup

> Status: **Partly live.** Phase 0 is in progress (ROADMAP.md). Working today: `pnpm install`, `build:packages`, `build:runtime`, `lint`, `typecheck`, `test`, `gen`, `gen:check`, `dev:web` (Workbench placeholder, no `MockHostBridge` yet). Not yet: `fetch:sidecars`, `dev`, `test:e2e`, `test:desktop`, `build`, `eval`, `kill:dev`, which arrive with Spike S1 and Phase 1. Phase 0 is done only when a clean Windows machine can follow this file without help.

## 1. Prerequisites

### 1.1 Windows (primary development platform)

| Tool | Version | Notes |
|---|---|---|
| Windows | 10 22H2 or 11, x64 | |
| Microsoft C++ Build Tools | Latest, "Desktop development with C++" workload | Required by Rust on MSVC and by Tauri |
| WebView2 Runtime | Evergreen | Preinstalled on Windows 11; install on Windows 10 if missing |
| Rust | Stable via `rustup`, pinned by `rust-toolchain.toml` | Target `x86_64-pc-windows-msvc` |
| Node.js | **26 LTS** (Active LTS from 28 Oct 2026, RN-14) | Use the latest 26.x patch |
| pnpm | Pinned in root `package.json` `packageManager` (11.15.1) | Install with `npm install -g pnpm@<version>`; Corepack is not bundled from Node 25 (RN-15). See section 2.1 for the supply-chain settings |
| Git | 2.40 or later | Enable long paths: `git config --global core.longpaths true` |
| PowerShell 7 | Optional | Nicer default terminal for Jesutobits' PTY tests |

Also enable Windows long paths (Group Policy or registry `LongPathsEnabled=1`) because `node_modules` paths in fixtures can exceed 260 characters.

### 1.2 Linux (CI and secondary)

Follow the Tauri 2 Linux prerequisites (WebKitGTK 4.1 development packages, `build-essential`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`), plus Rust, Node 26 and pnpm as above. For desktop tests: `webkit2gtk-driver` and `xvfb`.

### 1.3 macOS (later)

Xcode Command Line Tools, Rust, Node 26, pnpm. Desktop WebDriver tests are not available with official tooling (RN-08).

## 2. First-time setup

```powershell
git clone <repository-url> jesutobits
cd jesutobits
pnpm install
pnpm fetch:sidecars     # downloads pinned Node and ripgrep binaries, verifies SHA-256 from scripts/sidecars.json,
                        # renames them with the target triple into apps/desktop/src-tauri/binaries/
pnpm build:packages     # protocol codegen, runtime bundle, launcher, vite plugin, bridge, built-in extensions
pnpm dev                # runs the Tauri app: Workbench (Vite dev server) + Host + runtime sidecar
```

`scripts/sidecars.json` pins each binary's version, download URL and SHA-256 per target triple. The fetch script refuses to continue on a hash mismatch.

### 2.1 Dependency policy (`pnpm-workspace.yaml`)

| Setting | Effect | When it bites |
|---|---|---|
| `engineStrict: true` | Install fails on the wrong Node major | Node older than `engines.node` (26.6.0) |
| `minimumReleaseAge: 1440`, `minimumReleaseAgeStrict: true` | Versions published less than 24 hours ago are not installed (RN-36) | A range that only a brand-new release satisfies. Lower the range; do not add `minimumReleaseAgeExclude` entries without review |
| `allowBuilds` | Dependency install scripts are denied unless listed with a reason | A new dependency with a `postinstall`. Prefer `false`; allow only with a recorded reason |

## 3. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Full desktop app with hot reload of the Workbench; runtime rebuilt and restarted on change |
| `pnpm dev:web` | Workbench in a normal browser with `MockHostBridge`; optional `--runtime` flag relays to a real runtime through a dev-only relay bound to `127.0.0.1` with a random token |
| `pnpm lint` | ESLint (including boundary rules) and `cargo clippy` |
| `pnpm typecheck` | `tsc -b` across packages |
| `pnpm test` | Vitest across packages |
| `pnpm test:e2e` | Playwright browser E2E (journeys, visual editing) |
| `pnpm test:desktop` | WebdriverIO + tauri-driver desktop tests (Windows, Linux) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Host unit tests |
| `pnpm gen` | Regenerate protocol JSON Schemas and the Host method allowlist |
| `pnpm build` | Production build and installer for the current platform |
| `pnpm eval --model <id> --budget-usd <n>` | Optional real-model evaluations (TESTING_STRATEGY.md section 8) |

## 4. Development configuration

| Variable | Effect |
|---|---|
| `JESUTOBITS_PROVIDER=scripted` and `JESUTOBITS_CASSETTE=<path>` | Run the app with `ScriptedProvider`, no API key needed |
| `JESUTOBITS_RUNTIME_LOG=debug` | Runtime log level (`trace` allowed only here) |
| `JESUTOBITS_DATA_DIR=<path>` | Override app data location (useful for clean-state testing) |
| `JESUTOBITS_SAFE_MODE=1` | Start with extensions disabled (same as `--safe-mode`) |

Development builds use a different app identifier (`dev.jesutobits.app.dev`) so they never share data or credentials with an installed Jesutobits.

To use a real model while developing, add an OpenRouter key through onboarding. Never put keys in `.env` files in this repository; the canary tests and a pre-commit secret scan treat that as a failure.

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `linker 'link.exe' not found` | C++ Build Tools missing | Install the workload in 1.1 |
| Blank window on start | WebView2 missing or blocked | Install the Evergreen runtime |
| `jesutobits-node` not found | Sidecars not fetched or wrong triple | `pnpm fetch:sidecars`; check `rustc -vV` host triple |
| `EINVAL` when spawning `npm` | Spawning a `.cmd` without the shim handling (RN-16) | Use the `services/process` spawner, never raw `spawn` |
| Very slow installs on Windows | Antivirus scanning `node_modules` | Exclude the repository folder (developer machines only) |
| Port already in use during tests | Leftover dev server | `pnpm kill:dev` (kills processes recorded in the dev process ledger) |
| `node:sqlite` errors | Node older than the minimum | Use the latest Node 26.x |

## 6. Reproducibility checklist

- Node version pinned in `.nvmrc` and `engines`; pnpm pinned in `packageManager`; Rust pinned in `rust-toolchain.toml`.
- Lockfiles committed (`pnpm-lock.yaml`, `Cargo.lock`).
- Sidecar binaries pinned with hashes.
- Fixture `node_modules` installed from committed lockfiles with `--frozen-lockfile`.
- CI uses the same scripts as developers; no CI-only build steps.
