# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Doc router — read the SECTION, not the whole file

Every doc below is bigger than the answer to any single task. **Locate the anchor with `Grep`, then `Read` with `offset`/`limit`** — don't load a whole file to find one section. Anchors are the *descriptive* heading text (grep that, not a section number — spec numbers are unreliable). `AGENTS.md` is the binding code-rule set: read it before writing code.

| Task | File → section (grep the heading text) |
|---|---|
| Does the engine already do X? / engine-vs-game decision | `docs/nodes-and-systems.md` → "engine-vs-game decision", then the Nodes/Systems catalog |
| All properties of one node type | `docs/node-types-reference.md` → `### <NodeName>` (summary table at "Node Properties Quick Reference") |
| Write a game script / runtime API from a `Script` | `docs/nodes-and-systems.md` → "Scripts-facing runtime API" + the new-node checklist |
| Add/fix an inspector property (schema authoring) | `docs/property-schema-reference.md` (recipes at top; source: `packages/pix3-runtime/src/fw/property-schema.ts`) |
| New engine node, full checklist | `nodes-and-systems.md` engine-vs-game + spec "Scene File Format" + `property-schema-reference.md` |
| `.pix3scene` YAML format / validation | `docs/pix3-specification.md` → "Scene File Format" |
| Script lifecycle / registry / serialization | `docs/pix3-specification.md` → "Script Component System" |
| Prefabs / keyframe animation / localization / signals / groups | `docs/pix3-specification.md` → "Node Prefabs System" / "Keyframe Animation" / "Localization" / "Signals Engine" / "Groups Engine" |
| 2D draw order, overlay flag, texture-goes-black bug | this file → "2D overlay rendering" |
| Why the exported .html weighs what it does / export size | this file → "Playable export size" |
| Viewport not repainting / render-on-demand | this file → "Editor viewport renders on demand" |
| Command / Operation / undo wiring | `AGENTS.md` → "Commands and Operations"; code in `src/features/<area>/` |
| Editor UI (Lit, panels, icons, theming) | `AGENTS.md` → "Component System" + `pix3-ui-conventions` skill |
| ECS / `InstancedMesh3D` bulk API | `nodes-and-systems.md` → "ECS"; `node-types-reference.md` → `### InstancedMesh3D` |
| System-overview diagrams / menu system / nav modes | `docs/architecture.md` (diagrams only — the spec is authoritative for prose) |
| Build a game feature (entry point) | `pix3-game-dev` skill |
| Debug the *running* editor | `debug-running-game` skill |

**Version of record** is the `## N. Change Log` / title of `docs/pix3-specification.md` — never hardcode a spec version number in other docs.

This file covers what those don't: commands, repo topology, and the non-obvious wiring.

## What Pix3 is

A browser-based editor for HTML5 scenes that blend 2D and 3D layers. Stack: TypeScript + Vite, Lit web components (Light DOM by default), Valtio state, Three.js rendering, Golden Layout docking. Runs entirely client-side using the File System Access API; an optional collab server adds multi-user editing.

## Commands

```bash
npm run dev            # Vite dev server on port 8123, backend = local collab server (:4001)
npm run dev:prod       # same dev server, backend = production cloud.pix3.dev (LIVE data)
npm run dev:collab     # Editor + collab server together (concurrently)
npm run build          # tsc typecheck + Vite production build (prebuild stamps version)
npm run test           # Vitest run (one-shot, happy-dom env)
npm run lint           # ESLint over src + both packages (runtime, collab-server)
npm run lint:fix       # ESLint with --fix
npm run type-check     # tsc --noEmit
npm run format         # Prettier write over src
```

Single test / focused runs (Vitest):

```bash
npx vitest run src/services/play/ScriptExecutionService.spec.ts   # one file
npx vitest run -t "creates a box"                            # by test name
npx vitest src/services/play/ScriptExecutionService.spec.ts        # watch mode
```

Node 24 is required (`engines: >=24.15.0 <25`). `npm install` runs a `postinstall` that copies `esbuild.wasm` into `public/` — needed for in-editor script compilation.

Note: `vitest.config.ts` runs every `*.spec.ts` under `src/` and `packages/pix3-runtime/src/` — there is no exclude list. (An older exclude block named three specs that no longer exist and has been removed.)

## Repository topology

This is an npm-workspaces monorepo plus one externally-linked consumer:

- **`src/`** — the editor application (the bulk of the work).
- **`packages/pix3-runtime/`** (`@pix3/runtime`) — the engine that runs scenes both inside the editor and in exported games: `NodeBase`/`Node2D`/`Node3D` and all concrete node types, `Script` base class, ECS (`ECSService`), `SceneService`/`SceneRunner`, behaviors, audio, resources. This package is the runtime contract; the editor imports from it via the `@pix3/runtime` alias. Treat it as a publishable library — keep it editor-agnostic.
- **`packages/pix3-collab-server/`** (`@pix3/collab-server`) — Express + Hocuspocus (Yjs) + better-sqlite3 backend for real-time collaboration, auth, and project storage. Dev: `npm run dev -w packages/pix3-collab-server` (tsx watch). The Vite dev server proxies `/api` and `/collaboration` (websocket) to it.
- **`tools/pix3-agent-bridge/`** — standalone personal/dev utility (NOT a workspace; own `npm install` + `npm start`, npm-publishable for `npx @pix3/agent-bridge`) on `127.0.0.1:8484`. Two lanes: (1) an Anthropic Messages endpoint served by Claude Agent SDK sessions (Claude Code / MAX subscription auth), and (2) a **credential-injecting proxy** (`/providers/:id/*` + `GET /v1/providers`) for the metered providers (OpenAI, Anthropic API, OpenCode Zen, custom OpenAI-compatible) — keys live in `~/.pix3/agent-bridge.json` (managed via `pix3-agent-bridge provider add|list|enable|…`) and never enter the browser. The editor's `BridgeConnectionService` probes discovery and registers these as **dynamic** LLM providers (`BridgeProviders.ts`); only **Gemini** is a static provider called directly. **Which one answers**: `AgentSettingsService.getSelectedProvider()` honours a pinned pick (`providerPinned`, set by any explicit provider write) and otherwise resolves through `LlmProviderRegistry.getPreferred()` — a bridge lane first, Gemini only as the fallback. Read the effective provider from that method, never from `prefs.selectedProviderId`: they differ whenever the pick is unpinned or points at a provider the current session doesn't have, and UI that names the stale one is how a session ends up quietly served by a provider the user didn't expect. Each assistant turn is stamped with an `AgentTurnOrigin` (provider, model, `viaBridge`) that the chat renders as the reply's avatar monogram. Auth between editor and bridge is a single pairing token, stored `0600` in that config and printed on start as a one-click `<editor>/#bridge-token=…` link — `BridgeConnectionService` consumes it from the URL fragment (on load and on `hashchange`) and strips it from the address bar. The token is the layer the `Origin` allowlist cannot provide: CORS is a browser mechanism, so without it any local process with no `Origin` header could spend the stored provider keys.
- **`../DeepCore/`** (additional working directory) — a separate game project that **consumes** `@pix3/runtime` via [yalc](https://github.com/wclr/yalc) (`file:.yalc/@pix3/runtime`). It's the real-world test of the runtime's public API, not part of this repo.

After changing `pix3-runtime`, publish to consumers with `cd packages/pix3-runtime && npm run yalc:publish`, then `yalc update` in the consumer.

**Versions in `packages/*` are lockstep with the editor** — the root `package.json` version is the single source of truth, and `prebuild` (or `npm run version:sync`) stamps it into every workspace package, so `@pix3/runtime@X.Y.Z` is by definition the engine that shipped with editor X.Y.Z. Never hand-edit a workspace package's `version`; bump the root and re-run the sync. The consequence to keep in mind: a lockstep number is a *product* version, so the runtime's minor digit promises nothing about API compatibility. `tools/pix3-agent-bridge` is exempt (its own cadence, its own `bridge-v*` tag). Releasing to npm is a `runtime-v<version>` tag or a manual run of `publish-packages.yml` (OIDC trusted publishing, no token) — it publishes whatever version the package.json carries.

### Path aliases (use these, never deep relative paths)

`@/` → `src/`, plus `@/core`, `@/services`, `@/state`, `@/fw`. And `@pix3/runtime` → `packages/pix3-runtime/src`. Defined in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts` — keep all three in sync when adding an alias.

## Architecture essentials

The mental model that spans many files:

1. **Operations-first mutation gateway.** Every state change flows: UI → `CommandDispatcher.execute(CommandClass, args)` → Command (thin wrapper, checks `preconditions()`) → Operation (`perform()` returns undo/redo closures) → `OperationService` (pushes to `HistoryManager`). **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `src/features/<area>/` (scene, scripts, properties, selection, alignment, project, editor, history, viewport).

2. **State vs. scene graph are deliberately separate.**
   - `appState` (Valtio proxy, `src/state/AppState.ts`) holds **only** UI state, scene metadata (paths/names), selection (node **IDs**), and undo/redo bookkeeping. UI subscribes via `subscribe(appState.section, cb)` and disposes in `disconnectedCallback`.
   - Actual nodes are Three.js `Object3D` subclasses living in the `SceneGraph` owned by `SceneManager`. They are **NOT reactive** — operations mutate them imperatively. Selection bridges the two by ID.

3. **Dependency injection** (`src/fw/di.ts`): `@injectable()` services registered in `ServiceContainer` (singletons by default), injected via `@inject(ServiceClass)`. Requires `reflect-metadata` (imported first in `main.ts`) and `experimentalDecorators`. Services holding subscriptions/resources implement `dispose()`. The ~85 services in `src/services/` are grouped into domain subdirectories (`core`, `scene`, `project`, `cloud`, `collab`, `assets`, `scripting`, `play`, `export`, `editor`, `animation`, `localization`, `image-gen`, `bg-removal`, `library`, `viewport`, `agent`, `llm`, `ao-bake`, `atlas`) — deep-import from the domain folder (`@/services/<domain>/FooService`); no loose files sit at the `src/services/` root.

4. **Property schema system** (Godot-inspired): node and `Script` classes implement `static getPropertySchema()` returning typed `PropertyDefinition`s with `getValue`/`setValue` closures. The Inspector renders editors dynamically from these; all edits go through `UpdateObjectPropertyOperation`. See `docs/property-schema-reference.md` (source: `packages/pix3-runtime/src/fw/`).

5. **Unified script components** (Unity-style): runtime logic attaches to nodes as `Script` instances in `node.components` (`onAttach`/`onStart`/`onUpdate`/`onDetach`). Register types in `ScriptRegistry` with namespace IDs — `core:` for built-ins, `user:` for project scripts. `ScriptExecutionService` drives the play-mode game loop.

6. **Command-driven menus**: menu items are generated from command metadata (`menuPath`, `shortcut`, `addToMenu`, `menuOrder`) via `CommandRegistry`, not hardcoded.

### Runtime API exposure (non-obvious)

`src/main.ts` exposes `@pix3/runtime`, `three`, rapier, and the GLTFLoader to **user scripts** at runtime by attaching them to `window` and building a blob-URL **import map**. This lets in-editor user scripts `import { ... } from '@pix3/runtime'` against the live engine instance. Rapier (physics) is lazy-loaded (`src/core/lazy-rapier.ts`) and its export keys are baked in at build time via the Vite `define` `__PIX3_RAPIER_EXPORT_KEYS__` to keep its ~2 MB wasm out of the main bundle.

### 2D overlay rendering (non-obvious)

The 2D layer is a separate render pass with an orthographic camera, drawn over the 3D pass after a `clearDepth()`. Two things about it are easy to break:

- **Draw order is hierarchy-driven, not depth-driven.** All 2D materials use `depthTest: false`, so `renderOrder` is the *only* thing that decides stacking. `assign2DRenderOrder(roots)` (`packages/pix3-runtime/src/core/render-order-2d.ts`) walks the 2D node tree and assigns `renderOrder` by DFS — a node later/deeper in the tree draws on top. `Node2D.zIndex` (+ `zAsRelative`, Godot semantics) overrides that: units are bucketed by effective z and DFS order only breaks ties — the sort is skipped entirely while every node is at the default z. Anything that reproduces paint order must apply the same bucketing (the editor does it in `Viewport2DProxyRegistry.assignRenderOrder` and `ViewportPicking.build2DPaintOrderIndex`). The runtime runs it every frame before the 2D pass (`SceneRunner.reflowRoot2DNodes`). The **editor viewport does NOT render the runtime nodes** — it draws separate proxy visuals — so it runs its own counterpart, `ViewportRenderService.assign2DVisualRenderOrder` (called from `requestRender`), which DFS-walks the scene tree and rebases the proxy meshes' `renderOrder`; editor adornments (anchor markers, Group2D outlines, selection/hover frames) float above content via `THREE.Group.renderOrder`, which three.js treats as `groupOrder` (sorts before per-mesh `renderOrder`). So **node order in the scene tree = paint order** (Godot-like) in both. Within a node, its own meshes are ordered by their *authored* `renderOrder` (e.g. Button2D skin 999 < label 1001) — never add-order, because `UIControl2D` adds its label in `super()` before subclasses add their skin. Meshes that must float above a node's *children* (e.g. a ScrollContainer scrollbar) set `userData[OVERLAY_2D_FLAG] = true`.
- **2D textures must disable mipmaps.** Always run loaded/canvas textures for 2D nodes through `configure2DTexture()` (`packages/pix3-runtime/src/core/configure-2d-texture.ts`): sRGB + `generateMipmaps = false` + `LinearFilter`. On some ANGLE/D3D11 backends (Adreno / Windows on ARM) mipmapped NPOT 2D textures upload as transparent black and get cached that way, so sprites/labels render semi-transparent with opacity varying by zoom. The editor applies the same fix in `ViewportRenderService.configureSpriteTexture`. (3D textures keep mipmaps.)

### Spine is an optional, host-injected dependency (non-obvious)

`SpineSkeleton2D` renders through `@esotericsoftware/spine-threejs` (`~4.3`), which the runtime **never imports**: `packages/pix3-runtime/src/core/spine/spine-module.ts` hand-declares the structural subset it uses, and the host registers a loader (`setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'))` — `src/core/lazy-spine.ts`, called from `main.ts` and `player-main.ts`). Reasons: consumer projects compile our TS sources, so a type import would make Spine mandatory for every game; the Spine Runtimes License is a poor fit for an always-installed dependency; and the literal dynamic import must live in the host for its bundler to emit a lazy chunk. Two more load-bearing details: atlas **pages must never go through the pre-launch atlas** (their UVs come from the `.atlas` file — the loader reads page blobs directly and `TextureAtlasService` excludes them), and spine adds its batch meshes **lazily**, so the editor proxy re-stamps `LAYER_2D` on the view's children after every update (three.js layers are per-object, not inherited; the runtime's per-frame `assign2DLayers` covers play mode).

### Playable export size (non-obvious)

The single-file HTML export is mostly **code**, not assets (measured: 1.22 MiB of 1.34 MiB for a 2D pinball), and three.js is ~550 KiB of that with a hard floor of 491 KiB for any bundle that touches `WebGLRenderer` — so tree-shaking cannot reach it and only compression can. Consequences worth knowing before you touch `PlayableHtmlBuildService`:

- **Compression is a per-export choice, not a default** (`PlayableHtmlBuildOptions.compress`). It cuts the file by ~two thirds, which is the budget ad networks measure. What it costs on a channel that compresses for you depends on the codec, and the two answers differ enough to matter (measured on the same export): over gzip it is a wash (+0.9% — deflate re-packs base64 almost perfectly, so the old "+33%" claim was wrong), over **brotli** it is +21%, because brotli beats gzip on the plain text and cannot touch an already-compressed payload. Compressed builds are bundled as `iife` and injected as a classic `<script>`'s `textContent` — deliberately not blob/`data:`/`eval`, which sandboxed and opaque-origin ad containers refuse.
- **Minification is not made redundant by compression** and is always on: same export, unminified gzips to 406 KiB, minified to 259 KiB. Renaming locals and dropping dead code is work gzip cannot do for you.
- **What ships is decided by `RuntimeProjectBuildModel.mentionedNames`** — every identifier found in the shipped scenes/prefabs and project scripts. A module is left out only if *nothing* mentions it, and unused node types / `core:` behaviours are replaced by stubs with identical export names (`strippable-runtime-modules.ts`). The table there is guarded by a spec that recomputes the runtime's value-import graph from disk: **if you add `import { SomeNode } from …` to a module a player always keeps, that spec fails** — which is the point.
- **A player must not construct `SceneSaver`.** It value-imports every node class for serialization, so having it in the bundle pins all of them; `SceneManager` takes it optionally and the runtime entry boots via `SceneRunner.loadAndStartScene` (`startScene` clones the graph by serializing to YAML and re-parsing it, which a player does not need).
- **Optional heavy libraries are wired through a generated `virtual:runtime-*` module** (spine, postprocessing, network) with a **static** import inside it — a dynamic import would become a chunk a single-file HTML can never fetch, and a bare specifier left unaliased is silently externalised into an unresolvable import. That last one was a real shipped bug for `postprocessing`.

Full measurements and the deferred work: `.plans/done/playable-export-size.md`.

### Editor viewport renders on demand (non-obvious)

The `ViewportRenderService` rAF loop does **not** paint every frame. A frame renders only when something marked the viewport dirty (`requestRender()`), an editor preview is animating (animation-clip / particle / component preview), or the 500 ms idle heartbeat is due — an idle editor costs near-zero CPU/GPU (important for agent-driven background-tab sessions). Dirty marking comes from: Valtio state subscriptions, canvas pointer/wheel/drag events, Orbit/Transform controls `change` events, and `THREE.DefaultLoadingManager.onLoad` for async textures. If you add code that mutates three.js objects outside those paths (timers, async callbacks, direct service calls), call `viewportRenderService.requestRender()` afterwards — otherwise the change won't appear until the next heartbeat (≤500 ms) and, worse, will look intermittently "laggy". `requestRender()` renders synchronously when the loop is stopped (paused / window unfocused / hidden tab), so background-tab edits still land on canvas.

## Conventions worth flagging

- **No `any`.** ESLint flags it (`@typescript-eslint/no-explicit-any: warn`); `strict`, `noUnusedLocals/Parameters`, `noUncheckedSideEffectImports` are all on. Prefix intentionally-unused vars/args with `_`.
- **Lit components** extend `ComponentBase` from `@/fw`, default to Light DOM, and split styles into a sibling `[component].ts.css` (imported directly for Light DOM, or `?raw` for Shadow DOM). Lit a11y/html ESLint rules are enforced.
- **Theming** via CSS custom properties — accent is `--pix3-accent-color` (#ffcf33) / `--pix3-accent-rgb`; avoid hardcoded colors.
- **Icons are vector, never emoji.** Every icon/affordance (buttons, status glyphs, list markers) renders through `IconService` (`@/services/editor/IconService`) — inject it and call `getIcon(name, IconSize.SMALL|MEDIUM|LARGE)`, which returns an inline `currentColor` SVG (Feather names + custom SVGs registered there). Do **not** paste emoji (📎 🔑 ✕ ✓ 📄) or Unicode symbol glyphs (↻ ● ⏸) into templates as UI icons — they ignore the theme, render inconsistently across platforms, and don't scale. If the icon you need isn't in Feather, register a custom SVG in `IconService.registerCustomIcons()` rather than reaching for a glyph. (Emoji are fine only inside user-authored *content* — chat text, asset names — never chrome.) See the `pix3-ui-conventions` skill.
- **Docs policy** (from AGENTS.md): maintain `README.md`, `AGENTS.md`, and `docs/pix3-specification.md`; don't spawn new feature-specific `.md` files. Planning docs are the exception and live in `.plans/` (active plans + `TODO.md`; finished plans `git mv`'d to `.plans/done/`) — never at the repo root.

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