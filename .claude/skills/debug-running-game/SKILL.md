---
name: debug-running-game
description: Debug a game/scene running inside the live Pix3 editor by driving it through the chrome-devtools MCP. Use when asked to inspect the scene graph, node properties, ECS/script components, selection or play-mode state of the *running* editor; to start/stop/restart play mode; to reproduce or diagnose a runtime bug; or to read runtime/console errors from the running app. Requires the dev server running and the editor open in a Chrome instance the MCP can attach to.
---

# Debugging the running Pix3 editor

Pix3 is a client-side PWA. Instead of a custom MCP server, debugging the running
editor is done through the **chrome-devtools MCP** (transport) + a **dev-only
bridge** the app exposes at `window.__PIX3_DEBUG__` (protocol). This skill is the
playbook.

## 0. Preconditions (check first, don't assume)

- The dev server is running (`npm run dev`, port **8123**).
- The editor is open **in a Chrome the MCP can attach to**, with a project +
  scene already loaded. The bridge needs an active scene; project loading needs
  a File System Access user gesture that only a human can grant, so the human
  opens the project once — you attach afterward.
- The bridge only exists in dev builds (`import.meta.env.DEV`). If
  `window.__PIX3_DEBUG__` is `undefined`, you're on a prod build or the wrong
  page — stop and say so.

## 1. Attach to the page

1. `list_pages` → find the tab on `localhost:8123`.
2. `select_page` it (or `new_page`/`navigate_page` only if the human confirms a
   project is already authorized in that browser profile).
3. Sanity check by evaluating `() => typeof window.__PIX3_DEBUG__` — expect
   `"object"`. If `"undefined"`, re-read the preconditions above.

> The chrome-devtools MCP drives its **own managed Chrome** (a persistent profile
> under `~/.cache/chrome-devtools-mcp/chrome-profile`, launched with
> `--remote-debugging-pipe`). Once a human has opened the project in that profile,
> the File System Access handle is saved in the profile's IndexedDB, so later
> `navigate_page http://localhost:8123` **auto-restores** the project + scene from
> the `#editor?local=…` URL with **no human gesture** — you can re-attach and even
> hard-reload freely. A *brand-new* profile (first ever run) does need the human to
> open the project once.
>
> **Profile-lock gotcha:** if a previous MCP session left a Chrome alive, a new MCP
> can't attach ("browser is already running … Use --isolated"). Kill the stale
> instances, then `list_pages` relaunches fresh:
> ```
> Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
>   ? CommandLine -like '*chrome-devtools-mcp*chrome-profile*' | Stop-Process -Force
> ```

## 2. The bridge API (`window.__PIX3_DEBUG__`)

Call everything through `evaluate_script`. All methods return plain JSON
(curated DTOs — never live Three.js objects). Run `() => window.__PIX3_DEBUG__.help()`
for the live list. Summary:

| Call | Returns |
|---|---|
| `scene(maxDepth=3)` | Active scene as a DTO tree (roots under a synthetic `<scene-root>`). |
| `node(id)` | One node in full detail: transform, raw `properties`, `components`. |
| `find(text)` | `{nodeId,type,name}[]` — substring match on name/type. |
| `liveScene(maxDepth=4)` | **Live RUNNING-game** Object3D tree (the `SceneRunner` clone), incl. raw sprites/instanced-meshes/clusters that `scene()` can't see. |
| `liveFind(query,limit=50)` | Search live objects by type/name, or `'droppable'` for items tagged `droppableItemRef`. Returns DTOs w/ `worldPos`, `instances`, `flags`. |
| `selection()` | `{nodeIds, primaryNodeId, hoveredNodeId}`. |
| `play.status()` | `{isPlaying, playModeStatus}`. |
| `play.start(scenePath?)` / `play.stop()` / `play.restart()` | Drive play mode via the `game.*` commands. `start()` without args plays the **active** scene; pass a `.pix3scene` path (res:// or project-relative) to play that exact scene (`game.start-scene`). |
| `setProperty({nodeId, propertyPath, value})` | Edit a property — **undoable**. |
| `command(id)` | Run any registered command by id (e.g. `edit.undo`). |
| `components(id)` | Script components on a node (`className`, `scriptId`, `state`). |
| `errors()` / `clearErrors()` | Captured `console.error` / `window.onerror` / unhandled-rejection ring buffer (last 200). |
| `physicsDebug()` | Collider-wireframe overlay status: `{available, enabled, bodies, vertexCount, segments}` — or `null` when the game registered no source. Counts only; the raw buffers stay live for rendering. |
| `assets.*` | **Headless AI asset pipeline** (bridge v2+): generate / resize / crop / compress / remove-background / save images programmatically using the user's saved key. Returns JSON-safe handle metadata, never blobs. See the [generate-sprites-in-editor](../generate-sprites-in-editor/SKILL.md) skill for the full playbook. |

> **Showing colliders:** the running game publishes its collider line-segment
> buffers via `registerPhysicsDebugSource` (DeepCore: `getColliderDebug()` →
> `world.debugRender()`). Toggle the wireframe overlay on/off with
> `command('view.toggle-colliders')` (or the **Colliders** button in the Game-tab
> toolbar / `appState.ui.showPhysicsColliders`). When on, `SceneRunner` draws the
> wireframes over the 3D pass with the active camera. Confirm it's live with
> `physicsDebug().enabled === true` and `segments > 0`.

> **Stale graph after a late compile:** a scene opened in the editor BEFORE the
> first `compile_scripts` silently drops its `user:*` components, and play then
> clones that empty graph. Fix without the old touch-the-file hack:
> `agentTools.execute('play_start', { scene: 'src/assets/scenes/x.pix3scene', reload: true })`
> — `reload: true` re-reads the scene from disk (registry now warm) before playing.
>
> **`scene()` vs `liveScene()` (critical):** play mode runs the game on an
> isolated **clone** in `SceneRunner`'s own THREE.Scene. `scene()`/`node()`/the
> Scene-Tree show the **authored** graph and never contain spawned runtime
> objects (droppables, falling clusters). Use **`liveScene()`/`liveFind()`** —
> or the dockable **Runtime** panel (`src/ui/runtime/runtime-panel.ts`) — to see
> the actual running instances. (`SceneRunner` publishes its live root via
> `registerRuntimeSceneRoot`/`getRuntimeSceneRoot` in `@pix3/runtime`.)

## 3. Recipes

**Map the scene**
```js
async () => window.__PIX3_DEBUG__.scene(4)
```

**Find a node, then inspect it**
```js
async () => {
  const hits = window.__PIX3_DEBUG__.find('Player');
  return hits.map(h => h.nodeId);
}
```
```js
async () => window.__PIX3_DEBUG__.node('<nodeId>')
```

**Drive play mode and read what broke**
```js
async () => {
  const dbg = window.__PIX3_DEBUG__;
  dbg.clearErrors();
  await dbg.play.start();
  return dbg.play.status();
}
```
Let it run, then collect errors two ways:
- `() => window.__PIX3_DEBUG__.errors()` — the bridge's own buffer.
- `list_console_messages` — the full console (broader, noisier). Filter to the
  relevant tag (game scripts usually log with a `[Pix3]`/script prefix).

**Edit a property the right way** (goes through the mutation gateway → undoable;
never mutate `appState`/nodes directly from `evaluate_script`):
```js
async () => window.__PIX3_DEBUG__.setProperty({
  nodeId: '<nodeId>', propertyPath: 'visible', value: false,
})
```
`propertyPath` is the inspector property name (e.g. `position`, `opacity`,
`text`). To undo: `() => window.__PIX3_DEBUG__.command('edit.undo')`.

**See it** — pair data with a `take_screenshot` of the viewport to confirm
visual state, and `take_snapshot` for the DOM/a11y tree of editor chrome.

## 3a. Game-specific surface (`__PIX3_DEBUG__.game`)

The engine-level calls above work for any scene. For game-specific runtime state
(physics bodies, droppables, custom ECS) a game may register a **debug
provider** — a standardised contract shared across all games on the runtime.

- Check it exists: `() => window.__PIX3_DEBUG__.game.available()` and
  `.info()` (`{name, version, has:{snapshot,inspect,action}}`). It only appears
  **after play starts** (the game registers it in its runner's start hook).
- `game.snapshot()` — high-level overview.
- `game.inspect(query, args?)` — named read query, e.g. `inspect('droppables')`.
- `game.action(name, args?)` — named imperative action, e.g. `action('wakeAll')`.

A game registers its provider from its runner via `@pix3/runtime`:
```ts
import { registerGameDebug, type GameDebugProvider } from '@pix3/runtime';
// in onStart: this.dispose = registerGameDebug({ name, version, snapshot, inspect, action });
// in onDetach: this.dispose?.()
```
Everything a provider returns must be JSON-serialisable. The contract lives in
[packages/pix3-runtime/src/core/game-debug.ts](packages/pix3-runtime/src/core/game-debug.ts).

**DeepCore provider** exposes:
- `inspect('droppables')` — resource items: `type, value, collected, isSleeping, bodyPos, spritePos`.
- `inspect('items')` — richer per-item view: `voxelBelowSolid`, `colliderBelow`, `belowBlock` (the supporting block's coords/type/hp/isDying), `belowInRenderFeed`. Use to tell a *physics* float (nothing below) from a *visual/render* desync (block exists + rendered, item just looks detached).
- `inspect('topBlocks')` — topmost solid block per column (the minable surface).
- `inspect('orphans')` — `{summary:{active,tracked,orphaned,noBody,diverged}, suspects[]}`. Flags droppables whose physics body was removed from the world but the item kept (`PhysicsWorld.isBodyTracked`), or whose body drifted from its sprite. Smoking-gun query for "hangs in mid-air". NOTE it only scans **active** items — a *leaked* sprite (collected/absorbed but never detached from the scene) isn't in the active list; to catch those, traverse the live scene (`getRuntimeSceneRoot`) for objects tagged `userData.droppableItemRef` and compare against `inspect('droppables')`.
- `action('wakeAll')` — wake all droppable bodies (repair/diagnostic).
- `action('collectNear', {x,y,z,radius?=0.6})` — collect droppables near a point via the real proximity path (`checkProximityCollection`). Remove a support and watch whether the resources above fall (fixed) or hang frozen (bug).
- `action('mine', {x,y,z})` — one tap of the current tool on a block, via the **real player path** (`useTapTool → damageBlock`). Returns `{hit, destroyed, hp}`. **Surface-only:** only *exposed/interactable* blocks take damage; buried blocks return `{hit:true}` but never lose hp, and deep blocks are depth-scaled (slow). Plain top-down mining never cascades — a column dug from the top stays anchored to the bottom layer.
- `action('forceCluster', {columns?:[{x,z}], chunkHeight?=4, dropHeight?=6})` — **deterministically trigger a falling-cluster cascade** (impact + drops), bypassing the surface-only rule. Extracts the top `chunkHeight` layers of the target columns (default: all), lifts them `dropHeight`, and drops them back through the real `ClusterSystem`. Use a **contained** drop (a few columns) — dropping the whole 16-column slab (e.g. chunkHeight 5, dropHeight 10) **stops play mode** (terminal/game-over or a separate bug).

**Drive mining autonomously** (canvas clicks do NOT reach the game in embedded
mode — input comes via `InputService`). Orchestrate from `evaluate_script`,
pausing between rounds so cascades/clusters step:
```js
async () => {
  const g = window.__PIX3_DEBUG__.game;
  for (let r = 0; r < 60; r++) {
    const top = g.inspect('topBlocks');
    for (const b of top) g.action('mine', { x: b.x, y: b.y, z: b.z });   // or a subset to dig a pit
    await new Promise(res => setTimeout(res, 100));   // let frames advance
  }
  await new Promise(res => setTimeout(res, 2000));     // settle
  return g.inspect('items');
}
```

> **"Droppables hang in mid-air" — SOLVED (2026-06-21). Two independent bugs:**
> 1. **Leaked sprites (the visible "full-opacity rock with no collider").** In
>    embedded mode DeepCore's `Renderer` overrode `scene.add` to re-parent onto the
>    pix3 host node but **not** `scene.remove`, so `this.scene.remove(sprite)` was a
>    silent no-op. Collected sprites faded first so it didn't show; **absorbed**
>    sprites (`removeItemImmediately`, no fade) leaked at full opacity with their
>    body already gone → no collider. Fix: mirror the `remove` override. Detect via
>    the live-scene traversal noted under `inspect('orphans')` (sprite count >
>    active count = leak).
> 2. **Sleeping bodies never woken when support is removed.** Droppables are
>    dynamic Rapier bodies that sleep at rest; Rapier does NOT wake a sleeper when
>    the collider under it (a collected/absorbed neighbour, or a mined block not
>    strictly above) is removed → it hangs. Fix: `wakeDroppablesNear` on every
>    support-removal site. Repro/verify with `action('collectNear')` on the bottom
>    of a stack and watch the top fall (`inspect('items')` / `inspect('orphans')`).
>
> Earlier dead ends (kept as warnings): it is **not** a `viewY`/floating-origin
> render desync (blocks + droppables shift together), and a sleeping collider only
> *looks* missing because Rapier draws sleeping bodies near-black — the runtime
> overlay now lifts a brightness floor so they stay visible. Also: `safeSerialize`
> only collapses *pure* `{x,y,z}` vectors — a DTO with top-level numeric x/y/z
> *plus* other fields was silently flattened; nest positions or keep extra fields
> off the top level.

## 3b. Recompiling game scripts + resetting play

You changed code on disk and need the running editor to run the **new** code.
There are two paths; under MCP, **default to the forced reload** — the in-place
hot-reload is unreliable when the window isn't focused.

### Forced reload + recompile (the reliable MCP path — do this)

When driving via MCP, **always force a hard reload after editing code**, then
re-attach. A *plain* reload can serve **stale compiled scripts** (hard-won: a
`Renderer.ts` fix silently kept running the old code through several normal
reloads — the leak it fixed persisted — until a cache-busting reload). Use
`ignoreCache`:

```js
// 1. Hard reload (chrome-devtools MCP): navigate_page { type: "reload", ignoreCache: true }
// 2. Re-attach + restart the game + wait for it to be ready:
async () => {
  const dbg = window.__PIX3_DEBUG__;
  if (!dbg) return { error: 'bridge gone — wait for load / wrong page' };
  await dbg.play.start();                                  // fresh page → stopped → start()
  for (let i = 0; i < 80; i++) {                            // wait for async game init()
    await new Promise(r => setTimeout(r, 250));
    if (dbg.game?.available?.() && dbg.game.snapshot()?.ready) break;
  }
  return dbg.game.snapshot();
}
```

After a hard reload the page is fresh: the bridge is re-installed, play is
**stopped**, the project auto-restores from the `#editor?local=…` URL (the FS
handle persists in the profile's IndexedDB — no human gesture needed), and the
game-debug provider re-registers only **after** `play.start()`.

> Editing the runtime **package** (`@pix3/runtime`, e.g. the collider overlay) is
> picked up by the editor on reload too (it's source-aliased), but to also reach a
> **standalone** consumer build (DeepCore) run `cd packages/pix3-runtime &&
> npx yalc publish --force` then `npx yalc update` in the consumer. (`yalc` isn't
> global here — use `npx yalc`.)

### In-place hot-reload (in-person; flaky under MCP)

With the window genuinely focused, `FileWatchService` polls watched files'
`lastModified` every 500ms and `ProjectScriptLoaderService` recompiles
(esbuild-wasm, ~300ms debounce) and re-registers the script classes — no page
reload. Dependencies (non-`extends Script` files like `core/Game.ts`,
`rendering/Renderer.ts`) are watched too. **But** both services gate on
`isDocumentActive` = `visibilityState === 'visible'` **AND** `document.hasFocus()`;
a backgrounded MCP Chrome usually has `hasFocus() === false`, so polling/build is
**paused** and your edit is never seen. Check with
`() => ({visible: document.visibilityState, focus: document.hasFocus()})`. Even
when it does fire, a recompile only registers new *classes* — the live scene keeps
the **old** component instances, so you still need `play.restart()`. Given all
this, the forced reload above is simpler and deterministic.

### Always verify the new code is live (don't assume)

Probe a new method/action/behavior with a side-effect-free call, e.g.
`game.inspect('orphans')` → returns a `{summary,suspects}` object on the new
build, `{error:'unknown query',...}` on the old one. If you get the old answer,
the recompile didn't take — hard-reload again.

**Resetting the game** (`play.*` routes through the `game.*` commands → keeps
`appState.ui` in sync, undoable):
- `play.start()` when **stopped**, `play.restart()` when **playing**.
- ⚠️ `play.restart()` is a **no-op from a stopped state** — it won't start a
  stopped game. If `play.status().isPlaying` is false, call `play.start()`.
- The game-debug provider only re-registers **after** play (re)starts, and the
  game's async `init()` runs after that — poll `game.snapshot().ready` before
  driving it.

## 4. Rules

- **Read with the bridge / `list_console_messages`; mutate only via
  `setProperty` / `command`.** Direct `appState` or node mutation from
  `evaluate_script` bypasses the mutation gateway and corrupts undo/redo.
- **Always `clearErrors()` before a repro**, so the buffer reflects this run.
- **Big trees**: prefer `find` + `node(id)` over `scene()` with a huge depth;
  the serialiser truncates deep/large values (`[Object]`, `[Array(n)]`, `…`).
- If a call returns `null`, the most common cause is **no active scene** —
  re-check preconditions before theorising about a bug.

## 5. Extending the bridge

The bridge lives at [src/core/debug-bridge.ts](src/core/debug-bridge.ts). To
expose more (e.g. ECS systems via `ECSService`, resource caches, a specific
service), add a method that returns a JSON-safe DTO via `safeSerialize` and route
any mutation through `CommandDispatcher`. Keep it dev-only — it's installed from
`main.ts` behind `import.meta.env.DEV` and must stay out of the prod bundle.
```
