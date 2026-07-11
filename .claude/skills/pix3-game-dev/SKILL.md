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
   - Camera follow / cut / blend → `Camera3D` + `core:CameraBrain` +
     `VirtualCamera3D` (priority-driven). Programmatic blend:
     `brain.overrideNextBlend`.
   - Cinematic (letterbox + input-lock + skip + blend) → `scene.cutscene.playCinematic`.
   - Sound, music, mixing → `scene.audio` (buses/snapshots) / `AudioPlayer` / `core:PlaySound`.
   - Material FX → GeometryMesh shader effects; screen FX → `PostProcess` node.
   - Cross-node events → `node.connect` / `emit` (signals).
   - Fixed-step logic (physics/AI/spawning) → an ECS system.

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

6. **Verify by running it**, not just by reading code: use the
   **debug-running-game** skill (attach to the editor, `play.start()`, read
   `errors()`, screenshot). For UI/sprite art, use **generate-sprites-in-editor**.

7. **After adding an engine-level capability, update
   [docs/nodes-and-systems.md](../../../docs/nodes-and-systems.md)** so the next
   agent finds it.

## Binding references

- Coding rules (mutation gateway, DI, Lit conventions): `AGENTS.md`.
- Architecture (operations flow, schema, rendering, state): [docs/architecture.md](../../../docs/architecture.md).
- Product/spec source of truth: [docs/pix3-specification.md](../../../docs/pix3-specification.md).
