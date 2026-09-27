{{# Template of the kit's AGENTS.md. Generated into projects by `pix3 kit` / `pix3 new`; see }}
{{# packages/pix3-cli/src/kit/generate.ts for the directive syntax. }}
<!-- Pix3 agent kit {{version}} — written by `pix3 kit`. You may edit it: `pix3 kit --update` never overwrites a kit file you changed. -->
# AGENTS.md — Pix3 game project

This folder is a **Pix3 game**: a 2D/3D browser game. You edit it by writing files. A human
has the same folder open in the Pix3 editor, moves things with the mouse and presses Play;
the editor saves their edits to the same files. The files are the whole contract.

If it started from a **recipe** (`design/recipe.md` exists), it is a game that already plays.
Change it; do not rebuild it.

## Read first

1. `design/recipe.md` (if present) — the map: stable node ids, tunables with ranges, extension
   points, what must not be touched. It speaks in the in-editor agent's tool names; translate
   them with the table in `.claude/skills/pix3-scene-format/SKILL.md` ("Recipe tool names").
2. `README.md` — file layout of this project.
3. The one scene or script you are about to change. Nothing else. Do not survey the repo.
   To find it, and to find your way inside it, use `pix3 tree` (every scene and prefab with
   node counts, types and components) and `pix3 tree <scene>` (one line per node: id, type,
   position, size, layout, components, prefab instances; `--types Label2D,Button2D`,
   `--depth 2`, `--props`) — not a read of whole scene files. Read the file itself right
   before you edit it (rule 2).

## Layout

The layout is **whatever this project has** — do not assume folders. Three rules hold everywhere:

- **Scenes**: find them with a glob `**/*.pix3scene` outside `node_modules/` (and `.pix3/`).
  `defaultExportScenePath` in `pix3project.yaml` names the build's entry scene.
- **`res://` is always relative to the project root** (the folder with `pix3project.yaml`), so
  `res://src/assets/textures/x.png` is as normal as `res://sprites/x.png`. Copy the style the
  scene you are editing already uses.
- **Scripts** live under `scripts/**` or `src/scripts/**` (the only two roots the editor and
  `pix3 check` scan). `export class X extends Script` → `type: user:X`.

`pix3project.yaml` is the manifest (do not edit unless asked); `.pix3/` is editor + CLI
bookkeeping (recovery journal, merge log, script types) — never edit it.

Example — the layout a **recipe** project (`pix3 new`) ships; other projects differ:

| Path | What |
| --- | --- |
| `scenes/*.pix3scene` | Scenes |
| `scenes/ui/*.pix3scene` | Full-screen overlays (result card, modal), one file each, instanced hidden |
| `scenes/prefabs/*.pix3scene` | Prefabs: a scene file with exactly ONE root node (a top-level `prefabs/` works too) |
| `scripts/*.ts` | Script components |
| `sprites/`, `audio/`, `fonts/`, `models/` … | Assets, referenced as `res://sprites/x.png` |
| `design/` | Recipe contract, GDD, tests. `design/tests/` is written by the editor's harness |

## The five rules

1. **Playable change first, questions after.** Make the change the user asked for, in the
   smallest form that plays, before asking anything. Choose small things yourself (a shade, a
   speed, a count) and say so in one line. At most ONE question per turn, and only about a
   fork that changes structure ("win by score or by time?"). Never open with a question.
2. **Re-read a scene before you edit it.** The human may have changed it in the editor a
   minute ago. Edit the lines you mean to change (search/replace), never regenerate a whole
   scene from memory. After writing, if `pix3 check` lists **merge-log** entries where the
   editor KEPT the human's value instead of yours, re-read the file with `pix3 read <file>`
   (that is your read confirmation); if your value is still intended, write it again — or ask
   the human. Without that re-read the editor keeps restoring the human's value on every
   write you make, even if you write the same number.
3. **Leave layout, colours and fine-tuning to the human.** If asked "a bit more to the left",
   do it, then offer: "you can drag it in the editor — it saves on its own".
4. **Run `pix3 check` after every batch of edits** and fix every error before you say "done".
   It checks YAML, node types, properties, `res://` paths, prefabs, components, and
   type-checks your scripts (tsc). With the live channel connected (MCP, below), then run the
   game with `game_run` (or `play_restart`), **passing `expect`** — the sha256 of every file you
   wrote, as `pix3 check --json` prints them under `files`. An answer with
   `disk_differs_from_agent`, or a non-empty `changedDuringRun`, is not green.
   **No editor connected?** Run `pix3 smoke` after `check`: it runs the game headless in Node
   for 2 s (`--frames N` for more) and exits 1 on any script throw, `console.error` or
   unhandled rejection, naming script, frame and source line. Green means nothing threw; it
   does not mean it plays (nothing was tapped or drawn).
5. **Art: placeholder → SVG → `generate_asset`, never emoji.** Placeholder = `ColorRect2D`, or
   a near-white PNG in `sprites/` tinted with a `core:tint` effect. Better art = an SVG you
   write into `sprites/` (known gap: an `.svg` on a `Sprite2D` is not verified yet — check it
   renders), or `generate_asset` through the live channel. A label/text that is only emoji is
   refused — emoji are not art. List every placeholder you leave.

## YAML essentials (`.pix3scene`) — details in `pix3-scene-format`

```yaml
version: 1.0.0
metadata: { description: 'what this scene is' }
root:
  - id: game-root                  # unique in the scene; never rename an existing id
    type: Group2D                  # exact node type name; a typo loads as an inert node
    name: Game Root
    properties:
      width: 1080
      height: 1920
      transform: { position: [0, 0], scale: [1, 1], rotation: 0 }   # 2D, rotation in degrees
    components:
      - id: game-rules
        type: user:GameRules       # user:<ExportedClassName> or core:<Builtin>
        enabled: true
        config: { targetScore: 18 } # keys = the script's schema names
    children:
      - id: result-overlay         # prefab/overlay instance: NO type, NO components
        name: Result Overlay
        instance: res://scenes/ui/result.pix3scene
        properties: { visible: false }
```

- The sample assumes a 1080×1920 portrait 2D root; yours may not have one. Read
  `viewportBaseSize` and `projectType` in `pix3project.yaml` first; a `3d` project may have loose
  top-level 2D nodes (HUD) with no 2D root at all. Place new HUD relative to the HUD nodes that
  already exist (same parent, same anchoring), not to an assumed screen size.
- 2D space: design pixels, origin at the screen centre, **X right, Y up**. `position` is the
  node's centre. Tree order is paint order: later/deeper draws on top.
- **Quote every colour**: `color: "#141a2e"`. Unquoted, `#` starts a YAML comment.
- Textures: `texture: { type: 'texture', url: 'res://sprites/ph-target.png' }`.
- `visible: false` on an overlay instance hides it **in the editor only**; play mode reads
  `initiallyVisible` on the overlay file's root. Keep both as the recipe has them.
- The loader is forgiving — unknown types, unknown keys and wrong value types load silently
  as nothing. That is why rule 4 exists.

## Script essentials — details in `pix3-scripts`

```ts
import { Script, type PropertySchema } from '@pix3/runtime';

export class Combo extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = { windowSec: 1 };            // defaults; scene `config` merges over them
  }
  static getPropertySchema(): PropertySchema {  // REQUIRED, or the class is not registered
    return { nodeType: 'Combo', properties: [/* one entry per config key */], groups: {} };
  }
  onStart(): void {}                           // scene is loaded
  onUpdate(dt: number): void {}                // dt in seconds
}
```

- One mechanic = one new script of 70–140 lines. Extend a recipe's scripts only where
  `design/recipe.md` names an extension point; do not restructure them.
- Talk between scripts the way the project already does. Recipes use signals on nodes:
  `node.emit('touch-scored', 1)` / `node.connect('touch-scored', this, fn)` — never rename the
  recipe's signals or node ids. An existing game may use its own event bus or store instead
  (next section).
- Transforms are mutated, never assigned: `node.position.set(x, y, 0)`, `node.rotation.z = rad`.
- Types come from `@pix3/runtime`: `pix3 check` type-checks against the bundled declarations in
  `.pix3/types/` (or against your own `node_modules` when the project has its own `tsconfig.json`).

## Hosting an existing (non-recipe) game

A game that was not made from a recipe has its own architecture; plug into it, do not add a
second one.

- **Find its event bus / state store** before writing a script:
  `grep -rn "CustomEvent\|dispatchEvent\|addEventListener\|subscribe(\|EventTarget\|emit(" src scripts`.
  Window `CustomEvent`s, an `EventTarget` singleton, or a store with `subscribe()` are all
  normal; node signals are only one option. Listen to what the game already emits.
- **Clean up by hand.** `Script.onDetach` auto-disconnects only **node signals** whose target is
  the script (on its own node or any other). Window listeners, store subscriptions and timers
  must be removed in `onDetach` (keep the handler in a field; call the
  unsubscribe the store returned) — otherwise every play/stop in the editor leaves one more
  live listener behind.
- **Two instruction files.** The project's own `AGENTS.md` wins on **process** (planning first,
  where config and tests go, commit rules); this kit wins on **Pix3 facts** (the YAML format,
  the runtime API, `pix3 check`).
- The project's own `package.json` means `npm install` before `pix3 check` can type-check.
- **Use the game's own feedback mechanisms.** If its camera controller writes the camera's
  position every frame, an engine `scene.juice.shake('camera')` / `core:Shake` on that 3D camera
  (or on any node the game positions itself) is overwritten every frame and never shows — call
  the game's own shake (grep `shake`) instead. The same holds for its own sound/tween helpers.

## The CLI and the live channel

- `pix3 check [--json]` — after every batch (rule 4). `--json` prints `files` (`{ file, sha256 }`,
  sha256 of the raw bytes), `diagnostics`, `typecheck`, `mergeLog`, `kit`.
- `pix3 read <file>` — print a file and confirm to the editor you read exactly these bytes.
- `pix3 validate [paths…]` — scenes only, no type-check.
- `pix3 smoke [scene] [--frames N] [--json]` — run the game headless (no browser) and report
  script throws with frame and stack, `console.error`, missing `res://` files; exit 1 on errors.
- `pix3 tree [scene] [--types A,B] [--depth N] [--props] [--json]` — scene outline, one line
  per node; no scene = project overview.
- **Live channel (optional).** When the human runs `pix3 serve` in this folder and connects the
  editor to it (File → Connect to Workspace…), the MCP server in `.mcp.json`
  (`pix3 mcp --workspace`) gives you 14 tools: running and observing the game, screenshots,
  asset/sfx generation. There is no scene-editing tool — you still edit files. Details and the
  answer fields: `.claude/skills/pix3-verify/SKILL.md` ("Live channel").

## Skills (read the one you need, when you need it)

- `.claude/skills/pix3-scene-format/SKILL.md` — full YAML format, prefabs, overlays, recipe tool table
- `.claude/skills/pix3-nodes/SKILL.md` — 2D node properties (Group2D, ColorRect2D, Sprite2D, Label2D, Button2D, Bar2D, CanvasLayer2D, PostProcess); every node in `reference.md` beside it
- `.claude/skills/pix3-scripts/SKILL.md` — Script API: lifecycle, schema, scene/input/juice/tween/audio/physics, `core:` components, traps
- `.claude/skills/pix3-verify/SKILL.md` — `pix3 check` / `validate` / `read`, merge-log, the live channel (`game_run` + `expect`)

## Finish every turn with

What changed (files), what `pix3 check` said, whether you ran the game (and what `game_run`
answered) or what the human should press and see, placeholders left, and 2–3 concrete next steps.
