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

> The chrome-devtools MCP must point at the human's Chrome (launched with
> `--remote-debugging-port`, configured via the server's `--browser-url`).
> A fresh MCP-spawned browser won't have the project authorized.

## 2. The bridge API (`window.__PIX3_DEBUG__`)

Call everything through `evaluate_script`. All methods return plain JSON
(curated DTOs — never live Three.js objects). Run `() => window.__PIX3_DEBUG__.help()`
for the live list. Summary:

| Call | Returns |
|---|---|
| `scene(maxDepth=3)` | Active scene as a DTO tree (roots under a synthetic `<scene-root>`). |
| `node(id)` | One node in full detail: transform, raw `properties`, `components`. |
| `find(text)` | `{nodeId,type,name}[]` — substring match on name/type. |
| `selection()` | `{nodeIds, primaryNodeId, hoveredNodeId}`. |
| `play.status()` | `{isPlaying, playModeStatus}`. |
| `play.start()` / `play.stop()` / `play.restart()` | Drive play mode via the `game.*` commands. |
| `setProperty({nodeId, propertyPath, value})` | Edit a property — **undoable**. |
| `command(id)` | Run any registered command by id (e.g. `history.undo`). |
| `components(id)` | Script components on a node (`className`, `scriptId`, `state`). |
| `errors()` / `clearErrors()` | Captured `console.error` / `window.onerror` / unhandled-rejection ring buffer (last 200). |

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
`text`). To undo: `() => window.__PIX3_DEBUG__.command('history.undo')`.

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

Example — verify the DeepCore "droppables hang after a cascade" class of bug:
```js
async () => {
  const g = window.__PIX3_DEBUG__.game;
  const stuck = g.inspect('droppables').filter(d => d.isSleeping && d.bodyPos?.y > 1);
  return { total: g.snapshot().droppables, stuck };   // stuck === [] after the fix
}
```
`action('wakeAll')` is a repair/diagnostic: if stuck items suddenly fall, the
cause was sleeping physics bodies that lost their support without being woken.

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
