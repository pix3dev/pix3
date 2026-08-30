# Physics engine for Pix3 — design

Status: **approved in principle, implementation deferred** (2026-08-30). The shape of the
system is settled and Q1 below is decided — the hand-written solver. Nothing here is built
yet; pick this up as a fresh phase-1 branch when the work is scheduled.
Related: `.plans/done/playable-export-size.md`, `docs/nodes-and-systems.md` §4 "Physics" / "2D collision".

## 0. Recommendation (read this first)

Build an **engine-level 2D physics system with a small hand-written impulse solver — no
Rapier in the 2D path** — shipped as two `core:*` script components (`core:PhysicsBody2D`,
`core:Collider2D`) plus a `scene.physics2d` service, stepped in the existing fixed-step slot
of `SceneRunner`, and stripped from exports by the existing mentions mechanism so a game
without physics ships **zero** extra bytes. **3D physics stays game-level** (the current
Rapier-in-user-scripts arrangement, which DeepCore already uses productively) and is only
wrapped into engine components in a later, demand-gated phase using the Spine-style
host-injected-module pattern. This is *not* "don't build it": Godot and Unity ship physics
as a built-in, the engine-vs-game rule (`docs/nodes-and-systems.md:15-28`) says a rigidbody
node passes that test, and the evidence that games need it is in this repo — the bouncer
template hand-writes a swept solver (`src/templates/projects/recipe-bouncer-2d/files/scripts/BallBody.ts:4-20`)
precisely because `core:Hitbox2D` ignores rotation and there is no solver
(`packages/pix3-runtime/src/core/Collision2DService.ts:14-18`). What we deliberately do NOT
build is a Rapier-backed always-available physics node set: Rapier's wasm is ~2 MB
(`CLAUDE.md` "Runtime API exposure"), larger than the entire 1.34 MiB pinball export
(`.plans/done/playable-export-size.md`), and the 2D games that dominate Pix3 usage
(SkyDefender, CanonGame, the pinball/bouncer/tapper/arena templates, DeepCore's 2.5D shell)
need OBBs, circles, restitution and sensors — not a deterministic islands-and-joints
constraint solver.

## 1. What exists today (verified)

- **No built-in physics.** The runtime says so itself: "Physics lives in the game (e.g. a
  Rapier `World`), opaque to the runtime" (`packages/pix3-runtime/src/core/physics-debug-overlay.ts:26-29`);
  `docs/nodes-and-systems.md:336-341` documents the same policy.
- **Rapier is shipped but engine-unused.** `src/core/lazy-rapier.ts` lazy-loads
  `@dimforge/rapier3d` onto `window.__RAPIER__` for user scripts only;
  `src/core/runtime-import-map.ts:70-79` shims `@dimforge/rapier3d-compat` for in-editor
  scripts; the export vendors compat + base64 wasm
  (`src/services/export/PlayableHtmlBuildService.ts:918-937`) **only if a project script
  actually imports it** (alias at `PlayableHtmlBuildService.ts:399-403` resolves on import).
  DeepCore consumes it game-side (`../DeepCore/src/scripts/physics/PhysicsWorld.ts:1`).
- **Query-only 2D collision:** `Collision2DService` (overlap point/circle/rect + raycast,
  axis-aligned, linear scan) + `core:Hitbox2D`
  (`packages/pix3-runtime/src/behaviors/Hitbox2DBehavior.ts`), reached via
  `this.scene.collision2d` (lazy getter, `packages/pix3-runtime/src/core/SceneService.ts:340-344`).
- **Debug plumbing already exists:** `registerPhysicsDebugSource` (`core/game-debug.ts`) +
  `PhysicsDebugOverlay`, rendered by `SceneRunner` when the editor toggles it
  (`SceneRunner.ts:1372-1378`); buffer layout mirrors Rapier's `World.debugRender()`.
- **A fixed-step slot already exists:** `SceneRunner.runFixedUpdates()`
  (`SceneRunner.ts:1738-1761`) drains an accumulator at `ECSService.fixedTimeStep`
  (default 1/60, max 4 steps/frame — `ECSService.ts:10-11`). The accumulator is fed the
  **GameTime-scaled** dt (`SceneRunner.ts:1029-1037`), so hitstop/slow-mo already freeze or
  dilate anything stepped there.

## 2. What other engines ship, and what we borrow

**Godot**: `StaticBody2D` / `RigidBody2D` / `CharacterBody2D` / `Area2D` nodes, each with
`CollisionShape2D` **child nodes**; `body_entered`/`body_exited` signals; a "Visible
Collision Shapes" debug toggle; **fully separate 2D and 3D physics servers**.
**Unity**: `Rigidbody2D` + `Collider2D` **components on the same GameObject** (compound
bodies via child colliders), `bodyType` static/kinematic/dynamic, `gravityScale`,
`PhysicsMaterial2D` assets, `OnCollisionEnter2D`/`OnTriggerEnter2D` callbacks, a
layer-collision matrix. **Construct 3** (the closest product analogue — a browser 2D
playable engine) ships physics as a *behavior* attached to an object, which is exactly
Pix3's component model.

Borrow:

- Godot's **body taxonomy** (static / kinematic / dynamic, sensors as the Area2D role) and
  **signal-based contact events** (as kebab-case: `body-entered`, matching `ball-hit`,
  `animation-finished` conventions).
- Godot's **separate 2D vs 3D physics** decision.
- Godot's **Visible Collision Shapes** editor/play toggle (we already half-have it:
  `debugDraw` on Hitbox2D, `Hitbox2DBehavior.ts:142-202`).
- Unity/Construct's **component attachment** model: the sprite *is* the body; shape +
  material live on the same node.
- Unity's `gravityScale`, `fixedRotation`, `bodyType` property surface.

Do NOT copy:

- **Godot's shape-as-child-node.** In Pix3 a new node type is a ~10–14 file checklist
  (`Checkbox2D` appears in 14 non-spec files across runtime + editor, including a
  `Viewport2DProxyRegistry` proxy, `NodeRegistry`, `Create*Command`/`Operation`,
  agent `create-node-registry`, scene-tree visuals, strippable table). Components need none
  of that: schema-driven inspector UI, YAML `components:` serialization
  (`docs/pix3-specification.md` "Script Component System"), picker listing and export
  stripping all come free from the `Script` infrastructure (`Hitbox2DBehavior` is the
  working precedent).
- **Physics material assets** (Unity `PhysicsMaterial2D`) — Pix3 has no material-asset
  resource type; inline `friction`/`restitution` on the collider.
- **A joint suite / layer-collision matrix UI** in v1 — defer; filter with Godot-style
  string groups, continuous with `Hitbox2D.group`.
- **Edit-mode simulation.** Neither Godot nor Unity simulates in the editor by default;
  Pix3's render-on-demand viewport (`CLAUDE.md` "Editor viewport renders on demand") makes
  a live edit-mode sim an attractive nuisance. Play mode is one keypress away.

## 3. The 2D-vs-3D fork: separate worlds, asymmetric implementations

Decision: **2D gets a built-in, hand-written, rotation-aware impulse solver; 3D keeps
game-level Rapier** (status quo), with an optional later phase wrapping Rapier into
`core:PhysicsBody3D`/`core:Collider3D` components behind mention-gated vendoring.

Why not the alternatives:

- **One 3D Rapier world with 2D constrained to a plane**: every 2D playable pays ~2 MB of
  wasm (~1.5x the whole current export) plus base64 inflation in single-file HTML, to
  simulate circles and boxes. Also couples the 2D design-px coordinate space (origin
  center, Y up) to a metric 3D solver, inviting unit bugs.
- **Ship rapier2d for 2D**: a *second* wasm artifact (~1.3 MB) and package to vendor,
  version and lazy-load — still two orders of magnitude over the budget for the common case.
- **Hand-write 3D too**: 3D physics (stacking, manifolds, friction cones, broadphase) is
  where hand-rolling actually fails; that is what Rapier is for, and the one real 3D
  consumer (DeepCore) already has it working game-side.
- **Do nothing / keep Rapier-in-scripts for 2D too**: this is the current answer and it
  demonstrably fails the product: `BallBody.ts` had to ship a bespoke solver in a *template*
  ("Never import rapier: it is a ~2 MB lazy wasm payload this does not need",
  `BallBody.ts:20`), and Godot/Unity/Construct all ship 2D physics built in. The
  engine-vs-game rule says: engine.

Solver scope (v1, deliberately narrow — this is a playable-ads engine, not physics
middleware): rigid circles and **oriented** boxes, static/kinematic/dynamic bodies, sensors,
gravity + per-body `gravityScale`, restitution/friction, linear/angular damping,
`fixedRotation`, sequential-impulse contact resolution with a few iterations, swept-circle
CCD for `bullet` bodies (the pinball case — the bouncer's `ball-collision.ts` + its spec is
in-repo prior art), sleeping, insertion-ordered iteration for reproducibility. No joints,
no capsules, no polygon shapes in v1. Fallback in §9 if stability targets fail: vendor
planck.js behind the same component API.

## 4. The authored surface

### 4.1 Components (not nodes)

```yaml
- id: 'a1b2c3'
  type: 'Sprite2D'
  name: 'Crate'
  properties: { ... }
  components:
    - id: 'c1'
      type: 'core:PhysicsBody2D'
      config:
        bodyType: dynamic        # static | kinematic | dynamic
        gravityScale: 1
        mass: 1                  # 0 -> derive from shape area x density 1
        linearDamping: 0.01
        angularDamping: 0.05
        fixedRotation: false
        bullet: false            # swept CCD
        canSleep: true
        emitContacts: false      # gate contact signals (perf)
    - id: 'c2'
      type: 'core:Collider2D'
      config:
        shape: rect              # rect | circle
        width: 64
        height: 64
        radius: 32
        offsetX: 0
        offsetY: 0
        friction: 0.4
        restitution: 0.2
        sensor: false
        group: 'crates'          # Godot-style string group, same as Hitbox2D
        debugDraw: false
```

Composition rules (Unity-style):

- A `core:Collider2D` with **no** `core:PhysicsBody2D` on its node or any ancestor is
  **static world geometry** — the designer's "wall" case needs one component, zero scripts.
- A collider contributes to the **nearest ancestor** body -> compound bodies via child nodes
  (a flipper = body on the parent, two child colliders), no new node types.
- Rotation and scale are read from the live world transform, fixing Hitbox2D's blind spot.
- `sensor: true` = Godot `Area2D` role: detects, never resolves.

Property schemas follow `docs/property-schema-reference.md` (constructor `this.config`
defaults + `static getPropertySchema()`, exactly like `Hitbox2DBehavior.ts:21-100`), so the
Inspector, prefab diffing and the animation timeline work with no editor code.

### 4.2 Signals (kebab-case, emitted on the component's node)

- `body-entered (otherNode, contact)` / `body-exited (otherNode)` — sensors, always.
- `contact-started (otherNode, { x, y, nx, ny, impulse })` / `contact-ended (otherNode)` —
  solid bodies, only when `emitContacts: true` (Godot's contact-monitor opt-in).

### 4.3 Scripts-facing API — `this.scene.physics2d`

```ts
const phys = this.scene.physics2d;
phys.setGravity(0, -1960);                       // design px/s^2, Y up
const body = phys.getBody(this.node);            // null if none
body.velocity; body.setVelocity(vx, vy);
body.applyImpulse(ix, iy); body.applyForce(fx, fy);
body.angularVelocity; body.teleport(x, y, rot);  // safe mid-sim reposition
const hit = phys.raycast(x1, y1, x2, y2, { group: 'walls' });   // rotation-aware
phys.overlapCircle(x, y, r, { group: 'enemy' });                // rotation-aware
```

Same lazy-getter pattern as `collision2d`/`network` on `SceneService`
(`SceneService.ts:340-358`): the service is constructed on first touch and `SceneRunner`
steps it only when it exists.

### 4.4 Editor authoring and drawing

The editor viewport renders proxy meshes, not runtime nodes (`CLAUDE.md` "2D overlay
rendering"), and Hitbox2D's `debugDraw` line is a runtime child mesh — invisible in the
editor viewport today. Plan:

- A new `ViewportColliderGizmos` helper (pattern of `ViewportAdornments`) reads
  `core:Collider2D`/`core:Hitbox2D` configs and draws line-loop overlays positioned from the
  same proxy transforms; shown for **selected nodes** by default plus a viewport "Show
  collision shapes" toggle (Godot's Visible Collision Shapes).
- Redraw rides the existing dirty pipeline: collider property edits go through
  `UpdateObjectPropertyOperation`, whose completion already marks the viewport dirty; the
  gizmo helper is invoked from `ViewportRenderService.requestRender`'s adornment pass. No
  new render loop, no fight with render-on-demand.
- **No edit-mode simulation** in any phase of this plan. Play mode (isolated clone) is the
  preview.
- Play-mode debug: `Physics2DService` publishes its wireframes through the existing
  `registerPhysicsDebugSource` + `PhysicsDebugOverlay` (buffer layout already defined,
  `physics-debug-overlay.ts:31-34`). One wrinkle: `SceneRunner` currently renders that
  overlay only when a 3D camera exists (`SceneRunner.ts:1332, 1372`) — extend it to render
  through `orthographicCamera` when the source flags itself 2D. Per-collider `debugDraw`
  line loops (the Hitbox2D mechanism) remain as the zero-setup fallback.

## 5. Simulation loop, determinism, and the mutation gateway

- **Fixed step**: `SceneRunner.runFixedUpdates()` calls `sceneService.stepPhysics2D(fixedDt)`
  right next to `ecsService.fixedUpdate` (`SceneRunner.ts:1747-1756`). No-op when the
  service was never constructed. Step = integrate -> broadphase (spatial hash; the linear
  scan is fine to start, same judgement as `Collision2DService.ts:17-18`) -> narrowphase ->
  impulse iterations -> write back node transforms -> emit queued signals *after* the step
  (never mid-iteration).
- **Determinism**: the step inherits everything the runner already guarantees — fixed
  1/60 dt, `maxFixedStepsPerFrame` clamp, GameTime-scaled accumulator (hitstop freezes
  physics for free, `SceneRunner.ts:1029-1037`), and the `fixed`/`manual` time modes
  (`setTimeMode`/`stepFrames`, `SceneRunner.ts:862-938`) give the agent test harness exact
  reproducible stepping. Cross-run determinism is best-effort JS-float (like the bouncer);
  insertion-ordered body iteration keeps runs on the same machine reproducible.
- **Interpolation**: v1 writes transforms at step time (step rate == typical frame rate).
  The runner already computes an alpha (`SceneRunner.ts:1040-1046`); phase 2 can add
  previous/current pose interpolation behind a flag.
- **Mutation gateway**: no conflict, by construction. Play mode runs on an **isolated
  clone** (`startScene` serialize->parse, `SceneRunner.ts:283-301`); scripts already mutate
  that clone imperatively outside the Command/Operation gateway (that is the documented
  play-mode contract — `BallBody.writeBackPosition` does it today). Physics writes
  positions/rotations on the clone only. The authored graph, undo/redo and collab never see
  a physics write. Editing a *stopped* scene edits the authored initial pose like any other
  property.
- **Live edits during play**: inspector edits reach the clone via the existing live property
  sink (`registerRuntimeLivePropertySink`, `SceneRunner.ts:426-428`). Rule: a transform write
  to a node owning a dynamic body marks the body dirty and the next step syncs node->body
  (a teleport), the same semantics Godot gives an edited RigidBody2D.

## 6. Export size — how physics stays out of builds that don't use it

Mechanism (all existing, no new machinery):

1. `behaviors/PhysicsBody2DBehavior`, `behaviors/Collider2DBehavior` and
   `core/Physics2DService` are added to `STRIPPABLE_RUNTIME_MODULES`
   (`src/services/export/strippable-runtime-modules.ts`), keyed on
   `core:PhysicsBody2D` / `PhysicsBody2DBehavior` etc. The mention scan
   (`RuntimeProjectBuildModel.mentionedNames`, tokenized scene YAML + project scripts —
   `PlayableHtmlBuildService.ts:363-370`) keeps them only when a scene or script says the
   word.
2. `Physics2DService` is value-imported by `SceneService` (a keeper module) via the lazy
   getter — the **exact `NetworkService` precedent**: listed with
   `lazyValueImporters: ['core/SceneService']` (`strippable-runtime-modules.ts:137-154`),
   and the guard spec that recomputes the value-import graph from disk enforces the entry
   forever. `SceneRunner` gains **no** new value import (it calls a `SceneService` method),
   so no new `instanceof` pin.
3. **Serialization cannot pin it**: components load through `register-behaviors` and save
   through `SceneSaver`, both `NEUTRALISED_IMPORTERS`
   (`strippable-runtime-modules.ts:56-61`); a player never constructs `SceneSaver`. A scene
   that *does* contain `core:PhysicsBody2D` mentions the name — and then it genuinely needs
   the solver, which is the correct outcome.
4. **The wasm question is moot for 2D**: the 2D path never imports Rapier anywhere. Rapier
   enters an export only when a *project script* imports `@dimforge/rapier3d-compat` (alias
   resolved on import, `PlayableHtmlBuildService.ts:399-403` -> vendored source + base64
   wasm at `:918-937`) — unchanged from today.
5. **Phase-3 3D wrappers** (if ever built) must keep Rapier a type-only dependency of the
   runtime, using the Spine pattern (`spine-module.ts` structural types +
   `setRapierModuleLoader(...)` in hosts; editor host = `lazy-rapier.ts`) and a generated
   `virtual:runtime-physics3d` module with a **static** import in exports — dynamic imports
   and bare specifiers are the two failure modes CLAUDE.md documents for single-file HTML.

Budget estimate (estimates, not measurements): solver + service ~15–25 KiB minified
(~5–8 KiB gz), the two behaviors ~4–8 KiB. Non-physics exports: **+0 bytes** beyond
few-hundred-byte stubs. For calibration, the *entire* 2D pinball export is 885 KiB of raw
JS / 225 KiB gz, and the Rapier alternative would be ~2 MB wasm before base64.

## 7. Phasing

**Phase 1 — the shippable core (2D bodies + colliders):**

- `core/Physics2DService` (+spec): world, gravity, circle/OBB shapes, static/dynamic,
  sensors, impulse solver, swept-circle CCD, sleeping, rotation-aware
  `raycast`/`overlapCircle`/`overlapRect`.
- `core:PhysicsBody2D`, `core:Collider2D` behaviors (+register-behaviors, +index barrel).
- `SceneService.physics2d` getter + `stepPhysics2D` hook in `SceneRunner.runFixedUpdates`.
- Signals: `body-entered`/`body-exited`; `contact-started`/`contact-ended` behind
  `emitContacts`.
- Strippable-table entries + guard-spec expectations.
- Play-mode debug via `registerPhysicsDebugSource` (+ ortho-camera overlay rendering) and
  per-collider `debugDraw`.
- Editor: `ViewportColliderGizmos` (selected-node collider outlines).
- Docs: `nodes-and-systems.md` §4 Physics rewrite, `node-types-reference`-style property
  tables, CLAUDE.md router row.
- Acceptance: a bouncer-class scene (angled paddles, bumpers, drain sensor) authored with
  zero gameplay-physics script code; 20-body stack stays stable at 1/60 for 30 s.

**Phase 2 — feel and ergonomics:** kinematic `moveAndCollide`/`moveAndSlide` (the
CharacterBody2D role), capsule shape, render interpolation, viewport-wide "Show collision
shapes" toggle, one joint (revolute — flippers), re-author `recipe-bouncer-2d` on engine
bodies (keep `ball-collision.ts` until parity is demonstrated), route `collision2d` queries
through the physics broadphase when both exist.

**Phase 3 — 3D wrappers (demand-gated, may never happen):** `core:PhysicsBody3D` /
`core:Collider3D` over host-injected Rapier + `virtual:runtime-physics3d` vendoring +
Rapier `debugRender()` piped into the existing overlay. Only if a second 3D consumer
actually asks; DeepCore is served by the status quo.

## 8. Cost of each phase

| | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Bundle (physics used) | ~+20–33 KiB min (guess), ~6–10 KiB gz | +5–10 KiB | +~2 MB wasm base64 (only when mentioned) |
| Bundle (physics unused) | +0 (stubs) | +0 | +0 |
| Runtime files | ~7 new/touched (`Physics2DService` + 2 behaviors + register-behaviors + SceneService + SceneRunner + index) + specs | ~4 | ~6 + export service |
| Editor files | ~4 (strippable table + spec, viewport gizmos, ViewportRenderService hook) + docs | ~3 | ~4 (vendor loaders, virtual module) |
| Risk | solver stability (see §9 Q1) | joint math | consumer API churn |

**Migration:**

- `Collision2DService` / `core:Hitbox2D` — **stays, undeprecated.** It is the query-only
  tier (Godot Area2D-groups x `Physics2D.Overlap*`), costs ~3 KiB, and the tapper/arena
  templates depend on its groups. Decision rule for docs: *queries only -> Hitbox2D;
  movement, response, rotation, sensors with enter/exit -> physics2d.* Phase 2 may unify the
  broadphase underneath without touching either API.
- `recipe-bouncer-2d` — untouched in phase 1 (its solver doubles as prior art and its spec
  as a reference test); phase 2 re-authors it on `core:PhysicsBody2D` and deletes
  `BallBody`/`ball-collision` only after byte- and feel-parity is shown.
- `docs/nodes-and-systems.md:336-341` ("games implement their own physics") is rewritten by
  phase 1; the `GameDebugProvider` physics hooks stay valid for consumer games.

## 9. Open questions for the human

1. ~~**Hand-written solver vs vendoring planck.js/matter.js behind the same components.**~~
   **DECIDED (2026-08-30): hand-written**, with the narrow v1 shape set of §3 (circles +
   OBBs, no joints, no capsules, no polygons). The reasoning that carried it: the shape set
   is small enough to own outright, it keeps the 2D path wasm-free and dependency-free, and
   `recipe-bouncer-2d`'s `ball-collision.ts` + its spec are in-repo prior art for the swept
   circle case.
   The escape hatch stays open and is the reason the authored surface (§4) is specified
   independently of the solver: if the phase-1 acceptance tests — a 20-body stack stable at
   1/60 for 30 s, and pinball-speed CCD — cannot be met in reasonable time, swap the
   internals for vendored planck.js (~tens of KiB, still wasm-free) without touching the
   components, the signals or `scene.physics2d`. Treat that swap as a normal outcome, not a
   failure: the API is the commitment, the solver is an implementation detail.
2. **Filtering model**: keep Godot-style string groups (continuity with `Hitbox2D.group`) or
   introduce layer/mask bitfields now? Proposal: groups in v1, bitfields only if a real game
   hits the wall.
3. **Gravity authoring**: `scene.physics2d.setGravity()` only, or also a designer-facing
   `core:PhysicsWorld2D` component on the scene root? Proposal: both, component in phase 1
   (it is ~40 lines and strippable).
4. **Multiple colliders per node** (several `core:Collider2D` components on one node) vs
   child-node composition only — does the component UI handle duplicates acceptably?
5. **Phase 3 at all?** If DeepCore remains the only 3D physics consumer, the wrapper may
   never pay for its API-stability burden. Default: defer indefinitely.
