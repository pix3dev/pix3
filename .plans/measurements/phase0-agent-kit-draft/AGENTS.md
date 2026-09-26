# AGENTS.md — Pix3 game project

This folder is a **Pix3 game**: a 2D/3D browser game. You edit it by writing files. A human
has the same folder open in the Pix3 editor, moves things with the mouse and presses Play.
You have no editor tools, no MCP and no way to run the game yourself. The files are the
whole contract.

It started from a **recipe**: a game that already plays. Change it; do not rebuild it.

## Read first

1. `design/recipe.md` — the map: stable node ids, tunables with ranges, extension points,
   what must not be touched. It was written for the in-editor agent's tools; translate them
   with the table in `.claude/skills/pix3-scene-format/SKILL.md` ("Recipe tool names").
2. `README.md` — file layout of this recipe.
3. The one scene or script you are about to change. Nothing else. Do not survey the repo.

## Layout

| Path | What |
| --- | --- |
| `scenes/main.pix3scene` | The game scene. The editor opens it first. Iterate here |
| `scenes/menu.pix3scene` | Entry scene of a build; PLAY changes scene to `main` |
| `scenes/ui/*.pix3scene` | Full-screen overlays (result card, modals), one file each, instanced hidden |
| `scenes/prefabs/*.pix3scene` | Prefabs: a scene file with exactly ONE root node |
| `scripts/*.ts` | Script components. `export class X extends Script` → `type: user:X` |
| `sprites/`, `audio/`, `fonts/` … | Assets, referenced as `res://sprites/x.png` (path from project root) |
| `design/` | Recipe contract, GDD, tests. `design/tests/` is written by the editor's harness |
| `pix3project.yaml`, `.pix3/` | Project manifest / editor metadata. Do not edit unless asked |

## The five rules

1. **Playable change first, questions after.** Make the change the user asked for, in the
   smallest form that plays, before asking anything. Choose small things yourself (a shade, a
   speed, a count) and say so in one line. At most ONE question per turn, and only about a
   fork that changes structure ("win by score or by time?"). Never open with a question.
2. **Re-read a scene before you edit it.** The human may have changed it in the editor a
   minute ago. Edit the lines you mean to change (search/replace), never regenerate a whole
   scene from memory. After writing, if `pix3 check` reports **merge-log** entries where the
   editor kept the human's value instead of yours, re-read the file with `pix3 read <file>`;
   if your value is still intended, write it again — or ask the human. Without that re-read
   the editor keeps restoring the human's value on every write you make.
3. **Leave layout, colours and fine-tuning to the human.** If asked "a bit more to the left",
   do it, then offer: "you can drag it in the editor — it saves on its own".
4. **Run `pix3 check` after every batch of edits** and fix what it reports before you say
   "done". It checks YAML, node types, properties, `res://` paths, prefabs, scripts (tsc).
   If `pix3` is not installed (this draft kit predates the CLI), do the manual pass in
   `.claude/skills/pix3-verify/SKILL.md` instead — re-read every file you wrote against the
   format. Either way, you did not run the game: say so, and tell the human what to press
   and what they should see.
5. **Art: placeholder → SVG → never emoji.** Placeholder = `ColorRect2D`, or a near-white
   PNG in `sprites/` tinted with a `core:tint` effect. Better art = an SVG you write
   yourself into `sprites/` and put on a `Sprite2D`. A label/text that is only emoji is
   refused by the editor — emoji are not art. List every placeholder you leave.

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

- One mechanic = one new script of 70–140 lines. Extend the recipe's scripts only where
  `design/recipe.md` names an extension point; do not restructure them.
- Talk between scripts through signals on nodes: `node.emit('touch-scored', 1)` /
  `node.connect('touch-scored', this, fn)`. Never rename the recipe's signals or node ids.
- Transforms are mutated, never assigned: `node.position.set(x, y, 0)`, `node.rotation.z = rad`.

## Skills (read the one you need, when you need it)

- `.claude/skills/pix3-scene-format/SKILL.md` — full YAML format, prefabs, overlays, recipe tool table
- `.claude/skills/pix3-nodes/SKILL.md` — 2D node properties (Group2D, ColorRect2D, Sprite2D, Label2D, Button2D, Bar2D, CanvasLayer2D, layout)
- `.claude/skills/pix3-scripts/SKILL.md` — Script API: lifecycle, schema, scene/input/juice/tween/audio/physics, traps
- `.claude/skills/pix3-verify/SKILL.md` — `pix3 check` / `validate` / `read`, merge-log, the manual pass

## Finish every turn with

What changed (files), what `pix3 check` said (or that you did the manual pass), what the human
should press and see, placeholders left, and 2–3 concrete next steps.
