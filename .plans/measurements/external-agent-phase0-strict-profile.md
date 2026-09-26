# Phase 0 spike: strict profile (`pix3 validate`) in plain Node

Plan: `.plans/external-agent-authoring.md`, §5 A (`validate`, levels 1 and 2) and the Phase 0 bullet
"Строгий профиль". Measured 2026-09-25 on Node 24.21, three r183, esbuild 0.27.3.

Durable artefact: `packages/pix3-runtime/src/core/scene-loader-node-profile.spec.ts`
(`// @vitest-environment node`, 44 tests, ~0.8 s of test time). It is the golden test for level 2,
and it also pins each loader behaviour listed in §3 below.

Method. There were two independent paths, and both gave the same answers:

1. **Plain Node, no vitest.** I bundled `packages/pix3-runtime/src/index.ts` with native esbuild
   (`--platform=node --format=esm`, spine external, plus a `createRequire` banner for `yaml`'s CJS
   `require('process')`). The result is 3.9 MB, built in 0.15 s, imported in 70 ms. I then ran
   probe scripts against the bundle. This is the path the CLI would actually take.
2. **vitest `node` environment.** This is the committed spec. It uses real source modules and the
   repo aliases.

## Verdict

| Question                                              | Answer                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1: load node/`core:` classes + `getPropertySchema()` | **Yes, zero DOM.** The whole runtime index imports in bare Node, all 60 exported schema classes and all 24 `core:` components answer.                                               |
| L2: `SceneLoader.parseScene` on every template scene  | **Yes, 30/30**, in `node`, with a canvas-only `document` shim (~15 lines). happy-dom is **not** needed.                                                                             |
| User scripts in Node                                  | **Yes, 32/32 classes across 8 templates**: they compile with native esbuild (3–11 ms per template), import, answer `getPropertySchema()` and construct, all with **no DOM at all**. |
| Is the plan's "schema = whitelist" model right?       | **No, not as written.** `getPropertySchema()` is the inspector's model, not the file format. See §4.                                                                                |
| Surprise                                              | The strict check found **real defects in shipped templates**. See §5.                                                                                                               |

The plan says level 2 is gated on this spike. It works in Node, so it can be on by default. The
fallback flag ("user: properties not checked") is still worth keeping, for projects whose scripts
touch browser globals at module top level.

## 1. Level 1: runtime classes and registries in Node

**Nothing in the runtime touches the DOM at module top level.** Importing the full bundle in bare
Node succeeds, and `typeof document/window/Image/AudioContext/HTMLCanvasElement/requestAnimationFrame`
are all `undefined` afterwards. `getPropertySchema()` succeeded on all 60 exports that carry it, and
none threw.

DOM access happens only at **construction or call time**. This is the complete list from grepping
`document.|window.|Image|AudioContext|requestAnimationFrame|createImageBitmap|navigator.` over
`packages/pix3-runtime/src`, spec files excluded:

| Module                                                                                                                | What it touches                                                                        | When                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes/2D/UI/Label2D.ts:234`                                                                                          | `document.createElement('canvas')` + `getContext('2d')`; throws if the context is null | **Constructor.** `UIControl2D` ends its ctor with `updateLabel()`, so every Label2D/Button2D/Slider2D/Bar2D/Checkbox2D/InventorySlot2D/Joystick2D pays it. |
| `nodes/2D/UI/UIControl2D.ts:937–940`                                                                                  | `window.devicePixelRatio` (guarded) and a canvas                                       | `createLabelTexture` (constructor path)                                                                                                                    |
| `nodes/2D/UI/InventorySlot2D.ts:114,150`                                                                              | canvas                                                                                 | constructor                                                                                                                                                |
| three `TextureLoader` (via `core/AssetLoader.ts:77,306–340`)                                                          | `URL.createObjectURL` + `document.createElementNS('img')`                              | `loadTexture` (the loader catches it and warns)                                                                                                            |
| `core/AudioService.ts:122–167`                                                                                        | `window.AudioContext` and `window.addEventListener`                                    | **constructor.** `AssetLoader`'s audio service is optional, so pass none.                                                                                  |
| `core/spine/SpineAsset.ts:152`                                                                                        | `createImageBitmap`                                                                    | only when a spine asset is loaded                                                                                                                          |
| `core/juice-transients.ts:152`                                                                                        | canvas                                                                                 | runtime (burst texture)                                                                                                                                    |
| `nodes/3D/Camera3D.ts:256`                                                                                            | `requestAnimationFrame`                                                                | `shake()` at runtime                                                                                                                                       |
| `behaviors/PinToNodeBehavior.ts:189`                                                                                  | `window.innerWidth/Height`                                                             | `onUpdate`                                                                                                                                                 |
| `core/SceneService.ts`, `CutsceneApi.ts`, `SceneRunner.ts`, `InputService.ts`, `PlayableSdk.ts`, `RuntimeRenderer.ts` | DOM overlays, rAF, listeners                                                           | play mode only                                                                                                                                             |
| `core/ProjectFontLoader.ts:87`                                                                                        | `document.fonts`                                                                       | guarded with `typeof document`                                                                                                                             |

Registries a validator can iterate. All of these are exported from `@pix3/runtime`:

- **Scene `type:` vocabulary:** `KNOWN_SCENE_NODE_TYPES` (`core/node-type-registry.ts:30`, 35 names;
  `node-type-registry.spec.ts` keeps it in sync with the loader's `case` labels). Around it:
  `resolveSceneNodeType` (it accepts case/separator variants and light aliases, so `sprite2d` loads
  as `Sprite2D`), `isKnownSceneNodeType`, `suggestSceneNodeType`, `describeUnknownNodeType`
  (`:185`), and `normalizeNodeTypeName`.
- **There is no `type → class` map.** The switch in `SceneLoader.createNodeFromDefinition` is the
  only mapping. A validator can get it three ways:
  1. index exports by name (`m[type]`). This works for 33 of 35. `Group` is a bare `NodeBase` and
     `Layout2D` is rejected.
  2. build one node per type via the public
     `SceneLoader.createNodeFromDefinition({id, type, properties: {}})`, then call
     `getNodePropertySchema(node)`. This also picks up instance schema contributions. One caveat:
     `InstancedMesh3D` needs `maxInstances`.
  3. the recipes.spec trick: scan the exports for a static `getPropertySchema` and key by
     `normalizeNodeTypeName(schema.nodeType)`.

  Watch for mismatches between the in-memory `nodeType` and the file type: lights report
  `DirectionalLight` while the file says `DirectionalLightNode`. `FloatText2D` reports `Label2D`,
  and `ParticleBurst2D` / `Trail2D` report `Node2D`, because they inherit the schema.

- **`core:` components:** call `registerBuiltInScripts(new ScriptRegistry())`
  (`behaviors/register-behaviors.ts:37`), then `registry.getAllComponentTypes()` or
  `getComponentPropertySchema(id)`. This gives 24 ids, and all of them instantiate in bare Node.
  Not every behaviour class is exported by name (the classes behind `core:Follow`, `core:FreeOnSignal` and `core:PointAttachment` are not),
  so iterate the registry, not the exports.
- `getNodePropertySchema(node)` (`fw/property-schema-utils.ts`) is the only correct way to get a
  node's full schema, because it merges in instance props.

Packaging note for the CLI: `packages/pix3-runtime/src/index.ts:154` re-exports
`{ property, state } from 'lit/decorators.js'`, but `lit` is **not** in the runtime's
`package.json`. The CLI bundle needs `lit` resolvable, or that line needs to change. It is harmless
in Node, but under Vite's dev condition it logs "Lit is in dev mode" through `console.warn`, which
the spec filters out.

## 2. Level 2: hydrating every template scene

**How `res://` resolves.** `ResourceManager.normalize` (`core/ResourceManager.ts:43–47`) turns
`res://x` into `baseUrl + x`, which is `/x` with the default base. `readText` and `readBlob` then
call the **protected** `fetchText` / `fetchBlob` (`:106–118`), which do a `fetch(url)`. In Node,
`fetch('/x')` throws `TypeError: Failed to parse URL`.

The minimal Node resolver overrides those two methods to read `<projectDir>/<url>` from disk. That is
all it takes: prefabs (`instance:`) load through `readText`.

Textures go through `AssetLoader.loadTexture` (`readBlob`, then `URL.createObjectURL`, then three's
`TextureLoader`, which needs `document`). The loader catches the failure and warns, so it never
blocks parsing. For `validate`, override `loadTexture` to check the file exists and return
`new Texture()`. That also makes "missing `res://`" an exact list instead of a warning to scrape.
Audio is not loaded at parse time (`AudioPlayer` only stores the path), and `new AssetLoader(rm)`
without an `AudioService` is legal.

**Environment matrix** (plain-Node bundle; the vitest `node` spec agrees):

| Setup                                                                | Result                                                                                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bare Node, `new AudioService()`                                      | `ReferenceError: window is not defined` (AudioService ctor). Drop it.                                                                                                  |
| bare Node, no shim                                                   | **23/30 fail** with `ReferenceError: document is not defined` at `Label2D.updateLabel ← new UIControl2D`. The 7 without UI text load, but Sprite2D textures only warn. |
| bare Node + canvas-only `document` shim                              | **30/30 OK**                                                                                                                                                           |
| + disk resolver + texture stub + template `user:` scripts registered | **30/30 OK**, with 0 pending components, 0 inert nodes, 0 missing `res://`, 0 warnings. 318 ms total for all 30.                                                       |

The shim is only `document.createElement('canvas')`, returning `{width, height, getContext('2d') → Proxy}`
where `measureText` returns `len × 10`. The runtime already ships the same idea as `installCanvas2DStub`
(`testing/canvas-2d-stub.ts`), but that one patches `HTMLCanvasElement.prototype`, so **it is a
no-op in pure Node**. It works under happy-dom, which is how `createHeadlessGame` uses it. Nothing
needed happy-dom.

Per file:

| Scene / prefab                         | Result | Nodes | Components | Note                              |
| -------------------------------------- | ------ | ----- | ---------- | --------------------------------- |
| empty-2d/scenes/main                   | OK     | 4     | 0          | Label2D: needs the shim           |
| empty-3d/scenes/main                   | OK     | 8     | 0          | no DOM needed                     |
| idea-blank/scenes/main                 | OK     | 2     | 0          | no DOM needed                     |
| minigame-2d/scenes/main                | OK     | 4     | 1          | shim                              |
| minigame-2d/scenes/menu                | OK     | 13    | 2          | shim; instances settings-window   |
| minigame-2d/scenes/ui/settings-window  | OK     | 8     | 1          | shim; **defect** (Checkbox2D w/h) |
| playable-2d/scenes/main                | OK     | 11    | 3          | shim; 2 instances                 |
| playable-2d/scenes/ui/end-screen       | OK     | 4     | 1          | shim                              |
| playable-2d/scenes/ui/intro            | OK     | 3     | 0          | shim                              |
| playable-3d/scenes/main                | OK     | 18    | 5          | shim; 2 instances                 |
| playable-3d/scenes/ui/end-screen       | OK     | 4     | 1          | shim                              |
| playable-3d/scenes/ui/intro            | OK     | 3     | 0          | shim                              |
| recipe-arena-2d/scenes/main            | OK     | 16    | 6          | shim                              |
| recipe-arena-2d/scenes/menu            | OK     | 5     | 1          | shim                              |
| recipe-arena-2d/scenes/prefabs/hazard  | OK     | 1     | 2          | no DOM needed                     |
| recipe-arena-2d/scenes/prefabs/pickup  | OK     | 1     | 2          | no DOM needed                     |
| recipe-arena-2d/scenes/ui/result       | OK     | 4     | 0          | shim                              |
| recipe-blank-2d/scenes/main            | OK     | 14    | 2          | shim                              |
| recipe-blank-2d/scenes/ui/result       | OK     | 4     | 0          | shim                              |
| recipe-bouncer-2d/scenes/main          | OK     | 38    | 5          | shim                              |
| recipe-bouncer-2d/scenes/menu          | OK     | 8     | 4          | shim                              |
| recipe-bouncer-2d/scenes/ui/result     | OK     | 4     | 0          | shim                              |
| recipe-grid-3d/scenes/main             | OK     | 13    | 3          | shim; **defect** (Bar2D colours)  |
| recipe-grid-3d/scenes/menu             | OK     | 5     | 1          | shim                              |
| recipe-grid-3d/scenes/ui/result        | OK     | 5     | 0          | shim                              |
| recipe-tapper-2d/scenes/main           | OK     | 15    | 5          | shim                              |
| recipe-tapper-2d/scenes/menu           | OK     | 5     | 1          | shim                              |
| recipe-tapper-2d/scenes/prefabs/hazard | OK     | 1     | 2          | no DOM needed                     |
| recipe-tapper-2d/scenes/prefabs/target | OK     | 1     | 2          | no DOM needed                     |
| recipe-tapper-2d/scenes/ui/result      | OK     | 4     | 0          | shim                              |

"Components" counts attached components after `user:` scripts are registered. Scenes contain
`{{PROJECT_NAME}}`, which the scaffolder substitutes. The spec substitutes it the same way before
parsing.

## 3. What the loader accepts vs. rejects (each pinned in the spec)

| Input                                                    | Loader behaviour (measured)                                                                                                                                                                                                                                                                                                                                                                  | Evidence                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| duplicate node id                                        | `SceneValidationError` (confirmed)                                                                                                                                                                                                                                                                                                                                                           | `SceneLoader.ts:363,421,532`         |
| instance cycle                                           | `SceneValidationError` (confirmed)                                                                                                                                                                                                                                                                                                                                                           | `:436–441`                           |
| prefab with 0 or >1 roots                                | `SceneValidationError`                                                                                                                                                                                                                                                                                                                                                                       | `:450–460`                           |
| **missing prefab**                                       | **Not** a `SceneValidationError`, which contradicts the plan. The resolver's own error propagates unwrapped: `ENOENT` from a disk resolver, `TypeError: Failed to parse URL` in bare Node, `HTTP 404` in the browser.                                                                                                                                                                        | `:444` → `ResourceManager.readText`  |
| malformed YAML / empty doc                               | `SceneValidationError`                                                                                                                                                                                                                                                                                                                                                                       | `:302–320`                           |
| `type: Layout2D`                                         | `SceneValidationError`                                                                                                                                                                                                                                                                                                                                                                       | `:1190`                              |
| **malformed structure**                                  | `root: {…}` gives a bare `TypeError: object is not iterable` (`:327`). The same happens for `children: {…}` or `components: {…}`. A node **without `id`** loads, with `nodeId === undefined`; two of them are a "Duplicate node id \"undefined\"". A scalar document (`hello`) or a missing `root` loads as 0 roots with no error. `properties: "abc"` is spread into `{0:'a',1:'b',2:'c'}`. | spec + probe                         |
| unknown `type:`                                          | Inert `NodeBase` (`:2108–2109`, default arm). `isInertNode` (`renderability-lint.ts:214`) is true, and `describeUnknownNodeType` suggests the nearest name. **Case and separator variants are not unknown**: `sprite2d` silently becomes `Sprite2D`.                                                                                                                                         | spec                                 |
| unknown key under `properties`                           | **Kept and re-saved.** The loader copies the whole bag (`:929`), `NodeBase` copies it again (`nodes/NodeBase.ts:112`), and `SceneSaver.serializeNodeProperties` starts from `{ ...node.properties }` (`SceneSaver.ts:259`).                                                                                                                                                                  | spec                                 |
| wrong-typed value                                        | The node field gets the **default** (for example `ColorRect2D` `width: wide` → 100, `color: 123` → `#ffffff`), but the **raw bag keeps the bad value**. For keys the saver re-derives from the live node (`width` here), a load/save round trip silently rewrites the file to the default. For keys it does not re-derive, the bad value persists.                                           | spec                                 |
| unregistered component                                   | `console.warn` + `pendingComponents`, preserved on save (confirmed). The code now sits at `component-hydration.ts:115–134`.                                                                                                                                                                                                                                                                  | spec                                 |
| component config: unknown key / wrong type               | The unknown key is kept in `config` and saved. A wrong type is handled **per component**: the schema `setValue` may ignore it, and `core:Rotate`'s `onAttach` then normalises `"fast"` to the default 1. Nothing warns.                                                                                                                                                                      | `component-hydration.ts:74–97`; spec |
| component entry without `type`                           | Loads, and is parked as pending with type `undefined`.                                                                                                                                                                                                                                                                                                                                       | probe                                |
| missing `res://` texture                                 | `console.warn("Error loading texture for Sprite2D …")`, and the node stays (confirmed).                                                                                                                                                                                                                                                                                                      | spec                                 |
| `res://` inside component config (`menuScene`, `prefab`) | Opaque strings the loader never touches. Only the component's schema can mark them, via `ui.editor: '*-resource'` / `'file-resource'`.                                                                                                                                                                                                                                                       | `fw/property-schema.ts:70–88`        |

Consequence for the plan's error list: "missing/cyclic prefab → the loader throws
`SceneValidationError`" holds for cycles but not for a missing prefab. Beyond that, structural shape
must be validated **before** `parseScene`: an object `root`, a missing `id`, a non-array
`children`/`components`, and a component without `type`. Otherwise level 2 reports a `TypeError`,
or nothing at all.

## 4. The whitelist: disk keys that are not `getPropertySchema()` names

**The plan's model needs one change.** "Unknown property = not in `getPropertySchema()`" would flag
every scene the editor saves. The schema names and the YAML keys differ systematically:

- **Structural keys, on every node that has them:**
  - `transform`: holds schema `position` / `rotation` / `scale`. 2D uses
    `transform.{position, scale, rotation}` with rotation in degrees. 3D uses
    `transform.{position, rotationEuler, scale, rotationOrder}`, and also reads `translate`,
    `rotation` and `euler` aliases (`SceneLoader.ts:2219–2242`).
  - `layout`: holds schema `layoutEnabled`, `horizontalAlign`, `verticalAlign` as
    `layout.{enabled, horizontalAlign, verticalAlign}` (`:2456`).
  - `flow`: holds schema `flowEnabled` and `flowDirection|Gap|PaddingX|PaddingY|Align|AutoSize` as
    `flow.{enabled, direction, gap, paddingX, paddingY, align, autoSize}`.
- **Flat read-compat:** `position`, `rotation` and `scale` as flat keys are schema names, so they
  pass by name. The loader reads them as a fallback when `transform` is absent.
- **Per type (canonical scene `type:`).** Each key is either saver-written or loader-read, but none
  is in that class's schema. I derived the list per class from the `case` blocks of
  `createNodeFromDefinition` and the branches of `SceneSaver.serializeNodeProperties`, and checked it
  against real schemas:

| Type             | Keys outside the schema                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| Sprite2D         | `effects`, `texturePath` (alias of `texture`), `color`                           |
| AnimatedSprite2D | `effects`                                                                        |
| TiledSprite2D    | `texturePath`, `color`                                                           |
| SpineSkeleton2D  | `texturePath`                                                                    |
| Button2D         | `effects`, `stateTextureKeys`                                                    |
| Bar2D            | `borderWidth`                                                                    |
| InventorySlot2D  | `borderWidth`, `quantityFontSize`                                                |
| Joystick2D       | `handleRadius`, `baseColor`, `handleColor`                                       |
| GeometryMesh     | `material` (holds `materialType`/`color`/`roughness`/…, plus `material.effects`) |
| InstancedMesh3D  | `material`, `frustumCulled`                                                      |
| MeshInstance     | `src`                                                                            |
| Sprite3D         | `texturePath`, `color`                                                           |
| AnimatedSprite3D | `frames`                                                                         |
| Particles3D      | `texturePath`                                                                    |

Top-level node keys are `id`, `type`, `name`, `instance`, `instancePath`, `groups`, `properties`,
`metadata`, `children`, `components` and `overrides` (`SceneNodeDefinition`, `SceneLoader.ts:81`).
Document keys are `version`, `description`, `metadata` and `root`.

This table lives in the spec as `STRUCTURAL_PROPERTY_KEYS` + `NODE_KEYS_OUTSIDE_SCHEMA`. It is
hand-kept. For the CLI I recommend a **disk-format descriptor** instead, owned by the runtime next to
`SceneSaver`: a per-type table of `{diskKey → schemaName | nested map}`. `SceneSaver` and the
validator would share it. Otherwise it drifts the way this table will. A **value-type** check
("wrong type / out of range") also needs this mapping, because the schema type of `rotation` is
`euler` in degrees while the disk value is `transform.rotationEuler: [x, y, z]`.

I also tried an alternative: tracking which keys the loader actually **reads** (a `Proxy` over the
properties bag). It needs no hand table, but it is noisy. Both the loader and `NodeBase` spread the
bag, and many keys (`initiallyVisible`, `effects`, every `PostProcess` scalar) are read later from
`node.properties` rather than during construction. It did find the two real defects, but only
behind a large false-positive list. That rules it out as a gate.

## 5. Surprise: shipped templates already contain dead keys

The golden test, run against schema + whitelist, found authored keys that nothing reads. They
"load fine" and do nothing. This is exactly the failure class `validate` exists for:

- `recipe-grid-3d/scenes/main.pix3scene#lives-bar` (Bar2D) has `fillColor` and `backgroundColor`.
  Bar2D reads `barColor` and `backBackgroundColor`, so the authored colours are ignored.
- `minigame-2d/scenes/ui/settings-window.pix3scene#music-toggle` and `#sfx-toggle` (Checkbox2D)
  have `width: 44` and `height: 44`. Checkbox2D is sized by `size`.

The spec records these as `KNOWN_TEMPLATE_DEFECTS` and asserts that the found set equals the table
in both directions. Once a template is fixed, its entry must be deleted. I did not change the
templates, because they are out of this spike's scope. The plan's promise that "all scenes of the
recipes pass `validate` without a single error" is therefore **false today**. Phase 1 has to fix
these three nodes first (a two-line fix each).

## 6. User scripts in Node

- **Static scan** of all 33 `scripts/*.ts` across 8 templates (32 Script classes + the `ball-collision.ts` helper) for
  `window|document|navigator|localStorage|Image|AudioContext|requestAnimationFrame|fetch|location|performance|…`:
  **0 top-level uses.** Every hit was a word inside a comment or string ("settings window"). The
  only import is `@pix3/runtime` (values like `Script`, `Label2D`, `registerGameDebug` and
  `playable`, plus types).
- **Actually importing them:** I bundled each template's scripts with **native esbuild**, which is
  in `node_modules/esbuild`, 0.27.3 (a Vite dependency), alongside `esbuild-wasm`. I used an entry
  of `export * as <File> from './File.ts'`, the same shape `ProjectScriptLoaderService` uses, with
  `@pix3/runtime` external and pointed at the Node runtime bundle, and imported the result in
  **bare Node with no DOM shim**. All 32 script classes imported, answered `getPropertySchema()` and
  constructed. That is 3–11 ms of compile per template. happy-dom is not needed for the recipes.
  It remains a sensible fallback for third-party scripts that touch `window` at top level.
- **How they register (`ProjectScriptLoaderService`):**
  - Only files under `scripts/` or `src/scripts/` count, recursively (`:55`). Of those, a file is
    an entry only if its text matches `/extends\s+Script\b/` (`:614–630`).
  - The entries are bundled into one module of per-file namespaces (`:356–362`).
  - Every exported value that is a function with a static `getPropertySchema` and whose prototype
    chain reaches `Script` is registered as **`user:<export name>`** (`:405`). The id comes from the
    export name, not the class's `.name` and not the file name.
- **What a light AST scan for `user:` ids should look for** (level 1, existence only):
  - files under `scripts/` or `src/scripts/` whose text matches `extends\s+Script\b`;
  - in those files, the names from `export class X`, `export { X }` and `export { X as Y }` (the
    last registers **Y**);
  - `export default class` would register as `user:default`. That is worth a warning.

  A class that extends an intermediate base from a file without `extends Script` is not an entry
  unless it is re-exported from one. So the scan and the editor agree only if the scan applies the
  same regex gate. Mirror it exactly rather than resolving inheritance properly.

## 7. Recommended design for `validate`

**Level 1 (no foreign code, no DOM, instant):**

- Load the runtime bundle.
- Parse the YAML and run a **structural shape check** first: `root` is an array, every node has a
  string `id` unique across the file and its prefabs, `children` and `components` are arrays, and
  every component has a `type`.
- Check `type:` against `KNOWN_SCENE_NODE_TYPES`. Warn on non-canonical spellings: the loader accepts
  them, but the saver will rewrite them.
- Check node property keys against schema ∪ disk descriptor, and `core:` config keys and value types
  against the registry schema.
- Check `res://` existence for `texture{url}`, `texturePath`, `audioTrack`, `src`,
  `animationResourcePath`, `skeletonPath`/`atlasPath`, and schema props with
  `ui.editor: *-resource`.
- Resolve prefabs by reading the file ourselves, which gives cycle and missing detection with good
  messages.
- Check that each `user:` id exists, using the AST scan above.

**Level 2 (real loader + compiled scripts):**

- Build a disk `ResourceManager` subclass, an `AssetLoader` with the existence-checking
  `loadTexture` and no `AudioService`, and install the canvas-only `document` shim.
- Compile `scripts/` with native esbuild and import the result. Register the classes as
  `user:<export>`, then call `parseScene`.
- Report:
  - any `SceneValidationError` or other throw;
  - `pendingComponents`, which after registration means an unknown component;
  - `isInertNode` nodes;
  - captured `console.warn`s, which become errors;
  - `user:` config keys and types against the now-available schemas.

  This is the committed spec, almost verbatim. It is realistic: 30 scenes in about 0.3 s, and it
  needs no happy-dom.

**Keep the flag** that turns off level 2, for scripts that do throw at import. When it is off, say
"user: properties not checked".

**Runtime changes worth considering** (not made here):

1. Make `Label2D`/`UIControl2D` measure lazily, or tolerate a null 2D context. The shim could then
   be deleted; the spec's first test pins the current behaviour.
2. Export the disk-format descriptor described in §4.
3. Wrap the prefab `readText` failure in `SceneValidationError`, with the instance path as detail.
4. Declare `lit` as a runtime dependency, or drop the re-export.
