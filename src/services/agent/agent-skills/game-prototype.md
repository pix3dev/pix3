# Skill: game-prototype

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> *process* to the task if you have a better plan.

How to turn a game design document (GDD) into a **playable** prototype in this Pix3
project. Do the small, safe thing first; verify; then continue.

## 1. Understand the design (do this before touching anything)

- `fs_list` the `design/` folder, then `fs_read` every text/markdown file in it — that is
  the GDD. Note the game name, core loop, controls, win/lose, and screens.
- For each image in `design/` (references, mockups), call `analyze_image` with
  `question: "list the visual style tokens for an image-generation prompt: palette hex,
  rendering style, lighting, camera angle, mood"`. Keep the answer — you will paste it into
  every `generate_asset` prompt so all art matches. (If your model can already see images,
  you may skip analyze_image, but doing it still gives you reusable style tokens.)
- `scene_tree` to see what the project template already gives you (screens, buttons,
  placeholder nodes). **Build on it — do not recreate what is already there.**
- **Budget your exploration.** Do not `fs_read` large reference docs (e.g.
  `nodes-and-systems.md`, `node-types-reference.md`) in full — everything you read is re-sent
  on every following step and starves the build phase. Use `read_skill` with its `section`
  parameter, or read only the doc section for the node types you actually plan to use.
  Aim to start building after ~6–8 exploration calls.

## 2. Restate the plan (one short message to the user)

List, in 5 bullets or fewer: the game in one line, the screens, the core mechanic, the
win/lose condition, and the 2–3 increments you will build. Then start building — do not wait
for approval unless the user asked a question.

## 3. Build in increments — verify each before the next

Order increments so the game is runnable as early as possible:

1. **Screen flow** — wire the menu/game/over screens to switch on button presses.
2. **Core mechanic** — the one verb the GDD is about (move, shoot, match, dodge…).
3. **Win / lose** — a reachable end state.
4. **Feel & art** — juice, sound, then generated art (see the `asset-generation` skill).

After each increment: `play_start`, then `play_status` and `read_errors`. Fix errors before
moving on. Stop play mode (`play_stop`) before large edits.

## 4. How to make changes (use tools, not hand-edited files)

- **Give a node behaviour** → `list_component_types`, then `add_component` (a built-in
  `core:*` behaviour or a project `user:*` script), then `set_component_property` to
  configure it. Never hand-edit a scene file just to add a component.
- **Tweak a property** on an existing node → `set_property` (undoable).
- **Custom logic** → `fs_write` a `Script` subclass under `scripts/`, run `compile_scripts`
  (then `check_scripts` for type errors), then `add_component` with its `user:<ExportName>`
  type. See the `pix3-game-dev` skill / the project `AGENTS.md` for the Script shape and the
  engine API (`this.scene`, `this.input`, `this.node`, `this.findNode(...)`).
- **New scene structure** (nodes that don't exist yet) → edit the `.pix3scene` YAML with
  `fs_write`; the editor watches the active scene file and reloads it automatically (there is
  **no** `scene.reload` command). Prefer this only when you truly need new nodes; editing
  existing nodes via set_property/components is safer (it keeps undo history).
  **Warning:** writing the scene YAML replaces the scene wholesale. Components you previously
  attached with `add_component` exist only in the loaded scene — include them in the YAML you
  write (a `components:` block on the node), or they are silently lost. After a scene
  `fs_write`, `node_inspect` your key nodes to confirm their components survived.
- **Level/config data lives in the scene or component config, not hardcoded in a script.**
  Waypoint positions, spawn points, speeds, lap counts — put them on nodes (positions in the
  scene) or as component `config` (via `add_component` config / `set_component_property`) so the
  editor and the designer can see and tweak them. Hardcoding an array of coordinates inside a
  `Script` hides the data from the editor and is a last resort. If a `set_property` looks
  ignored, check the value *shape* first — a vector wants `{ x, y }` (an `[x, y]` array is also
  accepted), a rotation wants a number — rather than hardcoding a workaround.

## 4½. Engine API traps (these compile clean and then break at runtime)

Every one of these passes `compile_scripts` and, if you cast to `any`, `check_scripts` too —
then throws or silently does nothing on the first frame:

- **`position` / `rotation` / `scale` are read-only references** (three.js). Never assign
  them: `node.position = {x, y}` and `node.rotation = angle` throw
  `Cannot assign to read only property`. Mutate instead: `node.position.set(x, y, 0)`,
  `node.rotation.z = radians` (or the 2D helpers if the node exposes them).
- **A component that throws in `onStart`/`onUpdate` is auto-disabled by the engine** — the
  game keeps running errorless-looking while your car/enemy is frozen. `read_errors` right
  after `play_start` is the only way to catch it.
- **Keyboard events are case-sensitive**: `event.key` is `'ArrowUp'`, `'w'` — checking
  `keys['arrowup']` never matches. Prefer `event.code` (`'KeyW'`, `'ArrowUp'`, layout-independent).
- **Never cast `this.node as any`** — it disables exactly the type-checking that would have
  caught the read-only assignment above. If a property seems missing from the type, look up
  the real API (`read_skill`, `node_inspect`) instead of casting.
- **Write each script once.** Think the design through, then write the file and immediately
  `compile_scripts`. Rewriting the same file 3–4 times burns your iteration budget.

## 5. Art comes last, and placeholders come first

Do not block gameplay on art. Use `ColorRect2D` (2D) or a `GeometryMesh` with a material
colour (3D) as placeholders until the mechanic works, then replace them with generated
sprites via the `asset-generation` skill. List every placeholder you leave in your summary.

## 6. Finish

Summarize: what plays now, how to test it (which button, which key), what art is still a
placeholder, and the single most useful next step.
