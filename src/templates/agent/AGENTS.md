# AGENTS.md — {{PROJECT_NAME}}

This is a **Pix3 game project**: a browser game edited in the Pix3 editor and runnable
as an exported single-file HTML.

## Which agent are you?

- **The in-editor Pix3 Agent** (running inside the editor's Agent panel): work through your
  **tools**, not by hand-editing files — `add_component` / `set_property` for behaviour and
  properties, `fs_write` + `compile_scripts` for scripts, `generate_asset` / `process_asset`
  for art, `play_start` + `read_errors` to verify. Call **`read_skill`** for the matching
  built-in skill (`game-prototype`, `asset-generation`, `verify-and-fix`) before starting a
  task. The file-format details below are background — prefer the tools.
- **An external file-editing agent** (editing this folder directly): you author the
  `.pix3scene` YAML and `scripts/*.ts` files yourself, following the rules below, and ask the
  user to run the game in the editor to verify.

## Where things are

| Path | What it is |
|---|---|
| `design/` | The game design document and reference images — **read these first** |
| `pix3project.yaml` | Project manifest (viewport size, platform, quality, autoloads) — don't edit unless asked |
| `scenes/*.pix3scene` | Scenes (YAML). `main.pix3scene` is the editor's startup scene (opened first, and what you iterate on). A build boots the **entry scene** = Project Settings → Default Export Scene Path, which may be a separate menu scene |
| `scripts/*.ts` | Game scripts: `export class X extends Script` → referenced in scenes as `type: user:X` |
| `sprites/`, `audio/` | Art and sound assets, referenced as `res://sprites/...` / `res://audio/...`. Other asset-type folders (`models/`, fonts, …) are created as you add those assets |
| `.claude/skills/` | Your skills: `pix3-game-dev` (engine capabilities, how to write scenes/scripts), `pix3-remote-preview` (running and debugging the game) |
| `.pix3/` | Editor metadata (template/version info) — do not edit |

## Rules

1. **Consult `.claude/skills/pix3-game-dev/` before writing game logic.** Its
   `references/` folder contains the full engine capability catalog
   (`nodes-and-systems.md`) and per-node property reference
   (`node-types-reference.md`). Prefer an existing engine capability
   (nodes, `core:*` behaviors, juice, audio buses, signals, ECS) over custom code.
2. **Scenes are YAML** (`.pix3scene`): a `root:` list of nodes with `id`, `type`,
   `name`, `properties`, optional `components` (script components) and `children`.
   Prefabs are referenced with `instance: res://path.pix3scene` instead of `type`.
3. **Scripts** live in `scripts/`, extend `Script` from `@pix3/runtime`, expose
   config via `static getPropertySchema()`, and reach the engine through
   `this.scene` / `this.input` / `this.node`. Attach them in scene YAML under
   `components:` as `type: user:<ClassName>`. To move between scenes at runtime
   (menu → game → results), call
   `this.scene.changeScene('res://scenes/<name>.pix3scene', { transition: 'fade' })`.
4. **Asset paths** always use the `res://` scheme relative to the project root.
5. **Missing art?** Use colored primitives (`ColorRect2D`, `GeometryMesh` with a
   material color) or the bundled logo as placeholders the user can swap later;
   note every placeholder you leave in your summary.
6. **To run/verify the game**, follow `.claude/skills/pix3-remote-preview/` —
   if no preview session is available, ask the user to open the project in the
   Pix3 editor and press Play, then report what to check.

## Workflow for "build the game from the GDD"

1. Read everything in `design/`.
2. Map GDD features onto engine capabilities via the pix3-game-dev skill references.
3. Author/extend scenes and scripts. Iterate in `main.pix3scene` (the scene the
   editor opens and you can play directly); keep the project's entry scene
   (Project Settings → Default Export Scene Path) wired into the flow.
4. Verify (remote preview or ask the user), iterate.
5. Summarize: what was built, placeholders left, and what to test.
