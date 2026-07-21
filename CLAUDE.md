# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative references

- **`AGENTS.md`** — the canonical coding rules (mutation gateway, DI, Lit component conventions, critical do/don't list). Read it before writing code; the rules there are binding.
- **`docs/pix3-specification.md`** — the product/architecture source of truth (currently v1.15).
- **`docs/architecture.md`** — deep-dive diagrams for the operations-first flow, property-schema system, script components, rendering, and state.
- **`docs/nodes-and-systems.md`** — the capabilities catalog for agents: every node, `core:*` behavior, system, and scripts-facing runtime API, with how-to-use notes and the engine-vs-game decision. Consult it (and the `pix3-game-dev` skill) before writing custom game logic.

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
- **`tools/pix3-agent-bridge/`** — standalone personal/dev utility (NOT a workspace; own `npm install` + `npm start`, npm-publishable for `npx pix3-agent-bridge`) on `127.0.0.1:8484`. Two lanes: (1) an Anthropic Messages endpoint served by Claude Agent SDK sessions (Claude Code / MAX subscription auth), and (2) a **credential-injecting proxy** (`/providers/:id/*` + `GET /v1/providers`) for the metered providers (OpenAI, Anthropic API, OpenCode Zen, custom OpenAI-compatible) — keys live in `~/.pix3/agent-bridge.json` (managed via `pix3-agent-bridge provider add|list|enable|…`) and never enter the browser. The editor's `BridgeConnectionService` probes discovery and registers these as **dynamic** LLM providers (`BridgeProviders.ts`); only **Gemini** is a static provider called directly. Auth between editor and bridge is a single pairing token printed by the bridge.
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

### 2D overlay rendering (non-obvious)

The 2D layer is a separate render pass with an orthographic camera, drawn over the 3D pass after a `clearDepth()`. Two things about it are easy to break:

- **Draw order is hierarchy-driven, not depth-driven.** All 2D materials use `depthTest: false`, so `renderOrder` is the *only* thing that decides stacking. `assign2DRenderOrder(roots)` (`packages/pix3-runtime/src/core/render-order-2d.ts`) walks the 2D node tree and assigns `renderOrder` by DFS — a node later/deeper in the tree draws on top. The runtime runs it every frame before the 2D pass (`SceneRunner.reflowRoot2DNodes`). The **editor viewport does NOT render the runtime nodes** — it draws separate proxy visuals — so it runs its own counterpart, `ViewportRenderService.assign2DVisualRenderOrder` (called from `requestRender`), which DFS-walks the scene tree and rebases the proxy meshes' `renderOrder`; editor adornments (anchor markers, Group2D outlines, selection/hover frames) float above content via `THREE.Group.renderOrder`, which three.js treats as `groupOrder` (sorts before per-mesh `renderOrder`). So **node order in the scene tree = paint order** (Godot-like) in both. Within a node, its own meshes are ordered by their *authored* `renderOrder` (e.g. Button2D skin 999 < label 1001) — never add-order, because `UIControl2D` adds its label in `super()` before subclasses add their skin. Meshes that must float above a node's *children* (e.g. a ScrollContainer scrollbar) set `userData[OVERLAY_2D_FLAG] = true`.
- **2D textures must disable mipmaps.** Always run loaded/canvas textures for 2D nodes through `configure2DTexture()` (`packages/pix3-runtime/src/core/configure-2d-texture.ts`): sRGB + `generateMipmaps = false` + `LinearFilter`. On some ANGLE/D3D11 backends (Adreno / Windows on ARM) mipmapped NPOT 2D textures upload as transparent black and get cached that way, so sprites/labels render semi-transparent with opacity varying by zoom. The editor applies the same fix in `ViewportRenderService.configureSpriteTexture`. (3D textures keep mipmaps.)

### Editor viewport renders on demand (non-obvious)

The `ViewportRenderService` rAF loop does **not** paint every frame. A frame renders only when something marked the viewport dirty (`requestRender()`), an editor preview is animating (animation-clip / particle / component preview), or the 500 ms idle heartbeat is due — an idle editor costs near-zero CPU/GPU (important for agent-driven background-tab sessions). Dirty marking comes from: Valtio state subscriptions, canvas pointer/wheel/drag events, Orbit/Transform controls `change` events, and `THREE.DefaultLoadingManager.onLoad` for async textures. If you add code that mutates three.js objects outside those paths (timers, async callbacks, direct service calls), call `viewportRenderService.requestRender()` afterwards — otherwise the change won't appear until the next heartbeat (≤500 ms) and, worse, will look intermittently "laggy". `requestRender()` renders synchronously when the loop is stopped (paused / window unfocused / hidden tab), so background-tab edits still land on canvas.

## Conventions worth flagging

- **No `any`.** ESLint flags it (`@typescript-eslint/no-explicit-any: warn`); `strict`, `noUnusedLocals/Parameters`, `noUncheckedSideEffectImports` are all on. Prefix intentionally-unused vars/args with `_`.
- **Lit components** extend `ComponentBase` from `@/fw`, default to Light DOM, and split styles into a sibling `[component].ts.css` (imported directly for Light DOM, or `?raw` for Shadow DOM). Lit a11y/html ESLint rules are enforced.
- **Theming** via CSS custom properties — accent is `--pix3-accent-color` (#ffcf33) / `--pix3-accent-rgb`; avoid hardcoded colors.
- **Icons are vector, never emoji.** Every icon/affordance (buttons, status glyphs, list markers) renders through `IconService` (`@/services/IconService`) — inject it and call `getIcon(name, IconSize.SMALL|MEDIUM|LARGE)`, which returns an inline `currentColor` SVG (Feather names + custom SVGs registered there). Do **not** paste emoji (📎 🔑 ✕ ✓ 📄) or Unicode symbol glyphs (↻ ● ⏸) into templates as UI icons — they ignore the theme, render inconsistently across platforms, and don't scale. If the icon you need isn't in Feather, register a custom SVG in `IconService.registerCustomIcons()` rather than reaching for a glyph. (Emoji are fine only inside user-authored *content* — chat text, asset names — never chrome.) See the `pix3-ui-conventions` skill.
- **Docs policy** (from AGENTS.md): maintain `README.md`, `AGENTS.md`, and `docs/pix3-specification.md`; don't spawn new feature-specific `.md` files.

## Engine vs Game feature decision

When asked to implement a game feature:
1. Check `docs/nodes-and-systems.md` — if the capability already exists
   in the editor/runtime, use it instead of custom game code.
2. Ask: "Would Godot/Unity ship this as a built-in node/system?"
   - Yes → engine-level: implement in pix3 runtime + editor
     (schema, Create*Command, registry, YAML serialization, inspector),
     then `yalc:publish` and update the game project.
   - No (game-specific rules, content, balancing) → game-level script.
3. For engine-level changes, state the plan and get confirmation first.
4. Engine nodes must not reference game domain concepts (shop, coins, enemies).
5. After adding an engine feature, update `docs/nodes-and-systems.md`.