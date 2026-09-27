# Phase 0 agent kit draft — sources

What every section of the draft was spliced from, so the Phase 1 generator
(`@pix3/cli` kit build, plan §5 B) knows what to build from what, and the drift spec knows
what to compare. "code" rows mean the prose source was wrong or silent and the kit follows
the implementation; those are the places a generator fed only from `docs/` would lie.

## Map

| Kit file → section | Source file → heading / symbol | Note |
| --- | --- | --- |
| `AGENTS.md` → intro, "Read first" | `.plans/external-agent-authoring.md` → "## 1. Цель", "### 4.1", "### 4.4"; `src/services/agent/agent-skills/flow-increment.md` → "## 1. You did not start from an empty project" | recipe-first, read `design/recipe.md` first, no survey |
| `AGENTS.md` → "Layout" | `src/templates/projects/recipe-tapper-2d/files/README.md` → "Layout"; `src/templates/agent/AGENTS.md` → "Where things are"; `docs/pix3-specification.md` → "Key Principles" (Flat Asset Layout) | |
| `AGENTS.md` → "The five rules" | plan → "### B. Agent kit" rules 1–5, rewritten for no-MCP; `game-prototype.md` → "## 2. Restate the plan" (do not wait for approval); `flow-increment.md` → "## 5. Asking is allowed — about structure only" | MCP/`game_run` parts of rule 4 and `generate_asset` in rule 5 dropped (plan: kit is built per phase) |
| `AGENTS.md` → "YAML essentials" | spec → "Scene File Format"; recipe `scenes/main.pix3scene`; spec → "Project Templates, Target Platform and Agent Overlay" (`scenes/ui/` paragraph) | |
| `AGENTS.md` → "Script essentials" | `agent-skills/engine-api-map.md` → "A `Script`"; recipe `README.md` → "The rule that keeps it workable" (70–140 lines, one mechanic = one script) | |
| `pix3-scene-format` → "Before you write" | plan → "### 4.1" (temp file + rename advice); `verify-and-fix.md` → "The loop" step 0 (str_replace, not full rewrite) | |
| `pix3-scene-format` → "File", "Node" | spec → "Scene File Format" → "Example Structure", "Validation Rules"; **code** `packages/pix3-runtime/src/core/SceneLoader.ts` (`SceneDocument`, `SceneNodeDefinition`, duplicate-id `SceneValidationError`), `SceneSaver.ts` `serializeNodeProperties` | header/transform form follows saver + recipes, not the spec example (OQ 1) |
| `pix3-scene-format` → "Rules" (forgiving loader) | spec → "Key Principles" (Forgiving Vocabulary); plan → "### A" (`validate` bullet: what the loader does itself) | |
| `pix3-scene-format` → "2D transform", 3D transform | **code** `SceneSaver.serializeNodeProperties`, `SceneLoader.readVector2`, `nodes/Node2D.ts` (rotation degrees → radians) | OQ 1, OQ 4 |
| `pix3-scene-format` → "Anchor layout", flow | **code** `SceneLoader.parseNode2DLayout`, `parseNode2DFlow`, `Node2D.applyAnchoredLayout`; `docs/node-types-reference.md` → "### Node2D" usage notes | OQ 5 |
| `pix3-scene-format` → "Values" | spec → "Key Principles" (res://, flat layout); **code** `TextureResource.coerceTextureResource`; YAML `#` comment rule = YAML itself | |
| `pix3-scene-format` → "Shader effects" | `engine-api-map.md` → "Nodes" (effects bullet); recipe `design/recipe.md` → "Placeholders"; recipe `scenes/prefabs/target.pix3scene` | |
| `pix3-scene-format` → "Component" | spec → "Script Component System" → "Scene Serialization"; **code** `core/component-hydration.ts` (`instantiateComponent` merges config; pending components); `engine-api-map.md` → "Built-in behaviours" | core: config keys not documented anywhere readable (OQ 10) |
| `pix3-scene-format` → "Prefab instance" | spec → "Node Prefabs System" → "Instance Creation", "Structural Editing & Instance Lock", "Inspector Integration"; **code** `SceneLoader` ("must contain exactly one root node"); recipe `design/recipe.md` → "Do not touch" | OQ 5, OQ 6 |
| `pix3-scene-format` → "Full-screen UI lives in scenes/ui/" | spec → "Project Templates, Target Platform and Agent Overlay" (`scenes/ui/` paragraph); `src/templates/agent/AGENTS.md` rule 3 | |
| `pix3-scene-format` → "Recipe tool names → file edits" | recipe `design/recipe.md` → "Tunables" footer, "Extension points" | new; see OQ 12 |
| `pix3-nodes` → "Which node" | `docs/node-types-reference.md` → "Choosing the Right Node"; "Node Properties Quick Reference" | |
| `pix3-nodes` → "Every 2D node" | node-types-reference → "### Node2D"; spec → `scenes/ui/` paragraph (`initiallyVisible`); `engine-api-map.md` (effects) | |
| `pix3-nodes` → Group2D, ColorRect2D, Label2D, CanvasLayer2D, PostProcess | node-types-reference → `### Group2D`, `### ColorRect2D`, `### Label2D`, `### CanvasLayer2D`, `### PostProcess`; defaults checked in **code** `nodes/2D/*.ts`, `nodes/2D/UI/UIControl2D.ts` | |
| `pix3-nodes` → Sprite2D | node-types-reference → `### Sprite2D`; **code** `SceneLoader` Sprite2D branch, `SceneSaver` (writes `texture:`) | OQ 3 |
| `pix3-nodes` → Button2D | node-types-reference → `### Button2D`; spec → "Skinned 2D UI controls"; **code** `SceneLoader` Button2D branch (`label`, `enabled`, label style) | OQ 7 |
| `pix3-nodes` → Bar2D | **code** `SceneLoader` Bar2D branch, `nodes/2D/UI/Bar2D.ts` constructor | node-types-reference `### Bar2D` is wrong (OQ 2) |
| `pix3-nodes` → PostProcess tuning hint | recipe-bouncer-2d `design/recipe.md` → "Tunables" footer | |
| `pix3-scripts` → Shape | spec → "Example Component"; recipe `scripts/Spawner.ts`, `scripts/ScoreHud.ts`; **code** `ProjectScriptLoaderService.tryRegisterScriptClass` (registration needs `getPropertySchema` + `extends Script`; id `user:<exportName>`; dirs `scripts/`, `src/scripts/`); `fw/property-schema.ts` (`PropertyType`, `PropertyUIHints`) | |
| `pix3-scripts` → Lifecycle, Members | spec → "Script Lifecycle"; `engine-api-map.md` → "A `Script`"; **code** `core/ScriptComponent.ts` (`findNode`, `getNode`, `onDetach` disconnect); recipe `ScoreHud.ts` comment (parents start first) | |
| `pix3-scripts` → Nodes, Signals, `this.scene`, `this.input` | `engine-api-map.md` → "Nodes", "`this.scene`", "`this.input`"; recipe `PaddleController.ts` (`getButton('Key_…')`) | trimmed: 3D, multiplayer, cutscenes, debug-surface tool details |
| `pix3-scripts` → Traps | `engine-api-map.md` → "Traps"; `game-prototype.md` → "## 4½. Engine API traps"; recipe `design/recipe.md` → "Ending a run belongs to GameRules" | |
| `pix3-verify` → `pix3 check` / `validate` / error table | plan → "### A" (`validate`, `check` bullets, error list) | CLI does not exist yet (OQ 11) |
| `pix3-verify` → Merge-log | plan → "### B" rule 2, "### A" (`ack` / `read` bullet), "### 4.3" | |
| `pix3-verify` → Manual pass | derived from spec "Validation Rules" + the `validate` error list + `verify-and-fix.md` → "Common runtime problems and fixes" | new |
| `pix3-verify` → Report honestly | `src/templates/agent/AGENTS.md` rule 8; `game-prototype.md` → "## 6. Finish"; `flow-increment.md` (2–3 next steps) | |
| art rule (AGENTS rule 5, nodes, verify) | `src/services/agent/emoji-as-art.ts` (`isEmojiOnlyText`, `TEXT_PROPERTIES`); `game-prototype.md` → "## 4⅔. Placeholders"; `asset-generation.md` → "## 0. Pick the lane" | SVG-as-file is new (OQ 9) |
| `TRIAL-PROTOCOL.md` | plan → "### Фаза 0" ("Агенты.", "Выход"), "## 7. Метрики"; the three `design/recipe.md` → "Extension points", "Tunables" | |

## Open questions

1. **Scene header and transform form.** Spec §7.2 example: `version: 1.0`, top-level
   `description`, flat `position: { x, y, z }`. `SceneSaver` and every recipe: `version: 1.0.0`,
   `metadata: { description }`, `transform: { position: [..], scale: [..], rotation }` (2D) /
   `rotationEuler` (3D). The loader reads both. The kit teaches the saved form; the spec
   example should be brought in line, or the strict profile will have to accept both forever.
2. **Bar2D reference is wrong.** `node-types-reference.md` lists `backgroundColor` /
   `fillColor`, width 200, value 50. Loader + node read `backBackgroundColor` / `barColor`,
   width 150, value 100, and also `minValue`, `showBorder`, `borderColor`, `borderWidth`.
   An agent following the doc writes keys that are silently ignored. Phase 1 must generate
   node tables from `getPropertySchema()` + the loader, not from that doc — and the other
   node tables were not audited here.
3. **Sprite2D texture key.** Doc: `texturePath` (string). Saver writes
   `texture: { type: 'texture', url }`; loader accepts either; `engine-api-map.md` constructs
   with `texturePath`. Which one will strict `validate` treat as canonical (and not flag as
   unknown property)?
4. **2D rotation direction.** `node-types-reference.md` → Node2D: "Rotation is clockwise, in
   degrees". `verify-and-fix.md` → "Moves, but in the WRONG direction": `rotation.z` rotates
   counter-clockwise with +Y up. The kit states only units (degrees in YAML, radians in
   `rotation.z`), not direction. Needs a ruling.
5. **Layout/flow key names.** YAML uses `layout: { enabled, horizontalAlign, verticalAlign }`
   and `flow: { enabled, … }`; `node-types-reference.md` → Group2D says `flowEnabled`,
   `flowDirection`…; spec "Inspector Integration" names the schema props `layoutEnabled`,
   `horizontalAlign`, `verticalAlign`. Instance overrides are applied through schema names
   (`SceneLoader.applyLegacyInstanceRootProperties`), so does `properties.layout` on an
   `instance:` node work at all? The kit tells agents to override only `transform` / `visible`
   on instances until this is answered.
6. **`overrides.byLocalId` key format** for overriding a prefab child from the host scene is
   not documented (loader re-prefixes root-relative keys). The kit tells agents not to write it
   and to edit the prefab file instead.
7. **Which button signal.** `engine-api-map.md`: "`'click'` (a completed tap — wire buttons to
   THIS)". Every recipe script connects `'pressed'`. The kit says what the recipes do. One of
   the two is wrong for new code.
8. **Prefab folder.** `engine-api-map.md` spawns `res://prefabs/x.pix3scene`; recipes keep
   prefabs in `scenes/prefabs/`; spec §6.16 mentions a top-level `prefabs/` (`isPrefabPath`).
   Kit uses the recipe path. Pick one convention for generated kits.
9. **SVG sprites written by the agent.** Plan rule 5 says "placeholders → SVG". The in-editor
   `svg-llm` lane *bakes* SVG to PNG; the runtime loads textures through three's
   `TextureLoader` from a blob URL. Untested: does a raw `.svg` in `sprites/` render on a
   `Sprite2D` in the editor, in play mode and in the single-file export (blob MIME from the
   embedded `mimeType`), and what size does an SVG without `width`/`height` get? Phase 0
   should try it; if it fails, the kit must say "write SVG, `pix3` bakes it" and that becomes
   a CLI feature.
10. **`core:*` component config keys** have no readable source for an external agent (the
    in-editor agent calls `list_component_types`). The kit only lists ids and two examples
    copied from recipes. Phase 1 should dump each `core:` schema into `pix3-scripts` or a
    reference file.
11. **CLI surface is plan-only.** `pix3 check` / `validate --json` / `read` and the
    `.pix3/merge-log.jsonl` format come from plan §5 A / §4.3; nothing implements them. The
    draft tells the agent to fall back to the manual pass. Regenerate the verify skill when
    the CLI lands; decide whether `check` output names merge-log entries per file/node/key.
12. **`design/recipe.md` speaks in editor tool names** (`set_component_property`,
    `create_node`, `fs_write` with `overwrite: true` + `reason`, `play_start`, `game_input`),
    and its "Verify" sections are tool scripts. The kit adds a translation table. Alternative:
    make `recipe.md` tool-neutral and let each kit add its own verbs.
13. **Tapper "Combos" extension point recurses as written.** It says a new script on `hud`
    listens for `touch-scored` on `game-root` and "re-emits `touch-scored` with a bigger
    amount". Re-emitting the signal you listen to on the same node calls your own handler
    again. T3 in the protocol probes it; the recipe text probably wants a different signal or
    a guard.
14. **The existing overlay (`src/templates/agent/**`) is not retired.** New projects already
    get an `AGENTS.md` with two branches (in-editor / external), a `pix3-game-dev` skill whose
    `references/` bundles full `nodes-and-systems.md` + `node-types-reference.md`, and
    `pix3-remote-preview`. The trial deletes them; Phase 1 must decide replace vs merge, and
    whether the bundled references become the "full reference" file the `pix3-nodes` skill
    points at (with OQ 2 fixed first).
15. **Sprite2D default size (64)** is from the doc and was not confirmed in code.
16. **No type-check in Phase 0.** Projects have no `node_modules` and no `.pix3/types/`, so
    an agent cannot run `tsc`; script correctness rests on the manual pass until `check`
    ships its bundled `.d.ts` (plan §5 A).

## Where existing skills contradict the plan's kit rules

| Existing text | Plan rule it contradicts | Handling in the draft |
| --- | --- | --- |
| `idea-stage.md` → "## 3. End the turn with a question" — `ask_user` as the *normal* end of a turn | Rule 1: playable change first, questions after | Not spliced. (Idea stage has no recipe; an external kit always starts from one.) |
| `game-prototype.md` → "## 4. How to make changes" — "Never hand-edit a scene file just to add a component"; a scene `fs_write` "replaces the scene wholesale" | §4.1: files are the only write path | Inverted: the kit teaches YAML as the way to add components, with surgical edits |
| `game-prototype.md` → "## 1. Understand the design" — up to 8 exploration calls incl. `analyze_image`, `scene_tree`; "## 2" mandatory `design/progress.md` | §4.4 speed; rule 1 | Kit: read `design/recipe.md` + the one file you change; no progress file required |
| `verify-and-fix.md` → opening line "Never declare a feature done without running it" + the whole `play_*`/`game_*` loop | Rule 4 in its no-MCP form (`pix3 check`) | Kit: check + honest report + tell the human what to press; running returns with MCP in Phase 3 |
| `flow-increment.md` → "## 5" — pick the shade of blue / speed / font size yourself | Rule 3: leave layout, colours, fine-tuning to the human | Both kept: choose small values yourself (rule 1) **and** offer the editor for fine-tuning (rule 3). Worth one sentence in the plan |
| `asset-generation.md` → "## 0" — "everything vector first" via `generate_asset` `svg-llm` | Rule 5 order: placeholders → SVG → `generate_asset` | Kit uses the plan's order; `generate_asset` omitted (no MCP) |
| `src/templates/agent/AGENTS.md` rule 6 — placeholders may be "the bundled logo" / `GeometryMesh` | Rule 5 | Kit: `ColorRect2D` or tinted near-white PNG only |
| `engine-api-map.md` → "wire buttons to `'click'`" vs all recipe scripts on `'pressed'` | (internal inconsistency, OQ 7) | Kit follows recipes |
