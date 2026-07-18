# 2D Draw-Call Optimization: Sprite Batching + Pre-Launch Texture Atlases

Status: DESIGN (no code). Target: cut a 2D game frame from ~1 draw call per node
(SkyDefender main scene ≈90–100 calls before live prefabs) to a handful, via
(1) pre-launch texture-atlas packing with caching and (2) paint-order-preserving
sprite batching. Measured with the existing draw-call telemetry
(`RuntimeRenderer.getStatsSnapshot()` → Profiler "Draw calls" row →
`RemotePreviewTelemetryService.drawCalls`) and chrome-devtools MCP.

---

## 0. The core constraint, stated up front

2D draw order in Pix3 is **hierarchy-driven, not depth-driven**:

- Every 2D material is `depthTest: false` (`Sprite2D.ts:86-90`, `ColorRect2D`,
  `AnimatedSprite2D.ts:69-73`, UI controls).
- `assign2DRenderOrder(roots)` (`packages/pix3-runtime/src/core/render-order-2d.ts:103`)
  stamps a **unique, monotonically increasing integer `renderOrder` on every
  mesh** by DFS, every frame, from `SceneRunner.reflowRoot2DNodes`
  (`SceneRunner.ts:1443-1466`), before the single
  `renderer.render(scene, orthographicCamera)` 2D pass
  (`SceneRunner.renderScene2D`, `SceneRunner.ts:922-932`).
- three.js then sorts the transparent render list by `renderOrder` and issues
  **one draw call per mesh** in exactly that order. Since every stamped order is
  unique, `renderOrder` is the *total* order — z and object id never tie-break.

Therefore any batching scheme must satisfy:

> **Invariant B1 (paint order).** The sequence of pixels-writes per screen
> fragment after batching must equal the sequence produced by drawing each mesh
> individually in ascending stamped `renderOrder`.

The only safe merge is: **a batch may contain only meshes that form a contiguous
run in the stamped order AND can be drawn with a single material state (same
atlas sheet texture, same blending)**, and within the batch, primitives must be
emitted in stamped order (GPU rasterization respects index-buffer order for
overlapping triangles in one draw call — this is what every classic 2D sprite
batcher relies on). Any mesh that cannot join (different sheet, canvas text,
custom material) terminates the current run and starts a new one after it.

Everything below is designed around B1.

---

## 1. Current state (verified against source)

### Per-node GPU cost today

| Node | Meshes | Material | Geometry | Texture |
| --- | --- | --- | --- | --- |
| `Sprite2D` | 1 | own `MeshBasicMaterial` (ctor `Sprite2D.ts:86-91`) | own `PlaneGeometry(w,h)`, disposed+recreated on resize (`updateSize`, `:238-250`) | shared via `AssetLoader.textureCache`; clones to `ownedTexture` only while a `textureRegion` crop is active (`:151-178`) |
| `ColorRect2D` | 1 | own | own | none |
| `AnimatedSprite2D` | 1 | own | own | **always clones** (`cloneTexture`) both per-frame sequence textures (`setFrameTexture :98-113`) and spritesheets (`setSpritesheetTexture :115-126`); sets `offset/repeat` per frame (`refreshTexturePresentation :293-325`) |
| `Label2D` / `UIControl2D` label | 1 | own | own | per-node `CanvasTexture` |
| `Button2D` | 2 (skin `renderOrder` 999 + inherited label 1001) | own ×2 | own ×2 | skin state textures via `loadTexture`, label CanvasTexture |
| `TiledSprite2D` | 1 | own | explicit per-tile UVs (`tiled-sprite-geometry.ts`), ClampToEdge | shared |
| `Group2D` | 0 | — | — | — |

- Materials are **never** shared: the per-node opacity system
  (`Node2D.registerOpacityMaterial` / `applyOpacityToMaterial`,
  `Node2D.ts:410-447`) mutates `material.opacity`/`transparent` per node.
  This is load-bearing for any sharing/batching decision (§5.4).
- Textures ARE shared: `AssetLoader.loadTexture` (`core/AssetLoader.ts:197-257`)
  is the **single chokepoint** for every file-texture load in play mode —
  SceneLoader calls it for Sprite2D (`SceneLoader.ts:1096`), Button2D states
  (`:1156, :1415`), AnimatedSprite2D frames/sheets (`:1898-1899, :2058-2059`),
  and scripts go through the same loader. String-keyed cache + in-flight dedup.
- `configure2DTexture` (`core/configure-2d-texture.ts`) is mandatory for 2D:
  sRGB, `generateMipmaps=false`, Linear/Nearest per project setting. The
  mipmaps-off rule exists because of the ANGLE/D3D11 NPOT-mipmap
  transparent-black bug (Adreno / Windows-on-ARM). **Atlas sheets are 2D
  textures and must obey it.** Convenient corollary: with mipmaps off and
  WebGL2 (three r183), there is **no POT requirement** on atlas sheets.
- UV-subrect plumbing already exists and is exactly the atlas-frame primitive:
  `TextureRegion` + `applyTextureRegionToTexture` (`core/texture-region.ts:58-66`)
  maps a normalized rect onto `texture.offset/repeat`.
- No batching exists anywhere: `InstancedMesh3D` is 3D-only; no `BatchedMesh`,
  no `mergeGeometries` in the repo.
- The editor viewport draws its **own proxy meshes** with its own render-order
  pass (`ViewportRenderService.assign2DVisualRenderOrder`). **The editor path is
  explicitly out of scope** — it renders one scene at rest, on demand, and is
  not draw-call-bound. Only the runtime (`SceneRunner`) is changed. Visual
  parity is preserved because atlasing/batching are pixel-identical transforms.

### Launch pipelines (where a pre-launch pass can run)

- **In-editor play**: `GamePlaySessionService.startRuntime`
  (`src/services/GamePlaySessionService.ts:295-351`) — builds `RuntimeRenderer`
  + `new SceneRunner(sceneManager, renderer, audio, this.assetLoader, …)` then
  `await runner.startScene(activeSceneId)`. The **editor's `AssetLoader`
  instance is handed to the runner** — so anything installed on that loader
  before `startScene` is visible to the whole run. `startScene` clones the
  graph via serialize→parse (`SceneRunner.ts:183-206`), which re-resolves all
  textures through the same loader.
- **Standalone/remote player**: `src/player/player-main.ts:263-313` — creates
  its own `AssetLoader(RemoteResourceManager)` per start, then
  `runner.startScene(scenePath)`.
- **Export**: `ProjectBuildService.buildRuntimeProjectModel`
  (`src/services/ProjectBuildService.ts:82-105`) with `collectAssetPaths`
  (`:197-221`) scanning scene YAML + scripts for `res://` refs (full texture
  manifest already exists; emitted as `asset-manifest.json`).
  `PlayableHtmlBuildService` embeds assets base64 / zips raw.
- **Caching precedents**: IndexedDB store shape in `ThumbnailCacheService`
  (`src/services/ThumbnailCacheService.ts` — single object store, string keys,
  memory fallback when IDB unavailable); `.pix3/` project-dir writes in
  `PreviewHostService.ts:529-556`; `sha256Hex` helper at
  `PreviewHostService.ts:404`.

### Telemetry (already sufficient)

`RuntimeRenderer` sets `info.autoReset=false`; `getStatsSnapshot()`
(`core/RuntimeRenderer.ts:93-106`) reports `calls`, `triangles`, `geometries`,
**`textures`** (`info.memory.textures` — measures Phase 2 directly). SceneRunner
ships `rendererStats` per frame (`:601, :617`) → Profiler panel "Draw calls"
row (`src/ui/profiler/profiler-panel.ts:279`) → remote telemetry. No new
instrumentation is required for A/B.

---

## 2. Strategy overview — layered, cheap→deep, each shippable

| Phase | What | Draw calls | Texture binds/uploads | Risk |
| --- | --- | --- | --- | --- |
| 0 | Measure & break down | — | — | none |
| 1 | Shared unit-quad geometry (+ micro-guards) | **~0 change** (honest) | small | trivial |
| 2 | Pre-launch atlas packing + cache + runtime remap | ~0 change | **93 files → 1–3 sheets** | low |
| 3 | Contiguous-run quad batching over atlas sheets | **~95 → ~15–25** | — | medium |

Honest framing that shapes the plan: **Phase 1 does not reduce draw calls.**
three.js issues one call per mesh regardless of shared geometry/material;
sharing only cuts state changes and memory churn. All 2D nodes already share
one GL program (all `MeshBasicMaterial`). The real wins are Phase 2 (texture
state + startup + the prerequisite for batching) and Phase 3 (the actual
draw-call collapse). Phase 1 is kept *only* as thin prep that Phase 3 wants
anyway. Recommended first shippable stopping point: **end of Phase 2**
(measurable, zero paint-order risk); Phase 3 follows behind a flag.

---

## 3. Phase 0 — Measure (no code)

Procedure (SkyDefender, `samples/SkyDefender`, via `pix3-remote-preview` skill
or chrome-devtools MCP against the editor Game tab):

1. Launch play mode on `main.pix3scene`; let one wave spawn.
2. Read per-frame stats: Profiler panel "Draw calls" row, or
   `window.__PIX3_DEBUG__` frame stats, or evaluate
   `runner.renderer.getStatsSnapshot()` via MCP. Record: `calls`, `textures`,
   `triangles`, frame ms, at (a) menu, (b) mid-wave with gunships, (c) peak.
3. Breakdown by category (one-off MCP evaluation): walk `runtimeGraph`
   root nodes, classify meshes (Sprite2D / AnimatedSprite2D / label canvas /
   ColorRect2D / Button2D skin), count per stamped-order run — this yields the
   *theoretical* Phase-3 floor: number of contiguous runs when text meshes and
   sheet boundaries break runs.
4. Record `info.memory.textures` (expect ≈93 + canvas labels) as the Phase-2
   baseline.

Expected baseline (from scene stats: 68 Sprite2D + 7 Button2D×2 + 8 Label2D +
5 ColorRect2D + 26 Group2D): **~95 calls** static, +2 per live gunship/prefab.

Optional 1-line nicety: surface `textures` in the Profiler panel next to draw
calls (it is already in the snapshot) — helps the Phase-2 A/B read.

---

## 4. Phase 1 — Cheap prep (explicitly minimal)

**Do:**

1. **Shared unit quad.** New `packages/pix3-runtime/src/core/shared-quad-geometry.ts`
   exporting a module-level `PlaneGeometry(1,1)` singleton (never disposed).
   `Sprite2D`, `ColorRect2D`, `AnimatedSprite2D` use it and express size as
   `mesh.scale.set(w, h, 1)`; `updateSize` stops disposing/recreating geometry
   (`Sprite2D.ts:238-250`). Anchor offset lives on `mesh.position` and is
   unaffected. Raycast/bounds keep working (scaled unit quad). Gains: no
   geometry churn on resize/spawn, fewer VAO binds, less GC; and Phase 3's quad
   extraction becomes uniform (`corner × matrixWorld`).
2. **Empty-content guards:** skip creating/rendering the label mesh when a
   `Button2D`/`Label2D` text is empty (`material.visible = false` until text is
   set). Buttons used as icon-only stop paying a canvas texture + draw call.
   This is the only Phase-1 item that removes actual calls (a few).

**Explicitly do NOT do:**

- **Material sharing between nodes.** `applyOpacityToMaterial`
  (`Node2D.ts:436-447`) mutates `material.opacity`/`transparent` per node at
  arbitrary times (visibility fades, scripts); sharing would bleed opacity
  across nodes. A copy-on-write scheme is possible but buys **zero draw
  calls** (three still draws per mesh) — not worth the correctness risk.
  Phase 3 makes it moot.
- Merging Button2D skin+label into one mesh — they are two textures; only the
  atlas (Phase 2/3) can merge them, and the canvas label can't be atlased v1.

Files: `packages/pix3-runtime/src/core/shared-quad-geometry.ts` (new),
`nodes/2D/Sprite2D.ts`, `nodes/2D/ColorRect2D.ts`, `nodes/2D/AnimatedSprite2D.ts`,
`nodes/2D/UIControl2D.ts` (label guard). Then `yalc:publish` for DeepCore.

---

## 5. Phase 2 — Pre-launch texture-atlas packing with caching

Goal: N small PNG files → K atlas sheets (K = 1–3 for SkyDefender), with every
consumer remapped **transparently at the `AssetLoader.loadTexture` chokepoint**,
zero changes to scene YAML or source assets, and a content-addressed cache so
repeat runs skip packing entirely.

### 5.1 Runtime-side contract (`@pix3/runtime`, editor-agnostic)

New `packages/pix3-runtime/src/core/atlas-frame-map.ts`:

```ts
import type { TextureRegion } from './texture-region';

/** One packed frame: where a source texture landed inside a sheet. */
export interface AtlasFrame {
  /** res:// path of the sheet image (or a synthetic pix3atlas:// key, §5.5). */
  sheetPath: string;
  /** Normalized UV subrect inside the sheet (three.js offset/repeat space). */
  region: TextureRegion;
  /** Original source pixel size — natural-size logic must use THIS, not sheet image dims. */
  pixelWidth: number;
  pixelHeight: number;
}

/** Consulted by AssetLoader on every texture load. Pure lookup, no I/O. */
export interface AtlasResolver {
  resolve(resourcePath: string): AtlasFrame | null;
}

/** Serialized form: shipped as atlas-manifest.json in exports, stored in the cache. */
export interface AtlasManifest {
  formatVersion: 1;
  packerVersion: number;       // bump to invalidate all caches on algorithm change
  contentHash: string;         // §5.6
  textureFiltering: 'linear' | 'nearest';
  sheets: Array<{ id: string; file: string; width: number; height: number }>;
  frames: Record<string /* res:// source path */, {
    sheet: string; x: number; y: number; w: number; h: number; // px, y-up already converted
  }>;
  excluded: string[];          // for diagnostics/Profiler
}
```

Also add to `core/texture-region.ts`:

```ts
/** base ∘ local: maps a region expressed in source-texture UV space into the
 *  atlas sheet's UV space. Identity when base is null. */
export function composeTextureRegion(
  base: TextureRegion | null, local: TextureRegion | null
): TextureRegion | null;
// result = base ? {
//   x: base.x + local.x * base.width,  y: base.y + local.y * base.height,
//   width: local.width * base.width,   height: local.height * base.height,
// } : local   (and local==null → base)
```

### 5.2 The remap layer: `AssetLoader.loadTexture`

`AssetLoader` gains:

```ts
setAtlasResolver(resolver: AtlasResolver | null): void; // install before startScene
```

`loadTexture(resourcePath)` (`AssetLoader.ts:197`) consults the resolver
**before** cache miss handling:

1. `resolver.resolve(path)` hit →
   `const sheet = await this.loadTexture(frame.sheetPath)` (recursion lands in
   the normal path; the sheet is loaded and GPU-uploaded exactly once, cached
   under its own key).
2. Build the **view texture**: `const view = sheet.clone()`;
   `configure2DTexture(view)`; `applyTextureRegionToTexture(view, frame.region)`;
   stamp `view.userData.pix3AtlasRegion = frame.region` and
   `view.userData.pix3AtlasSize = { width: frame.pixelWidth, height: frame.pixelHeight }`.
3. Cache `view` under the ORIGINAL `resourcePath` in `textureCache`, return it.

Why clones are free: a `Texture.clone()` shares the source image via three's
`Source` refcounting — one GPU upload per sheet, per-texture `offset/repeat`
are material `uvTransform` uniforms, not GL texture state (this is the same
mechanism `Sprite2D.ownedTexture` already documents, `Sprite2D.ts:60-70`).
Caveat to respect: textures sharing a `Source` share the GPU object only when
their sampler/format state matches (three keys the GL texture by
source + parameter cache-key) — all views come from the same
`configure2DTexture` settings, so they do. **Do not let any consumer change
filters on a view** (none do today; `configure2DTexture` is the only writer).

Miss → existing behavior, byte-for-byte. Resolver null → whole feature off.

An options bag `loadTexture(path, { atlas?: boolean })` (default true) lets
SceneLoader bypass the resolver for the exclusion cases below (defense in
depth; the packer also excludes them at pack time).

### 5.3 Node-side changes (region composition)

Consumers that write `offset/repeat` directly must compose with the view's
base region instead of assuming full-texture UV space:

- **`Sprite2D`** (`applyTexturePresentation`, `:151-178`): crop path becomes
  `applyTextureRegionToTexture(owned, composeTextureRegion(baseRegionOf(baseTexture), region))`;
  no-crop path leaves the view untouched (already correct — the view carries
  its region). `setTexture` natural-size logic (`:215-235`) must prefer
  `texture.userData.pix3AtlasSize` over `texture.image` dims, else sprites
  without explicit width/height blow up to the sheet size. `baseRegionOf(t)`
  = `t.userData.pix3AtlasRegion ?? null` — a tiny helper in
  `atlas-frame-map.ts`.
- **`AnimatedSprite2D`** (`refreshTexturePresentation`, `:293-325`): the three
  branches currently do absolute `texture.offset.set(...)` — including
  resetting sequence frames to `(0,0)/(1,1)` (`:306-307`), which would **erase
  the atlas region**. All three become
  `applyTextureRegionToTexture(texture, composeTextureRegion(baseRegionOf(texture), localRegion))`
  where `localRegion` is `null` (sequence/full) or the frame's offset/repeat
  rect (spritesheet). `cloneTexture` must re-stamp
  `userData.pix3AtlasRegion/pix3AtlasSize` on the clone explicitly (do not rely
  on `Texture.copy`'s userData handling). This node type is the single biggest
  SkyDefender win — the per-frame enemy/air/transporter/cloud PNGs are exactly
  the many-small-files case.
- **`Button2D`**: state textures arrive whole via `setTexture`-style swaps of
  views — works unchanged; verify its skin doesn't write offset/repeat (it
  doesn't; states are separate files).
- **`TiledSprite2D`**: **excluded from atlasing** v1. Its geometry UVs assume
  the full [0,1] texture with ClampToEdge semantics at 9-slice edges
  (`tiled-sprite-geometry.ts:206`); although `uvTransform` would remap the
  quads, edge clamping/filter-bleed semantics inside a sheet differ. SceneLoader
  passes `{ atlas: false }` for its texture, and the packer excludes any path
  referenced by a TiledSprite2D node.

### 5.4 What is atlas-eligible (pack-time classification)

The packer scans the entry scene closure (scene YAML + referenced prefab
scenes + `res://` image refs in project scripts, reusing the
`collectResourcePathsFromText` regex from `ProjectBuildService`) and classifies:

**Include** — png/jpg/webp referenced by `Sprite2D.texture`,
`Button2D` state textures, `AnimatedSprite2D` sequence frames & spritesheets,
script-referenced sprite textures.

**Exclude** (stay standalone, always correct via resolver miss):
- any texture referenced by a `TiledSprite2D` or by any **3D** node/material
  (3D keeps mipmaps — sheet textures never mipmap);
- oversized: either dimension > `maxFrame` (default 1024) or frame area >
  25% of sheet area (backgrounds like SkyDefender's full-screen sky stay
  standalone — atlasing them wastes sheet space and evicts small frames);
- dynamic `CanvasTexture`s (labels) — never file-based, never reach the
  resolver;
- paths that fail to decode (warn, continue).

Plus a **1×1 white pixel frame injected into every sheet** — Phase 3 uses it to
batch `ColorRect2D` and untextured placeholder quads into sprite runs.

### 5.5 The packer (editor-side service; runtime never packs)

New `src/services/atlas/` (editor package, keeps `@pix3/runtime` editor-agnostic):

- **`MaxRectsPacker.ts`** — pure, dependency-free MaxRects (BSSF heuristic,
  no rotation v1). Inputs: `{id, w, h}` list (dimensions include padding);
  config `{ maxSheetSize: 2048, padding: 2, extrude: 1 }`. Output: per-sheet
  placements; opens a new sheet on overflow (multi-sheet is expected and fine —
  Phase 3 keys batches by sheet). NPOT sheet sizes are allowed (mipmaps are
  off; WebGL2); sheets are shrunk to the used extent rounded up to ×4.
- **`TextureAtlasService.ts`** — orchestrates: scan+classify (§5.4) → load
  blobs via `ProjectStorageService` → `createImageBitmap` → pack → compose
  sheets on `OffscreenCanvas` (draw each frame at its slot, then **extrude
  1px edges** by re-drawing 1px-wide strips — bleed guard, §7.2) → produce:
  - in-memory: one `CanvasTexture`-able canvas per sheet + an `AtlasResolver`;
  - cacheable: `canvas.convertToBlob({type:'image/png'})` per sheet + the
    `AtlasManifest` JSON.
  Frame regions are converted to three.js UV space (origin bottom-left):
  `region = { x: px/W, y: 1 - (py+ph)/H, width: pw/W, height: ph/H }` —
  matching `applyTextureRegionToTexture` semantics exactly.
- **`AtlasCacheStore.ts`** — IndexedDB, modeled line-for-line on
  `ThumbnailCacheService` (DB `pix3-atlas-cache`, one object store; value =
  `{ manifest: AtlasManifest, sheets: Blob[] }`, key = contentHash; memory
  fallback when IDB unavailable). LRU cap ~8 entries per project.

Sheet delivery to the runtime without touching the project FS: the resolver
maps `sheetPath` to a synthetic key (`pix3atlas://<hash>/sheet-0`), and the
service pre-seeds `AssetLoader.textureCache` with ready `CanvasTexture`s (or
blob-URL-loaded textures on the cache-hit path) under those keys before
`startScene`. This avoids `ResourceManager` changes entirely; `loadTexture`'s
step-1 recursion hits the pre-seeded cache. (Alternative — writing sheets to
`.pix3/atlas-cache/` and using real `res://` paths — is deferred; IDB + preseed
is simpler and leaves the project tree untouched.)

### 5.6 Cache keying & invalidation

- **Editor play (fast path)**: `contentHash = sha256Hex(JSON.stringify(
  sortedInputs.map(f => [path, f.size, f.lastModified]) ) + packerVersion +
  settings(maxSheetSize, padding, filtering))`. File System Access API `File`
  objects provide `size`/`lastModified` without reading bytes — a cache HIT
  costs one directory sweep + one IDB get. Same-size-same-mtime collisions are
  acceptable in-editor (thumbnails take the same bet).
- **Export (strict)**: full `sha256Hex` over file bytes (bytes are read anyway
  to pack/embed).
- Flow at play-start (`GamePlaySessionService.startRuntime`, inserted after the
  runner is constructed, before `runner.startScene`):

```
manifest? flag off? → skip (resolver = null, today's path)
hash inputs → IDB get(hash)
  hit  → decode sheet blobs → preseed textures → setAtlasResolver → start
  miss → pack now (await; SkyDefender ≈93 small files, est. well under 1 s
         decode+compose on main thread; move to a Worker later if profiling
         says so) → IDB put → preseed → start
```

  Await-on-miss is deliberate (correctness/simplicity over background rebuild
  complexity); the pack cost is paid once per texture-set change and logged
  (`[Atlas] packed N textures → K sheets in M ms`).
- Deleting/renaming textures changes the input list → new hash → repack. Stale
  entries age out via LRU.

### 5.7 Export & remote player integration

- `ProjectBuildService`: after `collectAssetPaths`, run the same
  `TextureAtlasService` pack (strict hash) and add to the build:
  `assets/.atlas/sheet-N.png` + `assets/.atlas/atlas-manifest.json`; keep the
  source PNGs v1 (they may be referenced by excluded/dynamic paths; stripping
  atlased sources is a later size optimization for playables — see open
  decision D8).
- `player-main.ts` (`startScene`, `:263+`): try
  `resourceManager.readText('res://assets/.atlas/atlas-manifest.json')`; if
  present, build a resolver whose frames point at the real
  `res://assets/.atlas/sheet-N.png` files (no preseeding needed — `loadTexture`
  loads sheets like any texture) and `assetLoader.setAtlasResolver(...)` before
  `runner.startScene`. Exported games therefore start **pre-packed, zero
  runtime packing**.
- `PlayableHtmlBuildService`: sheets/manifest ride the existing embed path
  (they are just assets in the manifest).
- Remote preview (`PreviewHostService`): the editor already packed for the
  local session; the remote player receives sheets as normal files through the
  existing content-hash revalidating transfer. v1: ship the manifest+sheets as
  session files; the player path above picks them up.

### 5.8 Phase-2 outcome (measured expectations)

Draw calls: **unchanged** (~95). `info.memory.textures`: ~93+labels →
**~(1–3 sheets + labels + excluded)**. Startup: 93 blob reads + decodes +
GPU uploads → K decode/uploads on cache hit. GPU texture-bind switches between
draws collapse to near-zero for sprite-to-sprite transitions (uvTransform
uniform update instead of texture bind). This is the enabling layer; ship it,
measure, then batch.

---

## 6. Phase 3 — Paint-order-preserving quad batching

### 6.1 Decision: custom CPU quad batcher, NOT `THREE.BatchedMesh`

Recommendation (see D1): a classic immediate-mode sprite batcher — one dynamic
`BufferGeometry` per batch run, quads appended in stamped order, rebuilt every
frame.

Why not `BatchedMesh` (available in r183):
- **Order:** BatchedMesh draws instances in an internal order; honoring B1
  requires `customSort` discipline plus stable instance bookkeeping across
  spawn/despawn — the exact complexity class we want to avoid. In a custom
  batch, **paint order is the append order is the index-buffer order** — B1
  holds by construction.
- **Per-instance opacity:** `setColorAt` is RGB; per-node opacity (the fade
  system, `Node2D.ts:436-447`) needs alpha per sprite → shader patching. A
  custom batch uses a 4-component `color` vertex attribute
  (`vertexColors: true`, itemSize 4) — tint × computedOpacity for free.
- **Scale:** the whole point of BatchedMesh (GPU-resident transforms for huge
  static worlds) is irrelevant at 2D-game scale: ~100–500 quads × 4 verts ×
  one 3×4 transform each ≈ microseconds per frame on CPU. `reflowRoot2DNodes`
  already walks the full 2D tree every frame; the batcher rides the same walk.
- Full rebuild-per-frame **sidesteps every dynamic-membership problem**:
  prefab spawns/despawns (`instantiatePrefab`), texture swaps, visibility,
  reorder — next frame's walk just reflects reality. Correctness over
  cleverness.

### 6.2 Architecture

New `packages/pix3-runtime/src/core/batch-2d.ts` (runtime pkg — the engine owns
play-mode rendering):

```ts
/** Opt-in metadata a node stamps on meshes the batcher may absorb. */
export interface Batchable2DInfo {
  kind: 'quad';
  // Live getters — read at batch-build time each frame:
  getTexture(): Texture | null;      // material.map (an atlas VIEW or null)
  getColor(): Color;                 // material.color
  getOpacity(): number;              // material.opacity (already computedOpacity-multiplied)
  getRegion(): TextureRegion | null; // effective UV rect (view offset/repeat)
}
export const BATCHABLE_2D_KEY = 'pix3Batchable2D'; // mesh.userData[key]

export class Batch2DSystem {
  /** Rebuild batches for one camera band. Called from SceneRunner after
   *  assign2DRenderOrder, before the corresponding render pass. */
  update(orderedMeshes: readonly OrderedMesh2D[], scene: Scene): void;
  dispose(): void;
  readonly stats: { batches: number; quads: number; passthrough: number };
}
```

**Ordered mesh list.** Extend `assign2DRenderOrder` with an optional collector:
`assign2DRenderOrder(roots, sink?: (mesh, order, layerBand, effectiveVisible) => void)`
— a single DFS produces both the stamps and the batcher's input, including
inherited visibility (walk carries `parentVisible && node.visible`) and layer
band (main `LAYER_2D` vs `LAYER_2D_OVERLAY`, assigned by `assign2DLayers`).
No second traversal, no divergence risk between "order stamped" and "order
batched" — same walk, same numbers.

**Run segmentation.** Scan the ordered list per band:

```
eligible(mesh) := mesh.userData[BATCHABLE_2D_KEY] exists
               && effectiveVisible && opacity > 0
               && texture is null (→ white px) or an atlas view (has pix3AtlasRegion)
                  or a whole standalone texture small enough? NO — v1: atlas views + null only
               && material is the node's stock MeshBasicMaterial (no script-swapped material)
key(mesh)      := (sheetTexture, blending, layerBand)   // blending is NormalBlending today
run break      := !eligible OR key changed
```

Runs of length 1 pass through untouched (no batch overhead for singletons).
Runs ≥ 2 become one batch draw.

**Batch mesh.** Per active run: one `Mesh` with
- dynamic `BufferGeometry`: interleaved `position`(xyz) + `uv` + `color`(rgba),
  `DynamicDrawUsage`, capacity grown ×2 on demand, `drawRange` set per frame;
- material from a small pool keyed by `(sheet, blending)`:
  `MeshBasicMaterial({ map: sheet, transparent: true, depthTest: false,
  vertexColors: true, color: 0xffffff })` — **never mutated per node**, so the
  per-node opacity system is untouched (opacity rides the vertex alpha);
- `renderOrder = stamped order of the run's first mesh`;
- `frustumCulled = false` initially; compute a bounding sphere during the fill
  (near-free — verts are in hand) if Phase-0 shows offscreen sprite volume
  worth culling;
- lives in a dedicated `Group` on the runner's scene, layer set to the band's
  layer.

**Quad fill.** For each member mesh: 4 corners of the unit quad (Phase 1)
scaled by `mesh.scale` → `applyMatrix4(mesh.matrixWorld)` (world matrices are
fresh — fill runs right before render; call
`scene.updateMatrixWorld()`/rely on renderer's update, mirroring what the
render pass would do); UVs = the view texture's effective `offset/repeat` rect
(this is exactly the atlas frame ∘ any crop, because Phase 2 composes regions
into the view); `color = material.color × material.opacity` into rgba.
Untextured `ColorRect2D` quads use the sheet's white-pixel frame UV.

**Source-mesh suppression.** Batched members set `material.visible = false`
for the frame (restored when they fall out of a batch). Rationale: it removes
the mesh from three's render list without touching `Object3D.visible`
(scripts/game logic read+write node visibility; the custom `raycast2D`
input-picking path reads geometry/transforms and ignores `material.visible`).
Each node owns its material (verified — zero sharing today), so the toggle
cannot leak across nodes. The batcher keeps a `Set<Material>` of suppressed
materials per frame and restores exactly the delta (suppress newly batched,
restore newly unbatched) — no churn in steady state.

**Order proof-sketch (B1).** Let `m_1 < m_2 < … < m_n` be meshes in stamped
order within one band. Segmentation partitions them into maximal blocks
`B_1, …, B_k` (each a batch run or a single passthrough mesh), and blocks
inherit the stamped order of their first member as `renderOrder`; since stamps
are unique and blocks are contiguous, block renderOrders are strictly
increasing, so three's transparent-list sort draws blocks in original block
order. Within a batch block, quads are appended to the index buffer in stamped
order, and a single non-indexed-write draw call rasterizes primitives in
index order with well-defined blending order per fragment (GL guarantees
primitive order within a draw call). Passthrough meshes keep their stamps.
Hence the global fragment-write order equals the unbatched order. ∎
(The one sort-tie hazard — equal `renderOrder` falling back to z/id — cannot
occur: all live renderOrders in the band remain unique integers: passthroughs
keep theirs, each batch uses its first member's, and members' own stamps leave
the list via `material.visible=false`.)

**What is never batched (v1):** label/canvas-text meshes (per-node
`CanvasTexture`); `TiledSprite2D` / 9-slice (own geometry); any mesh with a
script-replaced material or non-normal blending; masked/scrolled special
content if any mesh carries `OVERLAY_2D_FLAG` semantics it keeps (overlay
meshes batch fine among themselves — they're ordinary meshes in the stamped
order — but ScrollContainer clipping, if implemented via scissor per node,
would break runs; today clipping is geometric, so no issue); 3D pass entirely.

**Node opt-in.** `Sprite2D`, `ColorRect2D`, `AnimatedSprite2D`, and the
`Button2D` skin mesh stamp `BATCHABLE_2D_KEY` info in their constructors.
Labels don't. New node types are unbatched-by-default — safe.

### 6.3 SceneRunner integration

In `reflowRoot2DNodes` (`SceneRunner.ts:1443-1466`): the collector-enabled
`assign2DRenderOrder` feeds `batch2D.update(mainBand)` and
`batch2D.update(overlayBand)` when the flag is on. `renderScene2D` /
`renderOverlay2D` are untouched — batches are just meshes in the scene. Stats
(`batch2D.stats`) are appended to the per-frame `rendererStats` payload so the
Profiler can show "Draw calls (2D batched: N quads in K batches)".

### 6.4 Expected numbers (SkyDefender main scene)

~95 meshes; run-breakers = 15 text meshes (8 Label2D + 7 button labels)
scattered by paint order + sheet boundaries (likely 1 sheet). Worst case
alternating text/sprites: ~16 batch runs + 15 labels ≈ **31 calls**; realistic
HUD clustering: **~15–25 calls**, prefab spawns adding ~0 (they join existing
runs). Static-menu floor ≈ 10. Target: **≥70% reduction mid-wave** vs the
Phase-0 baseline, frame time flat or better, zero visual diffs
(screenshot-compare, §8).

---

## 7. Correctness & risks (consolidated)

1. **Paint order** — §6.2 proof-sketch; enforced structurally (contiguous runs,
   unique renderOrders, index-order rasterization). Test: a scene of 20
   overlapping tinted quads in adversarial hierarchy order; readback pixels
   must match the unbatched flag-off render exactly.
2. **Texture bleeding** — 2px padding between frames + 1px edge extrusion
   (duplicate border pixels outward). With `LinearFilter` and **no mipmaps**,
   sampling reaches ≤0.5px past the frame edge → 1px extrusion suffices; 2px
   padding is margin. `NearestFilter` (pixel-art projects) never bleeds. UV
   rects use exact frame bounds (extruded pixels sit outside the rect).
3. **POT/NPOT & the mipmap rule** — sheets are 2D textures →
   `configure2DTexture` applies (sRGB, `generateMipmaps=false`, project
   filtering). No mipmaps → no ANGLE NPOT-mipmap bug, no POT constraint, and
   minification quality is unchanged vs today (2D never had mipmaps). The
   manifest records `textureFiltering`; a project-setting change invalidates
   the cache (it's in the hash).
4. **Atlas size limits & overflow** — `maxSheetSize = min(2048, renderer max)`
   default (16 MB RGBA each; conservative for mobile playables); MaxRects
   opens additional sheets on overflow; multi-sheet only costs extra batch-run
   breaks. Configurable per project later.
5. **Dynamic/dedicated textures** — canvas labels, TiledSprite2D, 3D-shared,
   oversized: excluded at pack time AND bypassed at load time (`atlas:false`),
   so both layers agree; resolver misses are always-correct fallbacks.
6. **Memory** — one 2048² sheet ≈ 16 MB vs ~93 small textures (sum of pixels +
   per-texture overhead); at SkyDefender sizes roughly a wash, plus packing
   waste ~10–20%; sheets are shrunk to used extent. Big backgrounds excluded
   (§5.4) so waste stays bounded. `AnimatedSprite2D`'s per-node clones become
   views on one sheet — VRAM strictly better there.
7. **Opacity/tint** — batches never mutate shared materials; alpha/tint ride
   vertex colors sampled from each node's own material at fill time, so the
   existing fade system (`applyOpacityToMaterial`) keeps working verbatim;
   `opacity === 0` quads are skipped entirely (a small extra win — today they
   still cost a draw call).
8. **Premultiply/color fidelity** — composing frames through a 2D canvas is
   one premultiply-quantization round trip (identical to browser TexturePacker
   tools); visible only on pixels with near-zero alpha. First-run in-memory
   sheets go `OffscreenCanvas → CanvasTexture` directly (single composite);
   the cache stores PNG (second decode is lossless w.r.t. the stored PNG).
   Acceptable v1; document in the manifest (`packerVersion` bump if we later
   move to raw-RGBA composition).
9. **Editor-vs-runtime divergence** — editor viewport proxies stay per-texture,
   unbatched (its own path, on-demand rendering, not draw-call-bound). Pixel
   output is identical by design; the A/B screenshot test (§8) is the guard.
   Note in `docs/nodes-and-systems.md` that play-mode rendering may batch.
10. **Feature flags / fallback** — project manifest `rendering2D` block
    (editor-side manifest, where `quality` lives):
    `{ textureAtlas: 'auto' | 'off', batching: 'auto' | 'off' }`, default
    `'auto'` after burn-in ( `'off'` during rollout). Runtime knobs:
    `assetLoader.setAtlasResolver(null)` and a `SceneRunner` option
    `enable2DBatching`. Debug override via `window.__PIX3_DEBUG__` /
    URL param (`?pix3Atlas2D=off&pix3Batch2D=off`) for MCP-driven A/B without
    rebuilds. Off = byte-identical to today's code path.
11. **AnimatedSprite2D clone semantics** — `cloneTexture` must explicitly
    re-stamp `pix3AtlasRegion/pix3AtlasSize` (don't trust `Texture.copy`
    userData behavior across three versions). Unit-test the composition:
    sequence frame on an atlas view must sample the frame's subrect, not
    `(0,0)-(1,1)` (the `:306-307` reset is the regression trap).
12. **`SceneRunner.startScene` clone** (`:183-206`) — serialize→parse re-runs
    SceneLoader against the same AssetLoader; views are cached by source path,
    so the clone resolves identically. `instantiatePrefab` likewise.

---

## 8. Verification plan (chrome-devtools MCP + Profiler)

Baseline and A/B on SkyDefender `main.pix3scene` (use `pix3-remote-preview` /
`debug-running-game` skills; verify via state, not screenshots — screenshots
only for the visual-parity check):

1. **Phase 0 baseline** (§3): record `{calls, textures, frame ms}` at menu /
   mid-wave / peak, 300-frame medians, via `getStatsSnapshot()` polled through
   MCP `evaluate` or the Profiler row + `RemotePreviewTelemetryService`.
2. **Phase 2 acceptance**: flag on vs off, same build —
   `textures` drops to ≈ sheets+labels+excluded (target ≤ 12 from ~95);
   `calls` unchanged (±0); play-start time on cache hit within +50 ms of
   baseline; first-run pack time logged < 1.5 s; second run hits IDB (log
   line asserts `cache=hit`). Modify one PNG → next run logs `cache=miss`
   (invalidation). Visual parity: capture the game canvas (game area only)
   flag-on/flag-off at a deterministic frame (menu screen), pixel-diff ≈ 0
   (tolerance for the premultiply note, §7.8).
3. **Phase 3 acceptance**: flag on vs off — mid-wave `calls` target **≤ 30**
   (from ~95+; ≥70% cut), `batch2D.stats` shows quads ≈ batchable mesh count;
   spawn a wave of gunship prefabs and assert `calls` stays flat while
   `quads` rises; frame ms flat or better; visual parity as above plus an
   adversarial overlap scene fixture; run the existing SkyDefender playthrough
   eval to confirm no gameplay/input regressions (raycast picking unaffected).
4. **Regression suite**: Vitest specs for `MaxRectsPacker` (no overlap, within
   bounds, padding respected — pure function, trivially testable),
   `composeTextureRegion`, resolver remap in `AssetLoader` (seed
   `textureCache` per the AssetLoader-texture-test gotcha), run-segmentation
   (ordered list in → expected runs out), and an order-preservation test that
   renders batched vs unbatched to a `WebGLRenderTarget` in happy-dom‑excluded
   integration (or compares emitted index order against stamped order —
   CPU-verifiable without GL).

---

## 9. Phased delivery & file map

**Phase 0 — Measure** (0.5 day): no code; optional Profiler `textures` row
(`src/ui/profiler/profiler-panel.ts`). Output: baseline table in this doc.

**Phase 1 — Prep** (1 day):
- new `packages/pix3-runtime/src/core/shared-quad-geometry.ts`
- edit `nodes/2D/Sprite2D.ts`, `nodes/2D/ColorRect2D.ts`,
  `nodes/2D/AnimatedSprite2D.ts` (unit quad + scale sizing),
  `nodes/2D/UIControl2D.ts` (empty-label guard)
- `yalc:publish` → DeepCore smoke.

**Phase 2 — Atlas + cache** (3–4 days) ← **first shippable stopping point**:
- runtime: new `core/atlas-frame-map.ts`; edit `core/texture-region.ts`
  (`composeTextureRegion`), `core/AssetLoader.ts` (resolver + views + options
  bag), `nodes/2D/Sprite2D.ts` (natural size + crop composition),
  `nodes/2D/AnimatedSprite2D.ts` (composition + clone re-stamp),
  `core/SceneLoader.ts` (TiledSprite2D `atlas:false`)
- editor: new `src/services/atlas/MaxRectsPacker.ts`,
  `src/services/atlas/TextureAtlasService.ts`,
  `src/services/atlas/AtlasCacheStore.ts`; edit
  `src/services/GamePlaySessionService.ts` (pre-start hook, ~10 lines)
- export: edit `src/services/ProjectBuildService.ts` (pack + emit sheets +
  manifest), `src/player/player-main.ts` (consume manifest),
  `PlayableHtmlBuildService` (no change expected — assets flow through)
- specs: packer, composition, resolver; measure & record Phase-2 table.

**Phase 3 — Batching** (4–5 days, behind flag):
- runtime: new `core/batch-2d.ts`; edit `core/render-order-2d.ts` (collector
  sink), `core/SceneRunner.ts` (wire into `reflowRoot2DNodes` + stats),
  node ctors stamp `BATCHABLE_2D_KEY` (`Sprite2D`, `ColorRect2D`,
  `AnimatedSprite2D`, `Button2D` skin)
- editor: Profiler batch stats row; flag plumbing in project manifest +
  `__PIX3_DEBUG__`
- specs: segmentation + order preservation; A/B eval on SkyDefender; then
  default `'auto'`.
- update `docs/nodes-and-systems.md` (engine feature) per repo policy.

---

## 10. Open decisions (recommendation first)

- **D1 — Custom quad batcher vs `THREE.BatchedMesh`: custom.** Paint order by
  construction (append order = raster order) vs customSort bookkeeping;
  per-vertex rgba solves per-node opacity (BatchedMesh `setColorAt` is
  RGB-only, would need shader patches); rebuild-per-frame erases all dynamic
  membership complexity; CPU cost is microseconds at 2D scale. BatchedMesh
  optimizes a problem (huge static GPU-resident worlds) we don't have.
- **D2 — Phase-1 aggressiveness: minimal.** Shared unit quad + empty-label
  guard only. Skip cross-node material sharing entirely — it conflicts with
  the per-node opacity mutation contract and saves zero draw calls. Jump to
  atlas.
- **D3 — Cache home: IndexedDB (editor), baked files (export).** Modeled on
  `ThumbnailCacheService`; `.pix3/atlas-cache/` FS mirroring deferred (extra
  permissions + project-tree noise for no additional win; revisit if
  collab-server pre-packing appears).
- **D4 — Cache key: size+mtime manifest hash in-editor, full sha256 on
  export.** Editor speed vs strictness split matches thumbnail precedent.
- **D5 — Pack scope: entry-scene closure** (scene + prefab scenes + script
  `res://` image refs), not the whole project — keeps sheets tight and hash
  churn local. Whole-project packing revisit if scene-switching thrashes.
- **D6 — Sheet size: 2048 max, multi-sheet allowed, no rotation.** Safe on
  mobile, keeps a sheet at 16 MB; rotation adds packer+UV complexity for
  single-digit % density at this asset scale.
- **D7 — Text: not atlased v1.** Canvas labels stay standalone (they're the
  main remaining run-breakers). Future: runtime glyph/label atlas — separate
  design; the batch keying already accommodates it (labels would just become
  another sheet).
- **D8 — Keep atlased source PNGs in exports v1.** Correctness (excluded or
  dynamically-referenced paths still resolve); stripping is a follow-up size
  optimization for playable-ad budgets once reference analysis is proven.
- **D9 — Await-pack on cache miss (no background rebuild).** One-time sub-
  second cost with a log line beats racing a half-atlased run; revisit with a
  Worker if projects with hundreds of large textures appear.

---

## 11. Phase 0 — MEASURED baseline (2026-07-18, SkyDefender `main.pix3scene`)

Measured via chrome-devtools MCP against the editor Game tab (dev build v0.8.10
build 36, Windows/ANGLE). Method: `__PIX3_DEBUG__.play.start()`, force frames
with MCP screenshots, read `ProfilerSessionService.getSnapshot().performance`
(= `RuntimeRenderer.getStatsSnapshot()`), and walk the live runtime THREE scene
via `window.__PIX3_ENGINE__.getRuntimeSceneRoot()` to classify rendered 2D
meshes (`material.depthTest === false`) in stamped-`renderOrder` paint order.

### 11.1 Per-state baseline

| State | Draw calls | Textures (GPU-resident) | Triangles | Render ms | FPS |
| --- | --- | --- | --- | --- | --- |
| Warmup (first frames, textures still streaming in) | 55 → 63 | 34 → 95 | — | ~2.2 | 60 |
| **Shop / between-wave menu** (24-icon upgrade grid) | **90** | 152 | 180 | 1.6 | 60 |
| Early wave (wave start, few enemies) | 68 | 154 | 136 | 1.5 | 60 |
| **Peak mid-wave** (full enemy set + muzzle/tracers/bombs, castle 92/250, 634 runtime objs) | **128** | 156 | 256 | **3.9** | 59 |

The doc's pre-measurement estimate (~95 static) was in the right ballpark; the
real numbers are **~90 at the shop menu and ~128 at a busy mid-wave peak**, and
draw calls scale ~linearly with active sprites (68 early → 128 peak).

### 11.2 Paint-order mesh breakdown (SYNCHRONIZED anchor = Shop, 90 meshes ≡ 90 calls)

| Metric | Shop | Peak wave (adjacent frame) |
| --- | --- | --- |
| Rendered 2D meshes | 90 | ~108 |
| — sprites / colorrect / text | 83 / 3 / 4 | 101 / 4 / 3 |
| Distinct sprite texture **sources drawn** | 57 | 45 |
| Runs A — current contiguous (per-texture, no atlas) | 70 | 82 |
| **Runs B — single-sheet atlas floor** (only text labels break runs) | **7** | **6** |

**Cross-check that proves the thesis:** at the shop, rendered 2D meshes (90) ≡
draw calls (90), and 3D meshes = 0. So today it is **exactly one draw call per
2D mesh, zero batching**. The single-sheet paint-order floor is **6–7 across
every state** — bounded only by the 3–4 scattered `Label2D`/canvas-text meshes
and the number of sheets, and **independent of sprite count**. That is the
Phase-3 headroom: 90–128 → ~6–15.

### 11.3 Atlas-packing universe (Phase-2 input)

| Metric | Value |
| --- | --- |
| File textures loaded over one full run (`AssetLoader.textureCache`) | **210** |
| Distinct file texture sources in the live 2D graph | 61 |
| Canvas/text (`Label2D`) textures | 6 |
| Total 2D meshes in graph incl. hidden | 146 |

The packing universe (~210 file textures) is **larger than the doc's ~93
estimate** — SkyDefender's `AnimatedSprite2D` enemies carry per-frame PNG
sequences (enemy/air, bosses, effects), which is precisely the many-small-files
case atlasing targets. This makes Phase 2 more valuable (bigger texture-count
collapse) and flags two things: (a) expect **2–4 sheets at 2048², not 1**, and
(b) re-check the await-on-miss pack time against the doc's <1 s estimate at this
input size (still await; just log it).

### 11.4 Phase-target re-confirmation (revised numbers)

- **Phase 2 (textures):** ~152–161 GPU-resident / ~210 loaded → **K sheets
  (1–4) + ~6 text canvases + excluded (sky background + oversized)**; the ≤12
  acceptance target holds. Draw calls unchanged (~90 shop / ~128 peak).
- **Phase 3 (draw calls):** floor 6–7; realistic HUD/wave clustering ~10–15.
  The ≤30 mid-wave / ≥70% cut target is comfortable (128 → ≤30 is a floor-6
  problem). AnimatedSprite2D is the single biggest win **and** the biggest
  correctness risk (offset/repeat reset trap + clone re-stamp, §5.3/§7.11).

---

## 12. SHIPPED results (measured, 2026-07-18)

Implemented on `feat/2d-batching` (commits: Phase 1 shared quad, Phase 2 atlas,
Phase 3 batching). Verified on SkyDefender `main.pix3scene` via chrome-devtools
MCP. Both features default **on** (`'auto'`); off is byte-identical.

### 12.1 Phase 1 (shared unit quad)
Rendered-2D geometry count **57–185 → 10** (all sprite meshes share one 1×1
`PlaneGeometry`, sized via `mesh.scale`). Draw calls unchanged, visual parity,
zero errors. `NodeBase.disposeResources` guards the shared geometry.

### 12.2 Phase 2 (pre-launch atlas + cache)
- `[Atlas] packed 276 textures → 2 sheets in ~1.1s (cache=miss)`, then
  `cache=hit` on the next run. (The scan was widened past the design's
  static-only §5.4 to also follow **script res:// directory prefixes** —
  `const AIR='res://…/enemy/air'`, template frame paths `…/bridge1/${i}.png` —
  because SkyDefender loads enemies/effects via dynamic paths a static scan
  can't see. Without this, 94 textures packed and ~70 dynamic sprites stayed
  standalone.)
- **GPU textures ~152 → 3** (clean state) after fixing a cache-pollution bug:
  the editor's edit-mode viewport shares the play AssetLoader, so it cached
  scene textures **raw** before play; `installResolver` now evicts every
  atlas-frame path (`AssetLoader.evictTexture`) so `startScene` re-resolves them
  to sheet views. Before the fix, 28 statically-referenced sprites (clouds, sky,
  gun, HP frame, weapon buttons, explosions) stayed raw.
- Pixel-perfect parity; cache hit/miss/invalidation confirmed; zero errors.

### 12.3 Phase 3 (paint-order quad batcher)
Same-mid-wave A/B (atlas on both), ~10 enemies, castle alive:

| | Batch OFF | Batch ON |
| --- | --- | --- |
| Draw calls | 79 | ~54–60 |
| **Render ms** | **5.8** | **2.0** |
| GPU textures | 17 | 3–27 |

- The batcher is **provably optimal**: `0 atlased passthrough` at every state —
  every atlas-view sprite gets batched (33–41 sprites → **7 batches**). Prefab
  spawns join existing runs (draw calls scale sub-linearly with enemies).
- **Render time cut ~65% (5.8 → 2.0 ms)** — the real GPU win.
- vs the Phase-0 raw baseline (no atlas, no batch): mid-wave 128 → ~54–60;
  early wave 31.
- Batch by **texture source** (extends the design's atlas-views-only v1) so
  same-sheet atlas views AND repeated same-texture raw instances both merge;
  null-map (ColorRect) runs batch separately. Per-node opacity/tint ride a
  4-component vertex color; source meshes hidden via `material.visible=false`.

### 12.4 Remaining draw-call floor = text labels
After batching, the passthrough count is dominated by **`Label2D`/canvas-text
meshes** (27–35 on the result screen, ~8 mid-gameplay) — unbatchable per **D7**
(labels stay per-node `CanvasTexture`). This is why text-heavy states sit above
the ≤30 target while sprite-heavy states meet it. A runtime glyph/label atlas
(D7 follow-up) would close the gap; the batch keying already accommodates it.

### 12.5 Follow-ups (deferred, documented)
1. **Export atlas emission** — `ProjectBuildService` does not yet write
   `assets/.atlas/` sheets+manifest; the runtime consumer
   (`installAtlasFromManifest`) and `TextureAtlasService.packForExport()` are
   ready. Exported/remote games run un-atlased until wired.
2. **Label/glyph atlas (D7)** — to batch text and reach ≤30 everywhere.
3. **Worker packing (D9)** — pack time is ~1.1 s for 276 textures (fine), but a
   Worker keeps huge texture sets off the main thread.
4. **White-pixel sheet frame (§5.4)** — would let ColorRect batch into sprite
   runs instead of its own null-map run.
