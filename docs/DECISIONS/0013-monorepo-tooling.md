# ADR-0013: Monorepo and build tooling

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related:** docs/PROJECT_STRUCTURE.md, docs/DEVELOPMENT_SETUP.md, RN-14, RN-15

## Context

Jesutobits has a Tauri app (Rust + React), a Node runtime, a shared protocol package, a Vite plugin and bridge script that run inside *user* projects, and extension tooling. Types must be shared between the Workbench and the runtime.

## Decision

- **pnpm workspaces** for JavaScript packages, with the exact pnpm version pinned in `package.json` `packageManager`. Corepack is not assumed (RN-15); setup installs pnpm directly.
- **TypeScript** in strict mode everywhere, with project references. Target ES2023, `moduleResolution: "bundler"` for browser packages and `"nodenext"` for Node packages.
- **Node 26 LTS** for development and for the bundled runtime (RN-14).
- **Vite 8** for the Workbench build. **Rolldown or esbuild** to bundle the runtime into one ESM file.
- **Vitest** for unit and integration tests across TS packages; **Playwright** for Workbench E2E in a browser; **cargo test** for the Host; **WebdriverIO + tauri-driver** for desktop smoke tests on Windows and Linux.
- **Linting:** ESLint with `eslint-plugin-boundaries` (or equivalent) to enforce the dependency rules in PROJECT_STRUCTURE.md; Prettier for formatting; `cargo clippy` for Rust.
- **Rust:** stable toolchain pinned with `rust-toolchain.toml`.

## Alternatives considered

| Option | Assessment |
|---|---|
| npm workspaces | Works, but slower installs and weaker strictness about undeclared dependencies. |
| Nx or Turborepo | Useful later for caching; unnecessary at the start. Turborepo can be added without restructuring. |
| Bun as package manager | Fast, but adds a second runtime to the toolchain. |

## Consequences

- `pnpm -r test`, `pnpm -r typecheck`, `pnpm -r lint` are the standard commands referenced by AGENTS.md.
- Packages that run inside user projects (`vite-plugin`, `visual-bridge`) must have **zero runtime dependencies on other Jesutobits packages** except `protocol` types, because they are loaded with the user's toolchain.

### Notes from Phase 0 scaffolding (2026-10-20)

- **TypeScript is pinned to 6.0.x**, not 7.x: `typescript-eslint` 8.x declares `typescript >=4.8.4 <6.1.0` (RN-35). Revisit when typescript-eslint supports TypeScript 7.
- **The runtime bundler is esbuild** (`scripts/build-runtime.mjs` → `packages/runtime/dist/bundle/runtime.mjs`). Bundling cut the measured `initialize` round trip on Windows from 0.56–1.2 s to about 0.2 s (`docs/spikes/S1.md`), so integration tests spawn the bundle, never the unbundled `tsc` output.
- **The boundary linter is a local rule** (`scripts/eslint-rules/`) rather than `eslint-plugin-boundaries`. One rule table avoids flat-config option overriding, which would otherwise drop restrictions where folders overlap.

## Revisit when

CI time exceeds 15 minutes for a typical change, which would justify a build cache tool.
