---
name: pix3-scripts
description: How to write a Pix3 game script (scripts/*.ts, `export class X extends Script`, attached as `user:X`) — lifecycle, the required getPropertySchema, config, node lookup, signals, transforms, spawning, input, juice/tweens/audio, 2D physics, scene changes, the built-in core:* components and their config keys (reference.md), and the traps that compile clean and break at runtime. Use BEFORE writing or editing any file in scripts/ or attaching a core: component.
---

<!-- Pix3 agent kit {{version}} -->

# Writing a script

Everything here is exported from `@pix3/runtime`; use it directly instead of searching for
it. Import only from `@pix3/runtime`, `three`, and other files under the scripts root
(`scripts/` or `src/scripts/`, relative paths — they are bundled together). `pix3 check` type-checks every script
against the runtime's declarations (`.pix3/types/`, or your `node_modules` when the project
has its own `tsconfig.json`); your editor sees the same types through the root `tsconfig.json`.

`reference.md` beside this file has the engine's own API map, the capability catalog and
**every `core:` component with its config keys and defaults** — reach for a built-in before
writing a script for the same effect.

## Shape (copy this)

```ts
import { Script, type NodeBase, type PropertySchema } from '@pix3/runtime';

export class Combo extends Script {
  private count = 0;
  private sinceLastHit = Infinity;
  private source: NodeBase | null = null;
  private readonly onScoredSignal = (...args: unknown[]): void => this.onScored(Number(args[0]) || 0);

  constructor(id: string, type: string) {
    super(id, type);
    // Defaults. A scene's `config:` block is merged over these, key by key.
    this.config = {
      sourceNode: 'game-root',
      windowSec: 1.2,
    };
  }

  // REQUIRED. A class without a static getPropertySchema() is not registered as a
  // component, and `user:Combo` in the scene stays pending forever.
  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'Combo',
      properties: [
        {
          name: 'sourceNode',
          type: 'string',
          ui: { label: 'Source Node', group: 'Combo' },
          getValue: (s: unknown) => (s as Combo).config.sourceNode,
          setValue: (s: unknown, v: unknown) => {
            (s as Combo).config.sourceNode = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'windowSec',
          type: 'number',
          ui: { label: 'Window (s)', group: 'Combo', min: 0.1, max: 10, step: 0.1 },
          getValue: (s: unknown) => (s as Combo).config.windowSec,
          setValue: (s: unknown, v: unknown) => {
            const n = Number(v);
            (s as Combo).config.windowSec = Math.min(10, Math.max(0.1, Number.isFinite(n) ? n : 1.2));
          },
        },
      ],
      groups: { Combo: { label: 'Combo', expanded: true } },
    };
  }

  onStart(): void {
    this.source = this.findNode(String(this.config.sourceNode ?? ''));
    if (!this.source) {
      console.warn(`[Combo] Source node "${this.config.sourceNode}" not found.`);
      return;
    }
    this.source.connect('touch-scored', this, this.onScoredSignal);
  }

  onUpdate(dt: number): void {
    if (!this.scene) return; // editor previews may run without a scene
    this.sinceLastHit += dt;
  }

  onDetach(): void {
    // super.onDetach() only disconnects handlers on THIS script's own node; a handler connected
    // on another node stays until you disconnect it.
    this.source?.disconnect('touch-scored', this, this.onScoredSignal);
    this.source = null;
    super.onDetach();
  }

  private onScored(_amount: number): void {
    const windowSec = Number(this.config.windowSec) || 1.2;
    this.count = this.sinceLastHit <= windowSec ? this.count + 1 : 1;
    this.sinceLastHit = 0;
    this.node?.emit('combo-changed', this.count); // a new signal for a new mechanic
  }
}
```

- Attach in a scene as `type: user:<ExportedClassName>` (here `user:Combo`). The id is the
  exported class name, not the file name — keep them equal.
- Every `config` key you want editable in the inspector gets one schema entry: `name`
  (= the config key), `type` (`string` `number` `boolean` `color` `enum` `select` `vector2`
  `vector3` `object` `node`), `ui` (`label`, `group`, `min`, `max`, `step`, `slider`,
  `options`, `description`), `getValue`, `setValue`. `setValue` is what the loader calls
  with the scene's value — clamp and coerce there.
- One mechanic = one script, 70–140 lines. Tunable numbers go into `config`, not into
  constants: the human tunes them in the inspector.
- Name methods after intent (`startGame()`, `restart()`, `addCombo()`), not after widgets.

## Lifecycle

`onAttach(node)` → `onStart()` (first frame, scene loaded) → `onUpdate(dt)` every frame
(`dt` = scaled seconds; frozen during hitstop) → `onDetach()`. Parent components start
before children's.

## Members of a Script

- `this.node` — the owner node. `this.config` — the merged config.
- `this.scene` — `SceneService`; may be `undefined` in editor previews, guard it.
- `this.input` — `InputService`.
- `this.findNode(query)` — id, name or slash path → node or `null`.
  `this.getNode(query)` — same, throws when missing.
- Another script on a node: `import { Other } from './Other'; node.getComponent(Other)` —
  pass the **class**, never the `'user:Other'` string.

## Nodes

- Transforms are three.js objects, **mutate, never assign**: `node.position.set(x, y, 0)`,
  `node.position.x += dx`, `node.rotation.z = radians`, `node.scale.set(s, s, 1)`.
  `node.position = …` throws at runtime.
- 2D space: design pixels, origin centre, X right, **Y up**. YAML rotation is degrees;
  `rotation.z` is radians.
- `visible`, `name`, `id`, `children`, `parentNode`, `findById(id)`, `findByName(name)`,
  `adoptChild(child)`, `queueFree()` (safe inside `onUpdate`), `getComponent(Class)`,
  `addComponent(c)`, `removeComponent(c)`.
- 2D node props as fields: `width`, `height`, `opacity`, `zIndex`, `blendMode`.
  `Label2D.setText(text)`; `Bar2D.maxValue`, `Bar2D.setValue(v)`; `Slider2D.value`,
  `Checkbox2D.checked`. Check types with `instanceof Label2D` (import the class).
- **Assigning a display property redraws immediately** — no `setText` / `updateLabel` call
  needed: `label.label = 'x2'`, `label.labelColor = '#ff3355'`, `label.labelFontSize`,
  `label.glowStrength = 2` (clamped 0..4), `glowColor`, `outlineWidth`, `width`, `height` all
  repaint on assignment, exactly as an inspector edit does. `setText(text)` is the same as
  `label = text` plus clearing a bound `labelKey` (localization) and restarting the typewriter.
- Create at runtime with the YAML property names, then parent it:
  `const r = new ColorRect2D({ id: 'flash', width: 100, height: 100, color: '#ffffff' }); parent.adoptChild(r);`
  (also `Sprite2D`, `Label2D({ id, label, labelFontSize, labelColor })`, `Group2D`).

## Signals

- `node.emit('name', ...args)`, `node.connect('name', this, handler)`,
  `node.disconnect('name', this, handler)`. `super.onDetach()` auto-disconnects only the
  handlers this script connected **on its own node** (`this.node.connect(…, this, …)`). A
  handler connected on another node, window listeners, store subscriptions and timers are
  yours to remove in `onDetach` — keep the handler in a field so the same function is passed
  to `disconnect` (see the shape above and "Hosting an existing game").
- UI controls (`Button2D`, `Slider2D`, `Checkbox2D`, `Joystick2D`, …) emit `pressed` (touch
  went down inside), `released`, `click` (down and up inside — a completed tap),
  `pointerdown`, `pointerup`; `Checkbox2D` also `toggled`; `Label2D` emits
  `typewriter-complete`. The recipes wire buttons to `pressed` (instant); `click` can be
  cancelled by sliding off — use it for menus and anything costly.
- Recipe scripts talk through signals on `game-root` (`touch-scored`, `touch-damaged`,
  `score-changed`, `lives-changed`, `time-changed`, `game-won`, `game-lost`). Listen to
  them; add new signal names for new mechanics; never rename existing ones.

## `this.scene`

- Lookup: `findNode(q)`, `findNodeById`, `findNodeByName`, `findNodeByPath`,
  `getRootNodes()`, `getViewportInfo()`, `isPortrait()`.
- Pointer in 2D world space: `scene.getPointer2DWorldPosition()` → `Vector2 | null`
  (primary finger), or `(pointerId)`.
- Spawn: `const n = await scene.instantiate('res://scenes/prefabs/x.pix3scene', { parent, instanceId })`
  (`parent` = node | query; prefab = a scene file with one root). Despawn: `n.queueFree()`.
- Scene change: `await scene.changeScene('res://scenes/menu.pix3scene', { transition: 'fade' | 'none', durationSec: 0.3, onLoaded })`
  (`durationSec` is each of fade-out and fade-in).
- Time: `scene.time.hitstop(ms)` — no options; only on a contact START, never per frame.
  `scene.time.slowMotion(scale, { durationMs, blendMs })` — both real-time ms; no `durationMs`
  = until `scene.time.reset()`.
- Juice — call it together with the mechanic. Every option is optional; defaults shown. Note
  the three transform effects take `duration` (seconds), **not** `durationSec`:
  - `scene.juice.shake(target, { amplitude: 8, frequency: 24, duration: 0.35, decay: 1.5 })` —
    `amplitude` in the node's units (px in 2D), `duration: 0` = until stopped.
  - `punchScale(target, { amount: 0.3, duration: 0.35, vibrato: 3 })` — `amount` 0.3 = +30%.
  - `popIn(target, { from: 0, duration: 0.4, easing: 'backOut' })` — `from` = start scale factor.
  - `flash({ color: '#ffffff', intensity: 1, durationSec: 0.2 })` — full-screen, no target.
  - `burst(anchor, { count: 14, speed: 260, spread: 2π, direction: π/2, lifeSec: 0.5, color | colors, sizePx: 10, gravityY: -600, fadeOut: true, additive: true, zIndex })` (angles in radians).
  - `floatText('+25', { at, color: '#ffffff', fontSizePx: 28, fontFamily: 'Arial', driftPx: 60, durationSec: 0.8, glow, glowStrength: 1.5, zIndex })`.
  - `trail(node, { lifeSec: 0.35, widthPx: 14, color | colors, additive: true, zIndex, maxPoints: 48 })` → `trail.stop()`.

  `target` = node | query | `'camera'` | `'camera2d'`; `anchor` = node | query | `{ x, y }`.
- Tweens: `scene.tween.to(node, { x, y, position: { x, y }, scale, rotation, opacity, width, height }, { durationSec: 0.3, ease: 'cubicOut', delaySec: 0, yoyo: false, repeat: 0, onUpdate, onComplete })`
  → `{ cancel(), finished, isRunning }` (`rotation` in radians, `repeat: -1` = forever, `ease` =
  any easing name: `linear`, `quadOut`, `cubicInOut`, `backOut`, `elasticOut`, …);
  `fadeIn(node, sec)` and `crossFade(a, b, sec)` — no options; `fadeOut(node, sec, { hide: true })`;
  `killAll(target?)`. Default `sec` = 0.3. Prefer these over hand-lerping.
- Audio with no asset: `scene.audio.sfx('tap' | 'score' | 'bounce' | 'explosion' | 'powerup' | 'win' | 'lose' | 'laser' | 'tick', { volume: 1, pitch: 1 })`;
  a file: `await scene.audio.play('res://audio/hit.ogg', { bus: 'sfx' | 'music' | 'master', volume, loop, playbackRate, pan, pitchVariation: 0, volumeVariation: 0 })`.
- Overlap queries without physics response: `scene.collision2d.overlapPoint(x, y, group?)`,
  `overlapCircle(x, y, r, group?)`, `overlapRect(cx, cy, w, h, group?)`, `raycast(…)` over
  nodes carrying `core:Hitbox2D` (the tapper/arena recipes use this).
- 2D physics with response: `core:PhysicsBody2D` + `core:Collider2D` on the same node;
  `scene.physics2d.getBody(node)` → `setVelocity`, `applyImpulse`, `teleport`. Never
  hand-write a 2D solver, never import rapier for 2D. (The bouncer recipe runs its own
  swept solver in `BallBody.ts` — do not add engine physics to its ball.)
- Intents: `scene.commands.register('name', handler, { description })`, `dispatch(name)`.
  The recipes register theirs and publish state with `registerGameDebug` in `GameRules` —
  when you add a mechanic, add its field to that snapshot instead of registering a second one.

## `this.input`

- Per frame: `input.pointerEvents` → `{ type: 'down' | 'move' | 'up' | 'cancel', pointerId, x, y }[]`
  (`cancel` is not a tap); `input.keyEvents`.
- Polled: `input.isPointerDown`, `input.pointerPosition` (canvas space — use
  `scene.getPointer2DWorldPosition()` for world), `input.isPointerOverUI(pointerId)`,
  `input.getButton(name)`, `input.getAxis(name)`.
- Keys held: `input.getButton('Key_ArrowLeft')`, `getButton('Key_D')` — `Key_` + the
  `KeyboardEvent.code` (this is what the recipes' controllers use). In `input.keyEvents`
  compare `event.code` (`'KeyW'`, `'ArrowUp'`, `'Space'`) — case-sensitive.

## Hosting an existing game (not a recipe)

- **Use the game's own channel.** Before wiring a script, find how the game talks:
  `grep -rn "CustomEvent\|dispatchEvent\|addEventListener\|subscribe(\|EventTarget\|emit(" src scripts`.
  Window `CustomEvent`s, an `EventTarget` bus or a store with `subscribe()` are common; node
  signals are only one option. Import the game's bus/store module with a relative path from
  your script.
- **`onDetach` cleans up signals on the script's own node only.** Everything else you register
  must be undone by hand, or each play/stop in the editor leaks one more listener:

  ```ts
  private readonly onScore = (e: Event): void => { /* (e as CustomEvent).detail */ };
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  onStart(): void {
    window.addEventListener('score-changed', this.onScore);
    this.unsubscribe = store.subscribe(() => { /* … */ }); // the game's own store; keep what it returns
  }

  onDetach(): void {
    window.removeEventListener('score-changed', this.onScore);
    this.unsubscribe?.();
    if (this.timer !== null) clearInterval(this.timer);
    super.onDetach();
  }
  ```
- The project's own `AGENTS.md` wins on process (planning first, where config goes); this kit
  wins on Pix3 facts (YAML, runtime API, `pix3 check`).

## Traps (compile clean, break at runtime)

- Assigning `position` / `rotation` / `scale` throws. Mutate them.
- A component that throws in `onStart` / `onUpdate` is **auto-disabled** and the game keeps
  running — the thing just freezes. Guard lookups (`if (!node) { console.warn(...); return; }`).
  With the live channel, `read_errors` after a run shows it; without, tell the human to look
  at the editor's console.
- `as any` on `this.node` hides exactly the error above, and from `pix3 check`. Use
  `instanceof` narrowing.
- Hitstop every frame of an overlap freezes the game — edge-trigger it.
- A hidden `UIControl2D` takes no input; `onUpdate` still runs on hidden nodes.
- `getComponent('user:X')` is wrong — pass the class.
- Ending a run belongs to the recipe's `GameRules`: call its `finish(won)`; do not show the
  result overlay yourself (RETRY would stay disabled).

## Known gaps

- `lit`'s `property` / `state` decorators are re-exported by `@pix3/runtime` but their types
  are not bundled into `.pix3/types/` (they type-check as `any`); scripts do not need them.
- Scripts reach engine internals only through `@pix3/runtime`'s public exports; anything the
  declarations do not show is not part of the contract.
