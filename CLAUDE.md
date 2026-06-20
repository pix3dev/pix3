# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative references

- **`AGENTS.md`** — the canonical coding rules (mutation gateway, DI, Lit component conventions, critical do/don't list). Read it before writing code; the rules there are binding.
- **`docs/pix3-specification.md`** — the product/architecture source of truth (currently v1.15).
- **`docs/architecture.md`** — deep-dive diagrams for the operations-first flow, property-schema system, script components, rendering, and state.

This file covers what those don't: commands, repo topology, and the non-obvious wiring.

## What Pix3 is

A browser-based editor for HTML5 scenes that blend 2D and 3D layers. Stack: TypeScript + Vite, Lit web components (Light DOM by default), Valtio state, Three.js rendering, Golden Layout docking. Runs entirely client-side using the File System Access API; an optional collab server adds multi-user editing.

## Commands

```bash
npm run dev            # Vite dev server on port 8123
npm run dev:collab     # Editor + collab server together (concurrently)
npm run build          # tsc typecheck + Vite production build (prebuild stamps version)
npm run test           # Vitest run (one-shot, happy-dom env)
npm run lint           # ESLint over src
npm run lint:fix       # ESLint with --fix
npm run type-check     # tsc --noEmit
npm run format         # Prettier write over src
```

Single test / focused runs (Vitest):

```bash
npx vitest run src/services/ScriptExecutionService.spec.ts   # one file
npx vitest run -t "creates a box"                            # by test name
npx vitest src/services/ScriptExecutionService.spec.ts        # watch mode
```

Node 24 is required (`engines: >=24.15.0 <25`). `npm install` runs a `postinstall` that copies `esbuild.wasm` into `public/` — needed for in-editor script compilation.

Note: `vitest.config.ts` **excludes** a few known-broken specs from the suite (e.g. `SelectObjectCommand.spec.ts`, `ViewportRendererService.spec.ts`, `LoadSceneCommand.spec.ts`). Don't assume those run with the default suite.

## Repository topology

This is an npm-workspaces monorepo plus one externally-linked consumer:

- **`src/`** — the editor application (the bulk of the work).
- **`packages/pix3-runtime/`** (`@pix3/runtime`) — the engine that runs scenes both inside the editor and in exported games: `NodeBase`/`Node2D`/`Node3D` and all concrete node types, `Script` base class, ECS (`ECSService`), `SceneService`/`SceneRunner`, behaviors, audio, resources. This package is the runtime contract; the editor imports from it via the `@pix3/runtime` alias. Treat it as a publishable library — keep it editor-agnostic.
- **`packages/pix3-collab-server/`** (`@pix3/collab-server`) — Express + Hocuspocus (Yjs) + better-sqlite3 backend for real-time collaboration, auth, and project storage. Dev: `npm run dev -w packages/pix3-collab-server` (tsx watch). The Vite dev server proxies `/api` and `/collaboration` (websocket) to it.
- **`../DeepCore/`** (additional working directory) — a separate game project that **consumes** `@pix3/runtime` via [yalc](https://github.com/wclr/yalc) (`file:.yalc/@pix3/runtime`). It's the real-world test of the runtime's public API, not part of this repo.

After changing `pix3-runtime`, publish to consumers with `cd packages/pix3-runtime && npm run yalc:publish`, then `yalc update` in the consumer.

### Path aliases (use these, never deep relative paths)

`@/` → `src/`, plus `@/core`, `@/services`, `@/state`, `@/fw`. And `@pix3/runtime` → `packages/pix3-runtime/src`. Defined in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts` — keep all three in sync when adding an alias.

## Architecture essentials

The mental model that spans many files:

1. **Operations-first mutation gateway.** Every state change flows: UI → `CommandDispatcher.execute(CommandClass, args)` → Command (thin wrapper, checks `preconditions()`) → Operation (`perform()` returns undo/redo closures) → `OperationService` (pushes to `HistoryManager`). **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `src/features/<area>/` (scene, scripts, properties, selection, alignment, project, editor, history, viewport).

2. **State vs. scene graph are deliberately separate.**
   - `appState` (Valtio proxy, `src/state/AppState.ts`) holds **only** UI state, scene metadata (paths/names), selection (node **IDs**), and undo/redo bookkeeping. UI subscribes via `subscribe(appState.section, cb)` and disposes in `disconnectedCallback`.
   - Actual nodes are Three.js `Object3D` subclasses living in the `SceneGraph` owned by `SceneManager`. They are **NOT reactive** — operations mutate them imperatively. Selection bridges the two by ID.

3. **Dependency injection** (`src/fw/di.ts`): `@injectable()` services registered in `ServiceContainer` (singletons by default), injected via `@inject(ServiceClass)`. Requires `reflect-metadata` (imported first in `main.ts`) and `experimentalDecorators`. Services holding subscriptions/resources implement `dispose()`. There are ~85 services in `src/services/`.

4. **Property schema system** (Godot-inspired): node and `Script` classes implement `static getPropertySchema()` returning typed `PropertyDefinition`s with `getValue`/`setValue` closures. The Inspector renders editors dynamically from these; all edits go through `UpdateObjectPropertyOperation`. See `docs/property-schema-*.md`.

5. **Unified script components** (Unity-style): runtime logic attaches to nodes as `Script` instances in `node.components` (`onAttach`/`onStart`/`onUpdate`/`onDetach`). Register types in `ScriptRegistry` with namespace IDs — `core:` for built-ins, `user:` for project scripts. `ScriptExecutionService` drives the play-mode game loop.

6. **Command-driven menus**: menu items are generated from command metadata (`menuPath`, `shortcut`, `addToMenu`, `menuOrder`) via `CommandRegistry`, not hardcoded.

### Runtime API exposure (non-obvious)

`src/main.ts` exposes `@pix3/runtime`, `three`, rapier, and the GLTFLoader to **user scripts** at runtime by attaching them to `window` and building a blob-URL **import map**. This lets in-editor user scripts `import { ... } from '@pix3/runtime'` against the live engine instance. Rapier (physics) is lazy-loaded (`src/core/lazy-rapier.ts`) and its export keys are baked in at build time via the Vite `define` `__PIX3_RAPIER_EXPORT_KEYS__` to keep its ~2 MB wasm out of the main bundle.

## Conventions worth flagging

- **No `any`.** ESLint flags it (`@typescript-eslint/no-explicit-any: warn`); `strict`, `noUnusedLocals/Parameters`, `noUncheckedSideEffectImports` are all on. Prefix intentionally-unused vars/args with `_`.
- **Lit components** extend `ComponentBase` from `@/fw`, default to Light DOM, and split styles into a sibling `[component].ts.css` (imported directly for Light DOM, or `?raw` for Shadow DOM). Lit a11y/html ESLint rules are enforced.
- **Theming** via CSS custom properties — accent is `--pix3-accent-color` (#ffcf33) / `--pix3-accent-rgb`; avoid hardcoded colors.
- **Docs policy** (from AGENTS.md): maintain `README.md`, `AGENTS.md`, and `docs/pix3-specification.md`; don't spawn new feature-specific `.md` files.
