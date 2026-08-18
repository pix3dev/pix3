# Flow 3D support + mobile-first material defaults

Design analysis (no implementation) following a real Flow-mode incident: "3D voxel puzzle" →
isometric 2D sprites, then a real 3D cube that rendered black in play mode. Date: 2026-08-18.

## Status (2026-08-19)

**P0, P1 and the actionable half of P2 are implemented on branch `feat/flow-3d-renderability`**
(uncommitted). Full suite green: 3523 tests, `tsc --noEmit` clean, ESLint clean on every touched
file. Nothing has been verified in a running editor yet — see "Left to do" at the end.

| item | state | where |
| --- | --- | --- |
| P0.1 renderability lint + surfacing | done | `packages/pix3-runtime/src/core/renderability-lint.ts`, `src/services/agent/renderability-note.ts`, `scene_tree`, `game_observe`, play-start (Logs + banner), `game_run` notes |
| P0.2 light aliases + vocabulary + drift guard | done | `packages/pix3-runtime/src/core/node-type-registry.ts`, `SceneLoader` switch, `LightNodeAliases.spec.ts` |
| P0.3 lights/Box/Checkbox2D + `position3` | done | `src/services/agent/create-node-registry.ts`, `create_node` schema |
| P0.4 3D recipe + user-visible downgrade notice | done, **not yet verified live** | `recipe-scene-3d` → `playable-3d` (+ `design/recipe.md`), dimension-aware fallback in `PrototypeBootstrapService` |
| P0.5 skill lines | done | `game-prototype.md`, `verify-and-fix.md`, `flow-increment.md` |
| P1.3 screenshot fallback-lighting flag | done | `ViewportRenderService.isUsingEditorFallbackLighting()`, `viewport_screenshot` |
| P1.4 registry-vs-Create-menu drift spec | done | `create-node-registry.spec.ts` (+ `EXCLUDED_FROM_AGENT` with reasons) |
| P1.1 `material.type` on GeometryMesh | done | `GeometryMesh.ts` (`standard`/`lambert`/`basic`, live family switch, round-trip), `SceneLoader`, `ShaderEffectStack.retarget()` |
| P1.2 mobile creation-time default | done | `src/core/material-defaults.ts`, `CreateBoxOperation`, `playable-3d` scene, planner `targetPlatform` |
| P2.1 DeepCore verification | n/a — resolved by inspection | DeepCore consumes `@pix3/runtime` from **npm** (`^1.2.0`), not yalc, and uses no `GeometryMesh` at all; the node default is unchanged, so there is no regression surface to publish against |
| P2.2 second 3D recipe | deliberately not started | its own precondition is telemetry from the first one |
| P2.3 quality → runtime plumbing | already existed | `ProjectBuildService` writes `antialias`/`shadows`/`maxPixelRatio` into the export config and `player-main.ts` applies all three via `RuntimeRenderer` |
| P2.4 PBR-on-mobile advisory | done | `renderability-lint.ts` (`pbr-on-mobile`, severity `advice`) |

Deviation from the plan below, worth knowing: **P0.4 did not need a new recipe built from scratch.**
`playable-3d` already ships a correct 3D stage (Camera3D + DirectionalLightNode + AmbientLightNode +
two `GeometryMesh`), so it was promoted into the recipe catalog through the existing
`RECIPE_TEMPLATE_ALIASES` mechanism — the same way `recipe-playable-ad` is served by `playable-2d` —
and given the `design/recipe.md` the contract requires. The fallback also became dimension-aware: an
invented recipe id containing "3d" now resolves to the 3D recipe instead of the 2D arena, which is
the incident's first domino removed rather than merely announced.

### Deviations from the recommendations, and why

- **`universal` counts as mobile** for the creation-time material default, where §2 said only
  `mobile` does. The user's rule is "mobile is the default target; PBR only when someone asks for a
  desktop look", and a universal build runs on phones — the cheap material is the one that is safe
  to be wrong about. `desktop` is the only value that buys PBR.
- **Lambert shares the `standard` shader-effect family** rather than getting one of its own.
  Checked, not assumed: all four anchors the composer injects at (`uv_vertex`, `color_fragment`,
  `emissivemap_fragment`, `opaque_fragment`) exist in three's `meshlambert.glsl.js`. The
  alternative — no effects on lambert — would mean picking the mobile material silently disables a
  project's shader effects, a worse failure than the one being fixed. `ShaderEffectStack.retarget()`
  drops genuinely incompatible effects with a named warning instead of leaving them attached and dead.
- **The advisory lint is severity-split, not just "advisory".** `blocking` findings ride every
  surface; `advice` reaches `scene_tree` (authoring) and the Logs, but NOT `game_observe` (called in
  a loop) and never the Game-tab banner. A cost warning repeated on every poll would spend the
  credibility of the black-screen findings sitting next to it.

Two things found while implementing that the analysis did not have:
1. **The `*Node` naming gap is in three places, not one.** The class is `DirectionalLightNode`, the
   on-disk type is `DirectionalLightNode`, but `node.type` (what a scene-tree dump shows) is
   `DirectionalLight` — and `SceneSaver` carries an explicit fix-up block for exactly this. The
   recipe-contract spec had silently drifted onto the same rock: it keyed node schemas by
   `schema.nodeType` (`AmbientLight`) and would have called `AmbientLightNode` an unknown type.
2. **The editor's fallback lighting was made *more* misleading by the bug it hid.**
   `isEditorFallbackLightingEnabled()` is `showLighting && !activeSceneHasExplicitLights()`, and a
   misnamed light loads as an inert `NodeBase`, so `activeSceneHasExplicitLights()` said "no lights"
   and kept the editor's own lights on. Authoring the light *correctly* would have turned the
   fallback off; authoring it wrongly made the editor look better than the game.

---

## The causal chain (why the incident was structurally inevitable)

1. **Flow can only start 2D.** `PrototypeBootstrapService.RECIPE_CATALOG` contains only
   `recipe-tapper-2d` / `recipe-arena-2d` / `recipe-bouncer-2d` / `recipe-playable-ad` (a `playable-2d`
   alias). Any planner answer outside that list — including a correct "there is no 3D recipe" — falls
   back to `recipe-arena-2d` (`FALLBACK_RECIPE_ID`, ~line 116) with a note that lands in
   `design/brief.md`, **not in front of the user**. The agent then rationalises the 2D skeleton into
   "isometric voxels".
2. **After correction, the agent had no legal path to a lit 3D scene.**
   `src/services/agent/create-node-registry.ts` has no lights and no box primitive (the commands
   exist: `src/features/scene/Create{AmbientLight,DirectionalLight,HemisphereLight,PointLight,SpotLight,Box}Command.ts`),
   so it hand-wrote YAML — the one path the system prompt discourages and nothing validates.
3. **The wrong light type name failed silently.** The canonical names are `DirectionalLightNode` /
   `AmbientLightNode` / `HemisphereLightNode`, unlike every other 3D node (`Camera3D`, `Sprite3D`).
   `SceneLoader` (~line 2094) turns an unknown `type:` into an inert `NodeBase` with no warning.
4. **PBR + no light = black.** `GeometryMesh` builds `MeshStandardMaterial` (line ~108);
   `InstancedMesh3D.DEFAULT_MATERIAL` likewise.
5. **The editor viewport hid the failure.** `ViewportRenderService` adds fallback ambient+directional
   lights when the scene has no *recognised* lights (`isEditorFallbackLightingEnabled`, ~line 1125) —
   and the misnamed lights were `NodeBase`, so `activeSceneHasExplicitLights()` said "no lights",
   fallback stayed on, the viewport looked fine, and any screenshot-based verification passed.
6. **No guidance layer mentions 3D lighting or mobile material budgets** across the four built-in
   skills (`src/services/agent/agent-skills/*.md`).

Five independent holes, all of which had to be open for the incident. Each fork below closes one.

---

## 1. Dimensionality in Flow

**Recommendation.** Keep recipes as the planner's *only* vocabulary (the recipe contract —
tunables, placeholders, increments — is what keeps the expander deterministic; letting the planner
pick raw templates like `empty-3d` would ship a project with no brief-able tuning surface). Do three
things:

1. **Add one 3D recipe: `recipe-grid-3d`** — a "grid/voxel toy" matching the incident class and the
   broadest 3D-casual shape: an N×N×N grid of `GeometryMesh` boxes (or one `InstancedMesh3D`),
   `HemisphereLightNode` + `DirectionalLightNode`, a `Camera3D` with an orbit-ish framing, tap →
   raycast → remove/toggle a cell, score + win condition. Blurb: *"a 3D grid of blocks the player
   taps to remove/toggle; match, clear or dig. Voxel diggers, block puzzles, 3D minesweeper,
   stack/tower toys."* New template folder `src/templates/projects/recipe-grid-3d/` with
   `projectType: '3d'`, `targetPlatform: 'mobile'` in its manifest, entry added to `RECIPE_CATALOG`.
2. **Recipes declare `projectType`** in the catalog entry (`{ id, blurb, projectType: '2d' | '3d' }`)
   and the planner prompt asks for a `dimensionality` field in its JSON. This costs nothing today
   and is the hook for every future 3D recipe.
3. **Cross-dimensionality fallback becomes user-visible.** In `resolveRecipeId` (~line 815) and the
   planner-failure paths: when the *requested/planned* dimensionality is 3D and the resolved recipe
   is 2D, the pushed issue is tagged as user-facing, and the Flow bootstrap surfaces it as a chat
   notice before the first agent turn (e.g. *"I don't have a 3D template for this yet — I'm building
   it as a 2D isometric take. Say 'make it real 3D' and I'll build the scene by hand."*). Mechanism:
   `plan()`'s `issues: string[]` becomes `issues: { text: string; audience: 'brief' | 'user' }[]`
   (or a parallel `userNotices` array — smaller diff); the caller at line ~358 already has `notes`
   for the brief and just additionally routes `user` items into the Flow chat transcript.

With `recipe-grid-3d` in the catalog, the incident prompt resolves to a real 3D skeleton and the
fallback path is never taken; the notice covers the 3D genres the catalog still lacks (racer, FPS…).

**Cost/risk.** One hand-built recipe is real content work (scene + placeholders + tunables +
`design/recipe.md` + spec coverage in `recipes.spec.ts`, ~M) and it will be the *only* 3D recipe, so
the planner may over-match 3D asks onto it — acceptable, since "a 3D toy grid you then reshape" is a
strictly better starting point for any 3D ask than arena-2d.

---

## 2. Mobile-first material policy

**Recommendation.** A *creation-time* policy, not a render-time switch — nothing re-materials
existing scenes.

- **Runtime:** `GeometryMeshProps.material` gains `type?: 'standard' | 'lambert' | 'basic'`
  (default `'standard'`). The serializer already writes `material: { type: 'standard' }`
  (`GeometryMesh.ts` ~line 438), so this is a natural, backward-compatible extension: the
  constructor branches on it (`MeshStandardMaterial` / `MeshLambertMaterial` /
  `MeshBasicMaterial`), the property schema exposes it as an enum, `SceneLoader`/`SceneSaver`
  round-trip it. Same field on `InstancedMesh3D`. Roughness/metalness stay standard-only
  (schema hides them for other tiers).
- **The switch lives in the authoring layer**, keyed off the manifest's existing
  `targetPlatform` (which already drives `createDefaultQualitySettings` —
  `src/core/ProjectManifest.ts` ~line 108, mobile = no AA, no shadows). `CreateBoxCommand` /
  future 3D create commands read the active project manifest: `targetPlatform === 'mobile'` →
  author `material: { type: 'lambert' }`; `desktop`/`universal` → `'standard'`. The
  `recipe-grid-3d` template hardcodes `lambert` in its YAML (it declares mobile).
- **Why lambert, not unlit:** `MeshBasicMaterial` can never render black-from-no-light, but it also
  reads as flat colour — a voxel cube becomes an unreadable silhouette. Lambert is per-vertex-cheap,
  keeps depth cues, and the black-cube failure mode it retains is exactly what fork 5's invariant
  catches. Unlit stays available as an explicit `type: 'basic'` choice (and the skill guidance
  names it for "flat/stylised" asks).
- **Opting into "super pretty desktop":** set the project's `targetPlatform` to `desktop` (new
  creations become `standard`, quality defaults flip AA/shadows on) or set `material.type:
  'standard'` per node in the inspector. The Flow planner maps "super pretty / high-end / desktop"
  phrasing to `targetPlatform: 'desktop'` in the brief.
- **Existing projects / DeepCore: untouched by construction.** The node default stays `'standard'`,
  every existing scene either omits `material.type` or already says `standard`, and no loader
  migration runs. The policy only changes what *newly created* nodes in mobile-target projects say.

**Cost/risk.** Two nodes' material construction paths and their shader-effect install
(`installEffectComposer` takes `MeshStandardMaterial` — the effect stack must accept the union or
declare standard-only) — the effect-stack interaction is the one real risk; size M.

---

## 3. The silent-unknown-type hole

**Recommendation.** All three layers, with distinct roles — but one shared mechanism in the runtime:

- **`SceneLoader` (runtime, stays editor-agnostic):** keep the permissive `NodeBase` fallback (a
  player must not crash on a scene from a newer editor), but make the loader *collect* what it
  swallowed: the parse result gains `diagnostics: { path, nodeName, unknownType, suggestion? }[]`
  (a pure data array — no console, no UI, editor-agnostic). Did-you-mean: normalise
  (`lowercase, strip non-alnum` — same rule as `create-node-registry.normalize`) against the known
  type set, then Levenshtein ≤ 2; `DirectionalLight3D`/`directional-light` both suggest
  `DirectionalLightNode`.
- **Aliases: yes.** A normalization map ahead of the switch registers `DirectionalLight`,
  `DirectionalLight3D`, `AmbientLight`, `AmbientLight3D`, `HemisphereLight`, `PointLight3D`,
  `SpotLight3D` → the `*Node` classes. These are the names the rest of the catalogue *teaches* a
  model to guess, and `DemoScenes.spec.ts` already asserts the un-suffixed forms elsewhere.
  **`SceneSaver` always writes the canonical `*Node` name** — aliases are read-compat only; one
  spelling on disk, so diffs and greps stay sane. (Rejected: renaming the classes to make
  `DirectionalLight3D` canonical — cleaner naming, but churns every existing scene, DeepCore, and
  the strippable-modules table for zero behavioural gain.)
- **Editor load path:** `SceneManager`'s load pipeline forwards loader diagnostics to the Logs
  panel as warnings (the runtime-error-surfacing path from the Logs work already exists) — this
  catches hand-edited YAML and collab edits.
- **Agent writes:** any agent tool whose effect is a scene (re)load — the fs write tool when the
  target is `*.pix3scene`, and scene open/reload — appends the diagnostics to the *tool result*
  (`warnings: ["Unknown node type 'DirectionalLight3D' at Root/Sun — did you mean
  'DirectionalLightNode'? The node was loaded inert."]`). In-band is the only place a model
  reliably reads; the Logs entry alone would require it to think to look.

**Cost/risk.** Threading a diagnostics array through the loader's recursive parse and every load
call site is wide but mechanical (size M); the alias map risks colliding with a future genuinely
different `DirectionalLight3D` class — acceptable, the alias table is one lookup to edit.

---

## 4. Agent tool coverage (create_node)

**Recommendation.** Keep the hand-written registry — but close the drift with a spec, and extend it
now. Full generation from Create-menu command metadata is a mirage: every `Create*Command` has a
bespoke payload (`spriteName` vs `nodeName` vs `meshName` vs light payloads), so a generator would
need a per-command mapping table — which is exactly what `REGISTRY` already is. What's missing is
the *forcing function*:

- **Add now:** `GeometryMesh`/`Box` (`CreateBoxCommand`), `DirectionalLightNode`,
  `AmbientLightNode`, `HemisphereLightNode`, `PointLightNode`, `SpotLightNode`, `Checkbox2D` (it
  has a command and is absent). Registry keys via the existing `normalize`, so the agent may say
  `create_node {nodeType: "DirectionalLight"}` and land correctly.
- **Drift spec:** a new `create-node-registry.spec.ts` case enumerates `CommandRegistry` entries
  whose menu path is under the Create menu, and asserts each is either in `REGISTRY` or in an
  explicit `EXCLUDED_FROM_AGENT` list *with a reason string*. Adding a `Create*Command` without
  deciding its agent story fails CI — same pattern as the strippable-runtime-modules guard.
- **`CreateNodeOptions` and 3D position:** add `position3?: { x: number; y: number; z: number }`,
  forwarded only by 3D factories (`CreateBoxCommand` takes a position payload; lights mostly want
  it too). The existing 2D `position: Vector2` stays as-is; the tool schema documents that 3D types
  take `position3`. The current "3D nodes are created at origin, then property-edit" comment stops
  being the doctrine.

**Cost/risk.** Registry additions are S; the drift spec needs Create-menu metadata to be
introspectable from a test (it is — command metadata is static) — the risk is a noisy exclusion
list, which is still infinitely better than silent drift.

---

## 5. The verification gap (highest leverage)

**Recommendation.** A *renderability lint* computed from state, surfaced everywhere the agent
already looks, plus an honesty flag on screenshots. Three pieces:

1. **Runtime lint (pure function, editor-agnostic):**
   `collectRenderabilityIssues(rootNodes): RenderabilityIssue[]` in
   `packages/pix3-runtime/src/core/` — walks a scene graph and reports, for 3D content:
   - `lit-material-no-light`: ≥1 mesh with a lit material (`standard`/`lambert`) AND zero
     enabled+visible light nodes → *"3D meshes use lit materials but the scene has no light — they
     will render black. Add a HemisphereLightNode/DirectionalLightNode or set material.type:
     'basic'."*
   - `no-camera-3d`: 3D content but no enabled `Camera3D`.
   - `inert-nodes`: any `NodeBase` whose `type` is not a registered node type (fork 3's diagnostics
     re-checked live — catches YAML that never went through a load-with-diagnostics path).
2. **Surfacing — in the channels the agent already reads, no new tool:**
   - **Play-mode start** runs the lint on the runtime graph; issues go to the Logs panel and the
     Game-tab banner (the existing runtime-error-surfacing path), and — decisive for the agent —
     into the play/start tool result and `game_observe`'s report (`sceneIssues: [...]` next to the
     snapshot, in `GameInputService.observe`). `game_run`'s verdict line gets prefixed with the
     issue when one exists: a PASS on a black screen must not read clean.
   - **`scene_tree`** (editor graph) appends the same `issues` array — catches it *before* play.
3. **Editor fallback lighting: flag, don't force off.** The fallback exists for humans mid-authoring
   (everything black while you block out a level is hostile), so keep it — but it must stop lying:
   - `viewport_screenshot`'s result gains `editorFallbackLighting: true` + a one-line warning
     whenever the fallback lights were on for a scene containing 3D content: *"this image is lit by
     editor-only fallback lights; the running game has no light — verify with game_observe."*
   - Note the compounding bug fork 3 fixes: misnamed lights load as `NodeBase`, so
     `activeSceneHasExplicitLights()` (ViewportRenderService ~1133) said "no lights" and kept the
     fallback on — the aliases make recognised-lights and actual-lights agree again.

Why this is the incident-killer: even with every other fork unfixed, the moment the agent starts
play mode to verify (which the doctrine already forces), `lit-material-no-light` lands in the tool
result it is reading, naming the fix.

**Cost/risk.** The lint itself is S (pure walk); wiring it into play-start, `game_observe`,
`scene_tree`, `viewport_screenshot` and the Logs path is M and touches the agent-tool result shapes
(spec updates in `AgentToolRegistry.spec.ts` / `GameInputService.spec.ts`). False positives to
guard: a deliberately all-`basic`/Sprite3D scene must not warn (the predicate keys on *lit*
materials specifically).

---

## 6. Guidance layer (minimal additions)

- **`game-prototype.md`** (the placeholders line at ~139 grows one sibling bullet): *"A 3D scene
  needs a light before any lit mesh shows up: create a `HemisphereLightNode` (+
  `DirectionalLightNode` for shading) or set the mesh's `material.type: 'basic'` (unlit). Mobile is
  the default target — prefer `lambert`/`basic` materials and keep `standard` (PBR) for when the
  user asks for a high-end look."*
- **`verify-and-fix.md`**: *"Read `sceneIssues` in scene_tree/game_observe results first — a
  `lit-material-no-light` or `inert-nodes` warning explains a black or dead scene. The editor
  viewport adds fallback lighting, so a viewport screenshot can look lit while the running game is
  black; trust the lint and game-state, not the picture."*
- **`flow-increment.md`**: *"The recipe's `projectType` is authoritative for dimensionality; if the
  brief notes the request was downgraded (e.g. a 3D ask served by a 2D recipe), say so to the user
  in your first message instead of presenting the substitute as the ask."*

**Cost/risk.** Three sentences across three files; the only risk is prompt-budget creep, which this
respects.

---

## Phased implementation order

### P0 — would have prevented the incident

| # | Item | Files (primary) | Size |
|---|---|---|---|
| P0.1 | Renderability lint + surfacing in play-start / `game_observe` / `scene_tree` / Logs; `game_run` verdict prefix | `packages/pix3-runtime/src/core/renderability-lint.ts` (new), `GameInputService.ts`, `AgentToolRegistry.ts`, play-start path | M |
| P0.2 | Light-name aliases + loader diagnostics + did-you-mean; Logs warnings on load; diagnostics in scene-writing tool results; `SceneSaver` stays canonical | `packages/pix3-runtime/src/core/SceneLoader.ts`, editor scene-load path, `AgentToolRegistry.ts` | M |
| P0.3 | Lights + Box (+Checkbox2D) into `create-node-registry.ts`; `position3` option | `src/services/agent/create-node-registry.ts`, `AgentToolRegistry.ts` tool description | S |
| P0.4 | `recipe-grid-3d` template + catalog entry with `projectType`; cross-dimensionality fallback surfaces a user-visible Flow notice | `src/templates/projects/recipe-grid-3d/` (new), `PrototypeBootstrapService.ts`, `recipes.spec.ts` | M–L |
| P0.5 | Skill one-liners (fork 6) | `src/services/agent/agent-skills/{game-prototype,verify-and-fix,flow-increment}.md` | S |

### P1 — closes the class properly

| # | Item | Files | Size |
|---|---|---|---|
| P1.1 | `material.type` (`standard`/`lambert`/`basic`) on `GeometryMesh` + `InstancedMesh3D`, schema, save/load round-trip, effect-stack compatibility | `packages/pix3-runtime/src/nodes/3D/{GeometryMesh,InstancedMesh3D}.ts`, `SceneLoader.ts`, `SceneSaver` | M |
| P1.2 | Mobile creation-time material default (`targetPlatform === 'mobile'` → lambert) in `CreateBoxCommand` and the recipe YAML; planner maps "super pretty/desktop" → `targetPlatform: 'desktop'` | `src/features/scene/CreateBoxCommand.ts`, `recipe-grid-3d` scenes, planner prompt | S |
| P1.3 | `viewport_screenshot` fallback-lighting flag + warning line | `ViewportRenderService.ts`, `AgentToolRegistry.ts` | S |
| P1.4 | Registry-vs-Create-menu drift spec with reasoned exclusion list | `src/services/agent/create-node-registry.spec.ts` | S |

### P2 — polish / future-proofing

| # | Item | Size |
|---|---|---|
| P2.1 | `yalc:publish` + DeepCore verification pass for P1.1 (confirm no material regressions in the real consumer) | S |
| P2.2 | Second 3D recipe once `recipe-grid-3d` telemetry shows what 3D asks actually look like | L |
| P2.3 | Quality settings → runtime plumbing (`maxPixelRatio`/`antialias` for exported players), if not already carried by the export path | M |
| P2.4 | Lint extension: warn on `standard` materials in a `targetPlatform: 'mobile'` project (advisory, never blocking) | S |

Ordering rationale: P0.1 is the safety net that catches *every* future variant of this failure
regardless of cause; P0.2 removes the specific silent mechanism; P0.3/P0.4 remove the reasons the
agent was pushed off the paved road; P0.5 is nearly free. The material-policy work (P1) is the
mobile-first commitment and rides on P0's rails, so it ships second without leaving the hole open.

---

## Live verification (2026-08-19, running editor + Claude Sonnet 5 via the bridge)

Driven through chrome-devtools MCP against `localhost:8123`. Every claim below was read back from
the running app, not inferred.

**The incident, re-run verbatim.** Prompt `3д паззл где нужно удалять воксели на кубе` typed into
the Flow hero with **no recipe pinned**, so the planner had to choose:

- `design/brief.md` → ``Recipe: `recipe-scene-3d` ``; manifest → `projectType: 3d`,
  `targetPlatform: mobile`, `quality: {antialias: false, shadows: false, maxPixelRatio: 2}`.
- Scene tree: `Camera3D`, `DirectionalLight`, `AmbientLight`, two `GeometryMesh` — both authored
  `material.type: lambert`.
- `sceneIssues` absent in `scene_tree` and in `game_observe` under play; zero runtime errors.
- The stage renders a **lit** cube (top face brighter than the sides — lambert doing its job), and
  the generated plan is genuinely 3D ("tap to remove individual voxels from the cube's outer
  layer", "rotate and zoom the cube freely to inspect hidden faces").

**The safety nets, forced to fire** (scratch scene in a throwaway project, deleted afterwards):

| what was done | what the editor said |
| --- | --- |
| `create_node GeometryMesh` alone | `lit-material-no-light` + `no-camera-3d`, both `blocking`, in `scene_tree` |
| the created cube on disk | `material: {type: lambert}` in a `universal` project — no `roughness`/`metalness` written |
| `create_node {nodeType: 'DirectionalLight'}` (the wrong-but-guessable name) | real light created; both issues cleared; **on disk it saved as `DirectionalLightNode`** |
| type hand-edited to `DirectionalLightSource` | `inert-nodes`: *Unknown node type "DirectionalLightSource" on node "Sun" … Did you mean "DirectionalLightNode"?* — in `scene_tree`, in `game_observe`, and as two `warn` lines in the Logs panel |
| `viewport_screenshot` on that scene | `editorFallbackLighting: true` + the warning that the running game draws these meshes black |
| cube switched to `materialType: standard` | `pbr-on-mobile` (`advice`) in `scene_tree`, and **absent from `game_observe`** — the severity split works |

**One real gap found and fixed during the run.** The welcome screen's recipe cards filtered on
`template.id.startsWith('recipe-')`, so `recipe-scene-3d` (served by the `playable-3d` template)
was invisible to a human picking a recipe — as was `recipe-playable-ad`. Templates now declare
`recipeId:` in `template.yaml`, the card list includes them, and a card pins the **recipe** id
rather than the template id (which the planner validates against the catalog). Verified live: the
cards now read Playable 3D, Playable 2D, Arena 2D, Bouncer 2D, Tapper 2D.

**Observation, not fixed.** An inert node still appears in the Scene Tree looking like any other
node — the tree gives no hint that its type is unknown. The lint says so, the tree does not.

## Left to do

1. **P2.2**, when there is telemetry to design it from.
3. **`InstancedMesh3D` has no authored material at all** — the loader never builds one, so a
   scene-authored instanced mesh always gets the shared `DEFAULT_MATERIAL` (PBR white). Out of
   scope here (it is a script/ECS-facing node), but it means the mobile material policy does not
   reach it; the lint does, because it reads the live material.
