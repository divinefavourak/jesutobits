# Development Setup

> Status: **Live**, revised for the Code-OSS fork (ADR-0015). This repository builds the Jesutobits extension (the Host), its agent panel and the runtime; the branded app is built from the separate `jesutobits-ide` fork, which takes the extension as a built-in. Working today: `pnpm install`, `build:packages`, `build:extension`, `dev`, `lint`, `typecheck`, `test`, `gen`, `gen:check`.

## 1. Prerequisites

### 1.1 Windows (primary development platform)

| Tool | Version | Notes |
|---|---|---|
| Windows | 10 22H2 or 11, x64 | |
| Node.js | **26 LTS** (RN-14) | Use the latest 26.x patch; pinned in `.nvmrc` and `engines` |
| pnpm | Pinned in root `package.json` `packageManager` (11.15.1) | Install with `npm install -g pnpm@<version>`; Corepack is not bundled from Node 25 (RN-15). See section 2.1 for the supply-chain settings |
| VS Code | 1.140 or later | Runs the extension during development (`pnpm dev` or F5) |
| Git | 2.40 or later | Enable long paths: `git config --global core.longpaths true` |

Also enable Windows long paths (Group Policy or registry `LongPathsEnabled=1`) because `node_modules` paths in fixtures can exceed 260 characters.

Building the fork itself (`jesutobits-ide`) needs more: the Node version in that repository's `.nvmrc`, Python 3, Visual Studio Build Tools with the C++ workload and Spectre-mitigated libraries, and about 16 GB of RAM (RN-43). See that repository's README.

### 1.2 Linux (CI and secondary)

Node 26 and pnpm as above. `ripgrep` from the package manager for the ripgrep half of the search tests.

### 1.3 macOS (later)

Node 26 and pnpm.

## 2. First-time setup

```powershell
git clone <repository-url> jesutobits
cd jesutobits
pnpm install
pnpm build:packages     # protocol codegen, runtime bundle, launcher, vite plugin, bridge
pnpm build:extension    # apps/vscode-extension/dist: extension.js, runtime/, webview/
pnpm dev                # opens VS Code with the extension loaded (needs `code` on PATH)
```

Instead of `pnpm dev`, open the repository in VS Code and press F5 ("Jesutobits extension" in `.vscode/launch.json`). The second launch configuration runs the agent on the scripted provider with `fixtures/cassettes/agent-file-edit.jsonl`, so no API key is needed.

The runtime runs on VS Code's own Electron with `ELECTRON_RUN_AS_NODE=1` (RN-40), and search uses the ripgrep VS Code ships, so nothing else is downloaded.

Fixture projects (`fixtures/projects/*`) are separate pnpm roots with their own lockfile and the same release-age policy, so the workspace install does not cover them. Install the one a test needs, for example `pnpm install --dir fixtures/projects/vite-react-tailwind` before `node scripts/spikes/s2-run.mjs`.

### 2.1 Dependency policy (`pnpm-workspace.yaml`)

| Setting | Effect | When it bites |
|---|---|---|
| `engineStrict: true` | Install fails on the wrong Node major | Node older than `engines.node` (26.6.0) |
| `minimumReleaseAge: 1440`, `minimumReleaseAgeStrict: true` | Versions published less than 24 hours ago are not installed (RN-36) | A range that only a brand-new release satisfies. Lower the range; do not add `minimumReleaseAgeExclude` entries without review |
| `allowBuilds` | Dependency install scripts are denied unless listed with a reason | A new dependency with a `postinstall`. Prefer `false`; allow only with a recorded reason |

## 3. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Builds everything, then opens VS Code with `--extensionDevelopmentPath=apps/vscode-extension` |
| `pnpm build:extension` | Bundles the extension host code (esbuild), copies the runtime bundle, builds the agent panel (Vite) |
| `pnpm lint` | ESLint (including boundary rules) and Prettier |
| `pnpm typecheck` | `tsc -b` across packages, the extension and the panel |
| `pnpm test` | Vitest across packages and the extension. Agent panel component tests (`*.test.tsx`) run in jsdom with Testing Library; the supervisor tests spawn the real runtime bundle |
| `pnpm gen` | Regenerate protocol JSON Schemas and `methods.json` |

## 4. Development configuration

Set these in the environment VS Code is started from (or in a launch configuration's `env`); the extension passes only allowlisted variables on to the runtime (`apps/vscode-extension/src/runtime/launch.ts`).

| Variable | Effect |
|---|---|
| `JESUTOBITS_PROVIDER=scripted` and `JESUTOBITS_CASSETTE=<path>` | Run the agent with `ScriptedProvider`, no API key needed |
| `JESUTOBITS_RUNTIME_LOG=debug` | Runtime log level (`trace` allowed only here) |
| `JESUTOBITS_OPENROUTER_URL=<loopback URL>` | A local mock provider for tests; the runtime accepts loopback URLs only |
| `JESUTOBITS_TEST_RIPGREP=<path>` | Tests only: a ripgrep binary for the ripgrep half of the text-search tests |

Runtime and extension logs are in the **Jesutobits** output channel (command "Jesutobits: Show Runtime Log"). The runtime's data (sessions, checkpoints, model cache) lives in the extension's global storage folder. For a clean state, start VS Code with its own folders: `code --user-data-dir <tmp>/user --extensions-dir <tmp>/ext --extensionDevelopmentPath=apps/vscode-extension`.

To use a real model while developing, use the agent panel's "Enter key…" button (VS Code's password box stores it in SecretStorage). Never put keys in `.env` files in this repository; the canary tests and a pre-commit secret scan treat that as a failure.

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Status bar shows "Jesutobits" with an error icon | The runtime failed to start or crashed five times in two minutes | "Jesutobits: Show Runtime Log", then click the status bar item to restart |
| `dist/runtime/runtime.mjs` missing | `build:packages` not run before `build:extension` | `pnpm build:packages && pnpm build:extension` |
| Empty agent panel | Webview bundle not built, or a CSP error | `pnpm build:extension`; "Developer: Open Webview Developer Tools" |
| `EINVAL` when spawning `npm` | Spawning a `.cmd` without the shim handling (RN-16) | Use the `services/process` spawner, never raw `spawn` |
| Very slow installs on Windows | Antivirus scanning `node_modules` | Exclude the repository folder (developer machines only) |

## 6. Reproducibility checklist

- Node version pinned in `.nvmrc` and `engines`; pnpm pinned in `packageManager`; the VS Code version the fork follows pinned in `jesutobits-ide`.
- `pnpm-lock.yaml` committed.
- Fixture `node_modules` installed from committed lockfiles with `--frozen-lockfile`.
- CI uses the same scripts as developers; no CI-only build steps.
