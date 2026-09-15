---
name: pix3-game-dev
description: Guidance for building a GAME on the Pix3 engine — implementing gameplay/features, adding a node, script component, or system, wiring scenes, or answering "how do I do X with the engine/editor". Use BEFORE writing custom game logic so you reach for an existing engine capability (nodes, core:* behaviors, juice, audio buses, camera brain, cutscene director, keyframe animation, shader effects, post-processing, ECS, input, signals) and use it correctly, and so you apply the engine-vs-game decision, the Script-component pattern, and the mutation gateway. Covers both in-editor user scripts and consumer projects that import @pix3/runtime (e.g. DeepCore). NOT for debugging the running editor (use debug-running-game) or generating art (use generate-sprites-in-editor).
---

# Building a game on Pix3

The engine already ships most game-feel and structural capabilities. Your job is
to **reach for them** and wire them correctly, not to reimplement them. The
capability inventory is the catalog — start there every time.

## The loop

1. **Consult the catalog: [docs/nodes-and-systems.md](../../../docs/nodes-and-systems.md).**
   It lists every node, `core:*` behavior, system, and scripts-facing runtime API,
   each with how to use it. Per-node detail is in
   [docs/node-types-reference.md](../../../docs/node-types-reference.md).

2. **Apply the engine-vs-game decision** (catalog §0):
   - *Would Godot/Unity ship this as a built-in?* → **engine-level** (runtime +
     editor: schema, `Create*Command`, registry, YAML, inspector) — **state the
     plan and confirm with the user first**, then `yalc:publish` to consumers.
   - Game-specific rules/content/balancing → **game-level script**.
   - Engine code must not reference game concepts (shop, coins, enemies).

3. **Prefer an existing capability.** Common asks and what they already are:
   - Screen-shake / squash / pop / flash / hitstop / slow-mo → `scene.juice` /
     `scene.time` or the `core:Shake` / `core:PunchScale` / `core:PopIn` presets.
   - Timeline animation, camera moves, scripted beats → `core:AnimationPlayer`
     clips (property + event tracks).
   - Frame/flipbook sprite animation (numbered frame files, a spritesheet, or "a
     sprite that swaps textures over time") → `AnimatedSprite2D` / `AnimatedSprite3D`
     + a `.pix3anim` next to the frames — hand-written JSON (recipe in the catalog)
     or authored in the editor's **Sprite Editor** (clips rail + frame timeline
     around the same canvas that crops/edits each frame).
     One-shot VFX (impact flash, poof, muzzle burst): `loop: false` +
     `freeOnFinish: true` (the node self-destructs when the clip ends — no
     component). **Never** a Script that `setTexture()`s frames on a timer.
   - Something that must follow a moving point ON the art (muzzle flash on a
     barrel, an item in a hand through a walk cycle) → a **named frame point**
     read with `getFramePoint(name)`, or the `core:PointAttachment` component on
     the child. **Never** hard-coded per-frame offsets in a script.
   - Camera follow / cut / blend → `Camera3D` + `core:CameraBrain` +
     `VirtualCamera3D` (priority-driven). Programmatic blend:
     `brain.overrideNextBlend`.
   - Cinematic (letterbox + input-lock + skip + blend) → `scene.cutscene.playCinematic`.
   - Sound, music, mixing → `scene.audio` (buses/snapshots) / `AudioPlayer` / `core:PlaySound`.
   - Material FX → GeometryMesh shader effects; screen FX → `PostProcess` node.
   - Cross-node events → `node.connect` / `emit` (signals).
   - Fixed-step logic (physics/AI/spawning) → an ECS system.

   **The script gate — before you create any new `Script` class:** name the
   catalog entry (node / `core:*` behavior / system) that covers the ask. If one
   exists, wire it instead. If none does, write the reason as the first line of
   the script's doc comment — `/** engine-check: no built-in covers <X> because
   <reason> */` — then write code. A script that duplicates a catalog capability
   without that line is a defect (reviewers grep for it). **Reimplementation
   smells** — if your draft contains one of these, stop, a built-in exists:
   - `setTexture(...)` on a timer / a frame counter → `AnimatedSprite2D` + `.pix3anim`
   - a per-frame lookup table of attachment offsets → `AnimationFrame.points` +
     `getFramePoint()` / `core:PointAttachment`
   - hand-lerping opacity / scale / position over time → `core:Fade` / `core:PopIn` /
     `core:PunchScale` / `core:AnimationPlayer`
   - a time-accumulator whose only job is to `queueFree()` at the end → `core:FreeOnSignal`
   - manual camera chase, `new Audio(...)`, per-play volume/pitch math →
     `core:CameraBrain`, `scene.audio` / `core:PlaySound`

4. **Use the right build path** (catalog §1):
   - **In-editor user script** — `export class X extends Script` in `scripts/`,
     referenced as `type: user:X`; reach the engine via `this.scene` /
     `this.input` / `this.node`. Model:
     [samples/HelloWorld/scripts/CutsceneTrigger.ts](../../../samples/HelloWorld/scripts/CutsceneTrigger.ts).
   - **Consumer project** (`@pix3/runtime`) — you own `SceneRunner`; same runtime
     APIs, no editor/command layer.

5. **Follow the correct-usage rules** (catalog §5–§7):
   - Expose params via `static getPropertySchema()`; keep them in `this.config`.
   - Guard `this.scene` (may be undefined in previews).
   - Editor mutations go through `CommandDispatcher` → Command → Operation —
     **never** mutate `appState`/nodes directly.
   - Mind the gotchas: components tick before their children; `onUpdate(dt)` is
     scaled game time (chrome/timers use `performance.now()`).

5½. **Build the game's debug surface as you go.** `scene.commands.register(name,
   handler, { description })` for every intent, and `registerGameDebug({ name,
   snapshot, actions, inspect, action, reset })` for the state. Wire UI buttons
   to `scene.commands.dispatch(...)` so a button and a test take the same path.
   `actions()` answers from the registry, never a hand-kept list. This is what
   turns "play it and look" into assertions, and it is the difference between a
   game you can drive from outside and one only a human can check. The project
   templates scaffold both.

6. **Verify by running it**, not just by reading code.

   Static gates check the artefact; only motion checks the behaviour. A real
   case: a placement helper with an inverted sign made a game 100 % unplayable
   and passed `tsc --noEmit`, prettier, YAML validation of every scene, and a
   headless `SceneLoader.parseScene` that asserted the very coordinate involved
   — because the authored value was right and nothing at load time called the
   function. Two behavioural runs found it. **Never report "done" on static
   checks alone.**

   Cheapest first:

   - **Headless** — `createHeadlessGame` from `@pix3/runtime/testing` boots a
     real scene, registers user scripts, advances fixed steps and hands back
     state, in about a second with no browser. See
     `packages/pix3-runtime/src/testing/headless-game.spec.ts` for a worked
     example against `samples/Carrom`. Renders nothing, so it answers logic,
     physics, rules, signals and commands — not "does it look right".
   - **In the editor** — the **debug-running-game** skill (attach, `play.start()`,
     read `errors()`, screenshot). Required for anything visual, and for
     anything about the editor's own tool layer. Drive it through
     `agentTools.execute(...)`, not around it.
   - For UI/sprite art, use **generate-sprites-in-editor**.

   Two things a green run can still hide: a component that throws in
   `onStart`/`onUpdate` is **auto-disabled** and the game keeps running looking
   fine, so always read the error channel (`game.errors`, or `read_errors`); and
   `scene.time.hitstop(ms)` is **edge-triggered** — calling it every frame while
   an overlap lasts freezes `dt` to 0, so the contact can never separate.

7. **After adding an engine-level capability, update
   [docs/nodes-and-systems.md](../../../docs/nodes-and-systems.md) and
   [docs/node-types-reference.md](../../../docs/node-types-reference.md)** so
   the next agent finds it. Both are copied into every new project as the
   external agent's only engine catalog, and
   `src/core/agent-reference-docs.spec.ts` fails if a node type or `core:*`
   behaviour is missing from them.

## Binding references

- Coding rules (mutation gateway, DI, Lit conventions): `AGENTS.md`.
- Architecture (operations flow, schema, rendering, state): [docs/architecture.md](../../../docs/architecture.md).
- Product/spec source of truth: [docs/pix3-specification.md](../../../docs/pix3-specification.md).
