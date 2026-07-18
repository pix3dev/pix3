# Session prompt — Feature #4: 2D draw-call optimization (atlas packing + batching)

> Paste the section below as the first message of a fresh Claude Code session in the `pix3` repo.
> Everything above this line is a note; everything below is the prompt.

---

Implement **2D draw-call optimization for the Pix3 runtime**: pre-launch texture-atlas packing (with caching) + paint-order-preserving sprite batching, so a 2D game frame drops from ~1 draw call per node to a handful. This is an **engine-level** feature (touches `packages/pix3-runtime` + editor), so per `CLAUDE.md` state the plan and get my confirmation before writing code.

## Authoritative plan — read first
- **`.plans/2d-batching-atlas-design.md`** — the full, implementation-ready design (Fable-authored). This is the source of truth: phases, file map, the paint-order invariant (B1), the atlas-region-composition gotchas, the `AssetLoader.loadTexture` remap chokepoint, cache keying, export/player integration, and the 10 open decisions (all already decided — recommendation-first). Follow it.
- Also read: `AGENTS.md` (binding coding rules), `CLAUDE.md` (repo topology, on-demand rendering, 2D render-order notes), `docs/nodes-and-systems.md` (update it after adding the engine feature). Load the **`pix3-game-dev`** skill before writing runtime/render code.

## Repo state you're inheriting (branch `feat/editor-improvements`)
Three features already shipped + verified this-week on this branch (Sprite Editor rename `53e6c07`, Group2D fit/proportional-resize `7cd1bac`, **Localization Phase 0** `8987ac7`). The localization commit added `labelKey`/`getDisplayText()` to `UIControl2D`/`Label2D` and a `core/localization/` module — no conflict with batching, but note label meshes now paint `getDisplayText()`, still per-node `CanvasTexture` (labels are **not** atlased/batched v1, per design §5.4/§6.2 — they stay run-breakers). Start #4 on this branch (or a fresh `feat/2d-batching` off it — your call).

## ⚠️ Verification environment — this is the part not in the design doc
#4's payoff (draw calls) and correctness (pixel parity) can only be checked with a **real rendering context**. Hard-won learnings from the prior session:

1. **Use the chrome-devtools MCP, not raw CDP.** The editor viewport renders **on-demand** (rAF); an unfocused/background Chrome throttles rAF so **no WebGL canvas is ever created** and `ViewportRenderService.orthographicCamera` stays null / `viewportSize` is `0×0`. The chrome-devtools MCP's `take_screenshot` **forces a composite/paint**, which creates the canvas and runs frames. So: after any state change, call `mcp__...__take_screenshot` to force a render before reading stats or checking visuals. (A raw-CDP fallback driver exists at the prior session's scratchpad `cdp.mjs` — evaluate/screenshot/navigate/reload over `127.0.0.1:9222` — but it hits the same no-canvas wall unless the window is truly foregrounded; prefer the MCP.)
2. **Draw-call measurement recipe (verified working):**
   ```js
   // via MCP evaluate_script, after: dev server up (npm run dev, :8123), editor open with a scene
   const d = window.__PIX3_DEBUG__;
   await d.play.start();                    // enter play mode
   // ...force 1-2 screenshots via the MCP to run frames...
   const di = await import("/src/fw/di.ts");
   const c = di.ServiceContainer.getInstance();
   const ps = c.getService(c.getOrCreateToken((await import("/src/services/ProfilerSessionService.ts")).ProfilerSessionService));
   const perf = ps.getSnapshot().performance;   // { drawCalls, textures, triangles, renderMs, fps, ... }
   await d.play.stop();
   ```
   `perf.drawCalls` and `perf.textures` are exactly the A/B numbers (design §1 "Telemetry" — no new instrumentation needed). `window.__PIX3_DEBUG__` also has `.scene()`, `.command(id)`, `.agentTools.execute(tool,args)`, `.play.{start,stop,restart,status}`.
3. **Opening a project/scene headlessly** (no native directory picker): create an OPFS "browser" project via DI —
   ```js
   const pls = c.getService(c.getOrCreateToken((await import("/src/services/ProjectLifecycleService.ts")).ProjectLifecycleService));
   await pls.createProject({ name:"batch-test", backend:"browser", viewportBaseWidth:1280, viewportBaseHeight:720, templateId:"empty-2d" });
   // then EditorTabService.focusOrOpenScene("res://.../main.pix3scene") to open a scene in the viewport
   ```
   `create_node` (agent tool) builds nodes: `d.agentTools.execute("create_node", { nodeType:"Sprite2D", parentId:"<scene-root>", name:"S" })`.
4. **Representative test scenes:** the chrome-devtools MCP profile already has a real 2D project **"S1 Clean Ring Racing"** (`local=473887da…`; track + cars + UI). Baseline measured there: **menu = 6 draw calls / 3 textures** (the game boots to the menu; drive into the race for gameplay counts). The design's target is **SkyDefender** (`samples/SkyDefender`, ~95 calls) — richer, but opening it needs a **one-time human directory-pick** (ask me to open `c:\Projects\pix3-stuff\pix3\samples\SkyDefender` in the MCP's Chrome; the OPFS handle then persists). For a controlled baseline you can also spawn N `Sprite2D`s into an OPFS scratch scene via `create_node`.
5. Skills that help: `debug-running-game`, `pix3-remote-preview` (SkyDefender), `generate-sprites-in-editor`.

## Execution order (from the design; ship incrementally, verify each)
- **Phase 0 — Measure (no code).** Get the real per-scene baseline (`drawCalls`, `textures`, `renderMs`) at menu / gameplay / peak on Ring Racing and/or SkyDefender using the recipe above. Record it. Optional: add a `textures` row next to "Draw calls" in the Profiler panel.
- **Phase 1 — Cheap prep (minimal).** Shared unit-quad geometry singleton (`core/shared-quad-geometry.ts`) for Sprite2D/ColorRect2D/AnimatedSprite2D (size via `mesh.scale`), + empty-label guard. **Honest: this does NOT reduce draw calls** — it's churn/memory prep for Phase 3. Do NOT do cross-node material sharing (conflicts with the per-node opacity mutation in `Node2D.applyOpacityToMaterial`; saves zero calls). `yalc:publish` → DeepCore smoke.
- **Phase 2 — Atlas + cache (FIRST SHIPPABLE WIN).** MaxRects packer (`src/services/atlas/`), the editor-agnostic `AtlasResolver`/`AtlasFrame`/`AtlasManifest` contract (`core/atlas-frame-map.ts`), the `AssetLoader.loadTexture` remap (view-clone + `applyTextureRegionToTexture` + `userData.pix3AtlasRegion/pix3AtlasSize`), `composeTextureRegion` in `core/texture-region.ts`, IndexedDB cache (`AtlasCacheStore`, modeled on `ThumbnailCacheService`), and export/player wiring. **Cuts textures ~93→≤12; draw calls unchanged.** Mind the regression traps the design flags: `AnimatedSprite2D.refreshTexturePresentation` resets offset/repeat (would erase atlas regions — compose instead); `Sprite2D` natural-size must read `pix3AtlasSize`, not the sheet image dims; `TiledSprite2D`/canvas-text/3D-shared/oversized are excluded at pack-time AND bypassed at load-time (`{atlas:false}`).
- **Phase 3 — Batcher (the draw-call collapse, behind a flag).** Custom CPU quad batcher (`core/batch-2d.ts`), NOT `THREE.BatchedMesh` (design D1/§6.1). Extend `assign2DRenderOrder` with a collector sink; segment the ordered mesh list into **contiguous runs sharing (atlas sheet, blending, layer band)**; merge runs ≥2 into one dynamic `BufferGeometry` with per-vertex **rgba** (tint×opacity — this is why not BatchedMesh) rebuilt every frame from `reflowRoot2DNodes`; suppress batched sources via `material.visible=false`; nodes opt-in with `BATCHABLE_2D_KEY`. **Target ≤30 calls mid-wave on SkyDefender (≥70% cut), frame-time flat-or-better, zero visual diffs.** Default the flag `'off'` during rollout, `'auto'` after burn-in.

## Correctness invariants you must not break (design §0, §6.2, §7)
- **B1 (paint order):** a batch may contain only meshes **contiguous in the stamped `renderOrder`** and sharing one material state; quads appended in stamped order. All 2D materials are `depthTest:false` and `assign2DRenderOrder` stamps a unique per-mesh order every frame — that order IS the total paint order. Any reordering = z-fighting bugs.
- `configure2DTexture` is mandatory for atlas sheets (sRGB, `generateMipmaps=false`, project filtering) — this is why NPOT sheets are fine and why the ANGLE/Adreno transparent-black bug is avoided.
- Per-node opacity/tint rides **vertex colors** in batches — never mutate a shared batch material per node.
- The editor viewport (`ViewportRenderService`) draws its **own** proxy meshes and is out of scope — only `SceneRunner` (play/runtime) changes. Visual parity is the guard.
- Feature flags: project-manifest `rendering2D: { textureAtlas, batching }` + `__PIX3_DEBUG__`/URL overrides, so `off` is byte-identical to today.

## Verification required per phase (design §8)
- Vitest specs: `MaxRectsPacker` (no overlap / in-bounds / padding), `composeTextureRegion`, `AssetLoader` resolver remap (seed `textureCache` per the AssetLoader-texture-test gotcha), run-segmentation, and a paint-order test (emitted index order == stamped order, CPU-verifiable).
- **A/B via the MCP recipe:** flag-on vs flag-off, same build — assert `textures` drop (Phase 2), `drawCalls` drop ≥70% mid-wave (Phase 3), frame-time flat/better; **pixel-parity** screenshot compare (game area) at a deterministic frame; spawn a prefab wave and assert `drawCalls` stays flat while batch quad-count rises.
- Keep `tsc --noEmit` at the repo baseline (~32 pre-existing errors — don't add new ones), lint clean (ignore the repo-wide CRLF/prettier `Delete ␍` noise), no runtime-spec regressions (`packages/pix3-runtime/src/core` + `nodes/2D` specs).

## Conventions
- Runtime package is the **editor-agnostic, publishable** contract — the packer lives editor-side (`src/services/atlas/`), the runtime consumes the `AtlasResolver` interface. After runtime changes: `cd packages/pix3-runtime && npm run yalc:publish`, then `yalc update` in `../DeepCore`.
- Mutation gateway (Command+Operation) for any editor state change; DI for services; Light-DOM Lit + IconService + theme tokens for any UI (e.g. the Profiler `textures` row / flag toggles).
- Update `docs/nodes-and-systems.md` + `docs/pix3-specification.md` after landing the engine feature.
- Commit incrementally (Phase 2 as its own shippable commit, Phase 3 behind the flag); end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

Start with Phase 0 (measure + report the baseline table), then propose the Phase-2 plan for my confirmation before coding.
