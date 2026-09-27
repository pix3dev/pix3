---
name: pix3-scripts
description: How to write a Pix3 game script (scripts/*.ts, `export class X extends Script`, attached as `user:X`) — lifecycle, the required getPropertySchema, config, node lookup, signals, transforms, spawning, input, juice/tweens/audio, 2D physics, scene changes, and the traps that compile clean and break at runtime. Use BEFORE writing or editing any file in scripts/.
---

# Writing a script

Everything here is exported from `@pix3/runtime`; use it directly instead of searching for
it. Import only from `@pix3/runtime`, `three`, and sibling files in `scripts/` (relative
paths — all `scripts/` files are bundled together).

## Shape (copy this)

```ts
import { Script, type PropertySchema } from '@pix3/runtime';

export class Combo extends Script {
  private count = 0;
  private sinceLastHit = Infinity;

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
    const source = this.findNode(String(this.config.sourceNode ?? ''));
    if (!source) {
      console.warn(`[Combo] Source node "${this.config.sourceNode}" not found.`);
      return;
    }
    source.connect('touch-scored', this, (...args: unknown[]) => this.onScored(Number(args[0]) || 0));
  }

  onUpdate(dt: number): void {
    if (!this.scene) return; // editor previews may run without a scene
    this.sinceLastHit += dt;
  }

  onDetach(): void {
    super.onDetach(); // disconnects this script's signal handlers
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
- Create at runtime with the YAML property names, then parent it:
  `const r = new ColorRect2D({ id: 'flash', width: 100, height: 100, color: '#ffffff' }); parent.adoptChild(r);`
  (also `Sprite2D`, `Label2D({ id, label, labelFontSize, labelColor })`, `Group2D`).

## Signals

- `node.emit('name', ...args)`, `node.connect('name', this, handler)`,
  `node.disconnect('name', this, handler)`. `Script.onDetach` auto-disconnects.
- UI controls (`Button2D`, `Slider2D`, `Checkbox2D`, `Joystick2D`, …) emit `pressed`,
  `released`, `click`, `pointerdown`, `pointerup`; `Checkbox2D` also `toggled`; `Label2D`
  emits `typewriter-complete`. The recipes wire buttons to `pressed`.
- Recipe scripts talk through signals on `game-root` (`touch-scored`, `touch-damaged`,
  `score-changed`, `lives-changed`, `time-changed`, `game-won`, `game-lost`). Listen to
  them; add new signal names for new mechanics; never rename existing ones.

## `this.scene`

- Lookup: `findNode(q)`, `findNodeById`, `findNodeByName`, `findNodeByPath`,
  `getRootNodes()`, `getViewportInfo()`, `isPortrait()`.
- Pointer in 2D world space: `scene.getPointer2DWorldPosition()` → `Vector2 | null`
  (primary finger), or `(pointerId)`.
- Spawn: `const n = await scene.instantiate('res://scenes/prefabs/x.pix3scene', { parent })`
  (prefab = a scene file with one root). Despawn: `n.queueFree()`.
- Scene change: `await scene.changeScene('res://scenes/menu.pix3scene', { transition: 'fade', durationSec: 0.3 })`.
- Time: `scene.time.hitstop(ms)` (only on a contact START, never per frame),
  `scene.time.slowMotion(scale, { durationMs, blendMs })`.
- Juice — call it together with the mechanic: `scene.juice.shake(target, {…})`,
  `punchScale(target, {…})`, `popIn(target, {…})`, `flash({…})`,
  `burst(anchor, { count: 14, speed: 260, lifeSec: 0.5, color, sizePx: 10 })`,
  `floatText('+25', { at, color, fontSizePx: 28, driftPx: 60, durationSec: 0.8 })`,
  `trail(node, { lifeSec: 0.35, widthPx: 14, color })`. `target` = node | query | `'camera2d'`;
  `anchor` = node | query | `{ x, y }`.
- Tweens: `scene.tween.to(node, { x, y, scale, rotation, opacity, width, height }, { durationSec: 0.3, ease: 'cubicOut', delaySec, yoyo, repeat, onComplete })`
  → `{ cancel(), finished }`; `fadeIn(node, sec)`, `fadeOut(node, sec, { hide: true })`,
  `crossFade(a, b, sec)`. Prefer these over hand-lerping.
- Audio with no asset: `scene.audio.sfx('tap' | 'score' | 'bounce' | 'explosion' | 'powerup' | 'win' | 'lose' | 'laser' | 'tick')`;
  a file: `await scene.audio.play('res://audio/hit.ogg', { bus: 'sfx' })`.
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

## Traps (compile clean, break at runtime)

- Assigning `position` / `rotation` / `scale` throws. Mutate them.
- A component that throws in `onStart` / `onUpdate` is **auto-disabled** and the game keeps
  running — the thing just freezes. Guard lookups (`if (!node) { console.warn(...); return; }`).
- `as any` on `this.node` hides exactly the error above. Use `instanceof` narrowing.
- Hitstop every frame of an overlap freezes the game — edge-trigger it.
- A hidden `UIControl2D` takes no input; `onUpdate` still runs on hidden nodes.
- `getComponent('user:X')` is wrong — pass the class.
- Ending a run belongs to the recipe's `GameRules`: call its `finish(won)`; do not show the
  result overlay yourself (RETRY would stay disabled).
