# Agent harness: verifying transient / input-gated visual effects (hover-scale et al.)

Status: **design approved, ready to implement** — do A, then B, then C. D is designed but deferred.

Trigger case (real logged failure): "make the Play Button scale up slightly on hover"
(`samples/HelloWorld/scripts/HoverScale.ts`). The agent attached the script correctly, then
burned turns re-taking `viewport_screenshot` in a loop because every screenshot showed the
button at rest.

## 1. Root cause (verified against current code)

1. **No hover primitive.** `GameInputStep.type` is `'tap' | 'key' | 'keys' | 'drag' | 'wait'`
   (`src/services/agent/GameInputService.ts` L20-37). `pointermove` is dispatched only inside
   the `drag` step (L483), and `dispatchPointer` hardcodes `buttons: type === 'pointerup' ? 0 : 1`
   (L533) — every move is a *pressed* move. There is no way to synthesize a plain hover
   (pointermove with `buttons: 0`, no down/up), so the agent cannot put a `Button2D` into
   `isHovering` state through the tools at all. (Runtime side: `UIControl2D.updatePointerState`,
   `packages/pix3-runtime/src/nodes/2D/UI/UIControl2D.ts` L174-219, derives hover *level-triggered*
   from the tracked pointer position each tick; `Button2D.tick` L179-189 polls
   `getPointerWorldPosition()` every frame; `InputService.onPointerMove`
   (`packages/pix3-runtime/src/core/InputService.ts` L261-273) updates `pointerPosition` even when
   no pointer is down — so a single synthetic `buttons:0` pointermove is sufficient.)

2. **`LiveNodeSnapshot` omits scale and opacity** (`GameInputService.ts` L40-61: position,
   worldPosition, rotationZ, childCount, visibleChildCount — nothing else). So the whole
   `game_observe` / `game_input` state-verification path is blind to exactly what hover-scale,
   `core:PunchScale`, `core:PopIn`, squash/stretch and Fade animate. The skills push "verify by
   state, not screenshots" — but for this entire class of effects the state path does not exist.

3. **Consequence = the observed symptom.** `game_input` and `viewport_screenshot` are separate
   tool calls with no overlap. `game_input` ends every gesture (tap dispatches `pointerup`,
   L470; keys are released, L501-503), so by the time a separate screenshot call runs, the
   effect has lerped back to rest. A screenshot of a transient effect taken *after* the input
   call structurally always shows the resting state → "nothing there" → reshoot loop.

Two runtime facts that shape the design:

- **Scale is always readable.** `NodeBase extends Object3D`
  (`packages/pix3-runtime/src/nodes/NodeBase.ts` L27), so `node.scale` is a `THREE.Vector3` on
  every live node — the snapshot field can be non-optional.
- **Opacity is readable only on `Node2D`/`Node3D` subclasses** — both expose a numeric
  `get opacity()` (local value, 0..1): `Node2D.ts` L105-107, `Node3D.ts` L53-55. Plain
  `NodeBase` nodes (groups, roots) do not. The snapshot field must be optional and
  duck-typed. Note it is the *local* opacity — a parent-driven fade does not show on a child.

---

## 2. Change A — scale + opacity in snapshots, deltas, and the watch recorder

Highest leverage: makes hover-scale, PunchScale, PopIn, squash/stretch and Fade provable by
state, including effects that *return to rest inside the window* (peak tracking mirrors
`visibleChildPeak` / `maxChildDistance`).

### A.1 `LiveNodeSnapshot` (`GameInputService.ts` L40-61)

Add after `rotationZ`:

```ts
  rotationZ: number;
  /** Local scale — what PunchScale/PopIn/hover-scale animate (round3). */
  scale: { x: number; y: number; z: number };
  /**
   * Local opacity (0..1, round3). Present only for nodes that expose it
   * (Node2D/Node3D subclasses); the value is LOCAL — a parent fade does not
   * show here, observe the node that fades.
   */
  opacity?: number;
  childCount: number;   // (unchanged)
```

`snapshotOne` (L606-624) additions — duck-type opacity, round3 both (positions stay
unrounded, as today; scale/opacity are ~1-magnitude ratios where 3 decimals are plenty and
payload discipline matters):

```ts
    const opacity = (node as { opacity?: unknown }).opacity;
    return {
      // ...existing fields...
      rotationZ: node.rotation.z,
      scale: { x: round3(node.scale.x), y: round3(node.scale.y), z: round3(node.scale.z) },
      ...(typeof opacity === 'number' ? { opacity: round3(opacity) } : {}),
      childCount: children.length,
      // ...
    };
```

### A.2 `ObservedNodeDelta` (L77-108) + `describeDelta` (L635-669)

Add after `childrenChanged`:

```ts
  childrenChanged?: boolean;
  /**
   * Endpoint scale change (after − before per axis) plus `ratio` — the axis
   * ratio farthest from 1 (a 1.08 hover-scale reads as ratio≈1.08). `ratio` is
   * omitted when the before-scale on that axis is ~0 (PopIn from 0). Present
   * whenever both endpoints resolved.
   */
  scaleDelta?: { x: number; y: number; z: number; ratio?: number };
  /** True when any scale axis changed by more than 1% between endpoints. */
  scaled?: boolean;
  /** Opacity change (after − before, round3); present only when both endpoints expose opacity. */
  opacityDelta?: number;
```

New module constants next to `MOVED_THRESHOLD` (L169):

```ts
/** Per-axis scale change that counts as "scaled" (1% — hover-scale presets are 5-10%). */
const SCALE_EPS = 0.01;
/** Opacity change that counts as a fade (5% — below that is float noise / trailing lerp). */
const OPACITY_EPS = 0.05;
```

`describeDelta` — after computing `base` (before the direction block):

```ts
    const sdx = after.scale.x - before.scale.x;
    const sdy = after.scale.y - before.scale.y;
    const sdz = after.scale.z - before.scale.z;
    // Ratio on the axis that moved the most, guarded against a ~0 base (PopIn).
    const axes: Array<[number, number]> = [[sdx, before.scale.x], [sdy, before.scale.y], [sdz, before.scale.z]];
    const [dMax, bMax] = axes.reduce((acc, cur) => (Math.abs(cur[0]) > Math.abs(acc[0]) ? cur : acc));
    base.scaleDelta = {
      x: round3(sdx), y: round3(sdy), z: round3(sdz),
      ...(Math.abs(bMax) > 1e-3 ? { ratio: round3((bMax + dMax) / bMax) } : {}),
    };
    base.scaled = Math.max(Math.abs(sdx), Math.abs(sdy), Math.abs(sdz)) > SCALE_EPS;
    if (typeof before.opacity === 'number' && typeof after.opacity === 'number') {
      const od = round3(after.opacity - before.opacity);
      if (Math.abs(od) > OPACITY_EPS) base.opacityDelta = od;
    }
```

(`scaleDelta`/`scaled` are always emitted when both endpoints exist — mirroring `delta`/`moved`;
`opacityDelta` only when meaningful, to keep payloads flat for the 99% of nodes that never fade.)

### A.3 `NodeWatchRecorder` (`src/services/agent/NodeWatchRecorder.ts`)

This is what proves a PunchScale/PopIn that fires AND settles back inside the window — the
endpoints alone would read identical. Mirror `maxDistanceFromStart` exactly.

`NodeActivity` (L43-62) — add after `maxChildDistance`:

```ts
  maxChildDistance: number;
  /**
   * Peak per-axis |scale − startScale| of the node itself during the window
   * (absolute units, not a ratio — robust to a PopIn that starts at scale 0).
   * A PunchScale that pulses and returns to rest still registers here.
   */
  maxScaleDelta: number;
  /** Opacity extremes seen during the window; present only when the node exposes opacity. */
  opacityRange?: { min: number; max: number };
  stateChanges?: Record<string, [Json, Json]>;   // (unchanged)
```

`WatchLogEntry.kind` (L38): extend the union with `'scale' | 'fade'`.

`WatchNodeLike` (L73-81) — add optional structural fields (keeps fakes in specs valid):

```ts
  scale?: { x: number; y: number; z: number };
  opacity?: number;
```

Module constants next to `MOVE_EPS` (L33): `SCALE_EPS = 0.01`, `OPACITY_EPS = 0.05` (same
values as GameInputService; duplicate the constants — the recorder deliberately does not import
from services).

`Tracked` (L88-111) — add:

```ts
  startScale: Vec3;
  maxScaleDelta: number;
  opacityMin: number | null;   // null = node exposes no opacity
  opacityMax: number | null;
  scaleLogged: boolean;        // one 'scale' log entry per window, not per sample
  fadeLogged: boolean;
```

`track()` (L195-224): seed `startScale` from `node.scale ?? {x:1,y:1,z:1}` (copy, don't
alias the live Vector3), `maxScaleDelta: 0`, `opacityMin/Max` from
`typeof node.opacity === 'number' ? node.opacity : null`, both `*Logged: false`.

`sample()` (L253-305) — after the `maxDistanceFromStart` update:

```ts
      const s = t.node.scale;
      if (s) {
        const d = Math.max(
          Math.abs(s.x - t.startScale.x),
          Math.abs(s.y - t.startScale.y),
          Math.abs(s.z - t.startScale.z)
        );
        if (d > t.maxScaleDelta) t.maxScaleDelta = d;
        if (!t.scaleLogged && d > SCALE_EPS) {
          t.scaleLogged = true;
          this.pushLog(t, 'scale', `scale ${round3(s.x)}×${round3(s.y)} (was ${round3(t.startScale.x)}×${round3(t.startScale.y)})`);
        }
      }
      const op = t.node.opacity;
      if (typeof op === 'number' && t.opacityMin !== null && t.opacityMax !== null) {
        t.opacityMin = Math.min(t.opacityMin, op);
        t.opacityMax = Math.max(t.opacityMax, op);
        if (!t.fadeLogged && t.opacityMax - t.opacityMin > OPACITY_EPS) {
          t.fadeLogged = true;
          this.pushLog(t, 'fade', `opacity ${round3(t.opacityMin)}..${round3(t.opacityMax)}`);
        }
      }
```

`finish()` (L312-346):

```ts
    const fadeRange =
      t.opacityMin !== null && t.opacityMax !== null && t.opacityMax - t.opacityMin > OPACITY_EPS
        ? { min: round3(t.opacityMin), max: round3(t.opacityMax) }
        : undefined;
    const active =
      /* ...existing clauses... */ ||
      t.maxScaleDelta > SCALE_EPS ||
      fadeRange !== undefined ||
      hasState;
    const activity: NodeActivity = {
      // ...existing fields...
      maxScaleDelta: round3(t.maxScaleDelta),
      ...(fadeRange ? { opacityRange: fadeRange } : {}),
      active,
    };
```

Note the 100 ms poll (`WATCH_POLL_MS`) vs a fast effect: HoverScale at speed 14 crosses
SCALE_EPS within ~2 frames, and a `core:PunchScale` pulse lasts ~300 ms — several samples each.
A one-frame flash can slip between polls; that is accepted (same limitation the existing
channels have) and is one reason C tells the model to prefer sustained holds (`ms` ≥ 600).

### A.4 Verdict plumbing (`GameInputService.ts`)

`describeActivity` (L716-737) — add after the `maxChildDistance` clause:

```ts
      if (act.maxScaleDelta > SCALE_EPS) {
        bits.push(`scaled ±${round3(act.maxScaleDelta)} (peak)`);
      }
      if (act.opacityRange) {
        bits.push(`opacity ${act.opacityRange.min}..${act.opacityRange.max}`);
      }
```

Also extend the endpoint-only branch: in `buildVerdict` (L793-801) the `reacted` predicate
becomes

```ts
      const reacted =
        delta.moved === true ||
        delta.childrenChanged === true ||
        delta.scaled === true ||
        delta.opacityDelta !== undefined ||
        delta.activity?.active === true;
```

and in `describeActivity`'s non-activity fallback, before `'children changed'`, surface the
endpoint scale: `if (d.scaled) bits.push(`scale ×${d.scaleDelta?.ratio ?? '?'}`)`.

Finally, update the `NO ACTIVITY` sentence (L827) to enumerate the new channels: "no watched
node moved/scaled/faded, no children spawned/shown, …".

### A.5 Expectation verdict — recommendation: **no new enum value**

Considered `'scaled'` / `'grew'` in `GameInputExpectation` (L69-75). Rejected:

- `evaluateExpectation`'s `'activity'` case (L704-709) keys off `act.active === true`, which
  after A.3 already includes scale/opacity peaks — `expect: {'Play Button': 'activity'}` passes
  exactly when the hover effect fired, and `directionNote` (via `describeActivity`) already says
  *why* ("scaled ±0.08 (peak)").
- A pass/fail "grew" without a target magnitude adds no information beyond `active`; with a
  magnitude it becomes a new parameter surface for marginal value. Reading
  `scaleDelta.ratio` / `activity.maxScaleDelta` is strictly more informative.
- Every enum value costs tool-schema tokens on every request and another branch to keep honest.

One required touch: extend the `'activity'` case's `reacted` predicate to also accept the
endpoint signals `d.scaled === true || d.opacityDelta !== undefined` (mirroring `moved` /
`childrenChanged` already being accepted there).

---

## 3. Change B — `hover` step in `game_input`

### B.1 Semantics

`{type:'hover', target:'Play Button', ms:900}` — resolve the aim exactly like `tap`
(`resolveClientPoint`, L556-591: node by name/id → `projectNodeToCanvas`, or explicit world
`x`/`y` → `projectWorldPointToCanvas`), dispatch **one** `pointermove` with `buttons: 0` (no
`pointerdown`/`pointerup`), then sleep `ms`. Default `DEFAULT_HOVER_MS = 800` — long enough for
a lerp-based hover effect (speed ≥ 8) to converge and for the 100 ms recorder poll to take ~8
samples, short vs the 15 s budget.

Why one event is enough: `InputService.onPointerMove` updates `pointerPosition` on every move
regardless of button state (it only skips the `pointerEvents` queue when no pointer is captured,
`InputService.ts` L261-273), and every `UIControl2D` derives `isHovering` *level-triggered* from
that position each tick. No generic `move` step is needed — `hover` with explicit `x`/`y` *is*
the generic buttons-0 move; one name, one code path.

**Hover persists after the call.** Nothing is "released" at the end of a hover step — the
runtime keeps the last pointer position, so the control stays hovered until something moves the
pointer. This is deliberate and is documented in the tool description and skill: it means
(a) a follow-up `viewport_screenshot` right after a hover `game_input` *does* show the hovered
state (kills most of the need for D), and (b) to verify the return-to-rest half, the agent
"hovers away": a second step `{type:'hover', x:<empty>, y:<empty>}` at a point outside every
control.

### B.2 Code changes (`GameInputService.ts`)

`GameInputStep` (L20-37):

```ts
export interface GameInputStep {
  type: 'tap' | 'key' | 'keys' | 'drag' | 'wait' | 'hover';
  /** tap/drag/hover: node name or nodeId to aim at (projected to its live position). */
  target?: string;
  /** tap/drag/hover: explicit 2D world coordinates (used when no target given). */
  x?: number;
  y?: number;
  // ...
  /** Duration in ms: key/keys hold time, drag movement time, hover hold time, or wait time. */
  ms?: number;
```

Constant next to `DEFAULT_DRAG_MS` (L167): `const DEFAULT_HOVER_MS = 800;`

`stepDurationMs` (L434-448): `case 'hover': return Math.max(0, step.ms ?? DEFAULT_HOVER_MS);`

`dispatchPointer` (L521-548) — parametrize `buttons`; the override flows into `init` *before*
the `PointerEvent` / happy-dom `Event`-fallback split, so both branches inherit it:

```ts
  private dispatchPointer(
    canvas: HTMLCanvasElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    client: { x: number; y: number },
    options?: { buttons?: number }
  ): void {
    const init = {
      // ...existing fields...
      buttons: options?.buttons ?? (type === 'pointerup' ? 0 : 1),
      // ...
    };
```

(Existing call sites are untouched — the default preserves today's behavior, including drag's
pressed moves.)

`runStep` (L451-494) — new case, mirroring `tap`:

```ts
      case 'hover': {
        const point = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof point === 'string') return point;
        this.dispatchPointer(runtime.canvas, 'pointermove', point, { buttons: 0 });
        await sleep(this.stepDurationMs(step));
        return null;
      }
```

and the unknown-type message (L492) becomes `Use tap | hover | key | keys | drag | wait.`

### B.3 Composition with observe/expect

Nothing new needed: the recorder window in `run()` (L284-306) already spans all steps + the
`settleMs` tail, so a hover step's scale ramp is sampled by A.3 and — because hover persists —
also visible in the endpoint `scaleDelta`. Canonical call:

```json
{"steps":[{"type":"hover","target":"Play Button","ms":900}],
 "expect":{"Play Button":"activity"}}
```

### B.4 `AgentToolRegistry.ts` — `game_input` descriptor (L714-784)

- `steps.items.properties.type.enum` (L726): add `'hover'`.
- `target` description (L727): "Node name or nodeId to tap/hover/drag from."
- `ms` description (L742): "Hold/drag/wait/hover duration in ms."
- Tool `description` (L716): insert after the tap sentence:

> `{type:'hover',target:'PlayButton',ms:900}` moves the pointer OVER a node without pressing
> (buttons:0) and holds — the only way to trigger hover states (Button2D hover skin,
> hover-scale scripts). Hover PERSISTS after the call (the pointer stays where you left it);
> to verify the return-to-rest, hover away: `{type:'hover',x:<empty area>,y:...}`. Observed
> nodes also report `scale`/`opacity`, endpoint `scaleDelta`/`scaled`/`opacityDelta`, and
> window peaks `activity.maxScaleDelta`/`activity.opacityRange` — a PunchScale/PopIn/fade that
> returns to rest inside the window is still provable, with zero screenshots.

- `observe` description (L756): append "…, maxScaleDelta/opacityRange (scale/fade effects,
  even ones that return to rest)".
- `game_observe` description (L788): mention scale/opacity in the listed per-node channels.

---

## 4. Change C — `verify-and-fix.md` amendments (paste-ready)

### 4.1 New bullet in "The loop", step 2b, after the "Spawners / shooters / pools / HUD" bullet:

```markdown
   - **Transient / interaction-gated visual effects** (hover states, hover-scale, press
     effects, `core:PunchScale`, `core:PopIn`, fades, flashes, shakes): verify by STATE, never
     by a separate screenshot. A `viewport_screenshot` taken after `game_input` returns ALWAYS
     shows the resting state — the gesture ended and the effect lerped back before the
     screenshot call even started. Reshooting will not fix this; it is structural.
     Instead, trigger and measure in ONE `game_input` call:
     `{steps:[{type:'hover',target:'Play Button',ms:900}],expect:{'Play Button':'activity'}}`
     → read `observed['Play Button'].scaleDelta.ratio` (endpoint, e.g. ≈1.08 for a hover-scale)
     and `activity.maxScaleDelta` / `activity.opacityRange` (window peaks — these catch a
     PunchScale/PopIn/flash that fired AND settled back inside the window). For press effects
     use a `tap` with a generous `holdMs` and read the same fields. Hover persists after the
     call (the synthetic pointer stays put), so to prove the return-to-rest half, hover away —
     `{type:'hover',x:<empty area>,y:<empty area>}` — and check scale returns to base.
     Screenshots are for STATIC properties only: layout, colors, placement.
```

### 4.2 Amend loop step 3 ("Look at it"), append:

```markdown
   Do NOT use screenshots to verify transient/hover/press effects — see 2b: by the time a
   separate screenshot runs, the effect is back at rest, and reshooting in a loop proves
   nothing. (Exception: a hover state deliberately left active by the last `hover` step is
   still on screen and MAY be screenshotted for a visual once the state delta already passed.)
```

### 4.3 New entry in "Common runtime problems and fixes", after "A button does nothing":

```markdown
- **A hover/press/juice effect "doesn't work" but screenshots look normal** — screenshots taken
  after `game_input` always show the resting state (transient effects reset when the gesture
  ends). Verify with a state delta instead: `hover` (or `tap` with `holdMs`) the node and read
  `scaleDelta`/`scaled`/`opacityDelta` + `activity.maxScaleDelta`/`activity.opacityRange` in the
  result. If those are flat, the effect really didn't fire — check the script is attached and
  reads `isHovering`/signals, and `read_errors` for an auto-disabled component.
```

### 4.4 `game-prototype.md` (consistency, one line)

In the "verify by state instead of screenshots" passage (L67 area), extend the enumeration of
provable signals with "scale/opacity peaks (hover, PunchScale, PopIn, fades)".

---

## 5. Change D — synchronized in-window capture: **designed, deferred**

Sketch (do not build now): `game_input` gains `captureAtMs?: number` — at `t = captureAtMs`
into the step script, capture the running game canvas (the same game-canvas path
`viewport_screenshot` uses when playing) and attach it to the result via the existing
image-handle convention (`AgentToolRegistry.ts` L148). Cap: one capture per call, reuse the
`maxSize` default (1024).

Why deferred:

- **A removes the need for proof-by-pixels**: scale/opacity peaks + endpoint deltas prove the
  entire trigger class (hover-scale, PunchScale, PopIn, fade) numerically.
- **B removes the need for hover specifically**: hover is level-triggered and persists after
  the call, so a plain `viewport_screenshot` immediately after a hover `game_input` *does*
  capture the hovered frame when a human-visible confirmation is wanted.
- The remaining gap — sub-second transients that are neither transform, opacity, component
  state, nor child-structure (shader flash color, particle burst look) — is rare and already
  has a partial answer (`analyze_image` on a persisted state). Build D only if evals after A+B+C
  still show reshoot loops on that residual class.

---

## 6. Edge cases

- **Nodes without scale semantics** (groups, containers, roots): `Object3D.scale` still exists
  and stays `(1,1,1)` — `scaleDelta` reads as zeros, `scaled:false`; no special-casing.
- **2D vs 3D scale**: `maxScaleDelta` and `scaled` take the max over all three axes, so a 3D
  squash on z counts; 2D nodes simply never move z. `scaleDelta.ratio` picks the
  most-changed axis, which is what a hover/punch preset drives.
- **PopIn from scale 0**: peak metric is an absolute per-axis delta (not a ratio) so it never
  divides by zero; the endpoint `ratio` is omitted when the base axis is ~0 (`|before| ≤ 1e-3`).
- **Opacity is local**: `Node2D._computedOpacity` (parent-inherited) is private; the snapshot
  reads the public local `opacity` getter. A parent-driven fade must be verified on the parent
  — C's text says "observe the node that fades"; the tool description doesn't need this detail.
- **Nodes without opacity**: duck-typed (`typeof node.opacity === 'number'`); field omitted from
  snapshot, `opacityDelta`/`opacityRange` omitted, recorder skips the channel (`opacityMin: null`).
- **happy-dom (specs)**: `dispatchPointer`'s fallback (L539-547) already builds a plain `Event`
  from the same `init` object; the `buttons` override lives in `init`, so hover works in specs
  unchanged. `NodeWatchRecorder` specs use structural fakes — `scale`/`opacity` are optional on
  `WatchNodeLike`, so existing fakes stay valid.
- **Focus-pause**: `run()`/sampled `observe()` already wrap the window in
  `setFocusPauseSuppressed(true)` (L278, L397), so the runner ticks and `Button2D.tick` sees the
  hover. After the call the suppression lifts; if the window is unfocused the runner freezes —
  a persisted hover just stays frozen at its hovered scale (harmless, and actually screenshot-able).
  A fully hidden tab still can't tick (rAF stops) — existing documented caveat, unchanged.
- **`pointerleave` → `onPointerUp` mapping** (`InputService.ts` L195): only real pointer
  gestures fire `pointerleave`; the synthetic hover never does, so no phantom pointer-up.
- **Input lock** (`lockDepth > 0`, cutscenes): hover moves are swallowed like all input — the
  NO ACTIVITY verdict text already points at "paused?/overlay?" style causes; no change.
- **Caps**: no new caps. `MAX_WATCH_NODES` (8), `MAX_LOG_ENTRIES` (10), `MAX_STATE_CHANGES` (10)
  unchanged; scale/opacity add O(1) per tracked node per sample. Payload growth per observed
  node: one vec3 + ≤1 number in the snapshot, ≤2 small objects in delta/activity — all round3.
  Hover obeys the existing `MAX_TOTAL_MS` (15 s) budget via `stepDurationMs`.
- **Trailing lerp at the "after" endpoint**: with `speed: 14` and `DEFAULT_SETTLE_MS = 300`, the
  scale is ≥99% converged at the endpoint snapshot; `SCALE_EPS = 0.01` sits safely below a 1.05+
  preset and above residual lerp noise on the *return* check.

## 7. Verification story — the original task, zero screenshots

Task: "make the Play Button scale up slightly on hover" (HoverScale.ts, `hoverScale: 1.08`).

1. Agent writes `scripts/HoverScale.ts`, attaches it to `Play Button`, `compile_scripts` →
   `check_scripts` → `play_start` → `read_errors` clean.
2. **Prove the hover-up half** — one call:
   `game_input {steps:[{type:'hover',target:'Play Button',ms:900}], expect:{'Play Button':'activity'}}`
   → `verdict: "GAMEPLAY REACTED: Play Button: scaled ±0.079 (peak)"`;
   `observed['Play Button'].scaleDelta ≈ {x:0.079, y:0.079, z:0, ratio:1.079}`, `scaled:true`,
   `directionOk:true`, `activity.maxScaleDelta ≈ 0.079`, `activity.log` has a
   `scale 1.062×1.062 (was 1×1)` entry. (Slightly under 0.08 = trailing exponential lerp;
   comfortably above `SCALE_EPS`.)
3. **Prove the return-to-rest half** — hover away:
   `game_input {steps:[{type:'hover',x:5,y:5},{type:'wait',ms:500}], expect:{'Play Button':'activity'}}`
   → `scaleDelta.ratio ≈ 0.927` (1/1.08), `scaled:true`, after-snapshot `scale ≈ {1,1,1}`.
4. Done. No `viewport_screenshot` in the loop. (Optionally, for a human-facing before/after:
   re-hover with step 2 and take one screenshot while the persisted hover is still active.)

Before this change, step 2 was impossible (no hover primitive) and steps 2-3 were blind
(no scale in any snapshot) — the only signal left was a screenshot, which structurally always
showed rest.

## 8. Implementation checklist (ordered)

**A — snapshot/delta/recorder** (`src/services/agent/GameInputService.ts`,
`src/services/agent/NodeWatchRecorder.ts`, `src/services/agent/AgentToolRegistry.ts`)
1. `LiveNodeSnapshot.scale` (+optional `opacity`) + `snapshotOne` (A.1).
2. `ObservedNodeDelta.scaleDelta/scaled/opacityDelta` + `describeDelta` + `SCALE_EPS`/`OPACITY_EPS` (A.2).
3. Recorder: `NodeActivity.maxScaleDelta/opacityRange`, `WatchLogEntry` kinds, `WatchNodeLike`
   optional fields, `Tracked` seeds, `sample()`, `finish()` incl. `active` (A.3).
4. `describeActivity`, `buildVerdict` reacted-predicate + NO-ACTIVITY text,
   `evaluateExpectation` `'activity'` case (A.4, A.5).
5. Descriptor text: `observe` param + `game_observe` description mention scale/opacity (B.4 tail).
6. Specs: extend `src/services/agent/NodeWatchRecorder.spec.ts` (fake node pulses scale up and
   back inside the window → `maxScaleDelta` > 0, `active:true`; opacity dip → `opacityRange`;
   fakes WITHOUT scale/opacity still pass) and `src/services/agent/GameInputService.spec.ts`
   (snapshot carries scale; delta reports `scaled`/`ratio`; opacity omitted for plain NodeBase).

**B — hover step** (`GameInputService.ts`, `AgentToolRegistry.ts`)
7. `GameInputStep.type` + doc comments, `DEFAULT_HOVER_MS`, `stepDurationMs`,
   `dispatchPointer` `options.buttons`, `runStep` case + unknown-type message (B.2).
8. `game_input` schema enum + `target`/`ms` descriptions + tool description text (B.4).
9. Specs: `GameInputService.spec.ts` — hover dispatches exactly one `pointermove` with
   `buttons:0` and no down/up; default duration 800; hover+expect activity end-to-end against a
   fake runner whose node scales while pointer is in bounds.

**C — skills** (`src/services/agent/agent-skills/verify-and-fix.md`,
`src/services/agent/agent-skills/game-prototype.md`)
10. Paste sections 4.1-4.3 into verify-and-fix.md; one-line 4.4 into game-prototype.md.

**D — deferred.** Re-evaluate after an agent eval run (S-series) with A+B+C shipped; build only
if reshoot loops persist on non-transform/opacity transients (section 5 criteria).
