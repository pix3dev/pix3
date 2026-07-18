# Design: Group2D "Fit to Contents" + Figma-style Proportional Child Resize

Status: DESIGN (implementation-ready). Two coupled editor features:

- **(A) Fit Group2D to contents** — one-shot action that recomputes the group's `width`/`height`
  (and shifts its center-origin) to wrap its children, **without moving any child in world space**.
- **(B) Proportional child resize** — resizing a Group2D (gizmo drag or inspector W/H edit) scales
  children's positions **and sizes** by `(newW/oldW, newH/oldH)`, like resizing a Figma group.

A is the inverse of B: A refits the box to fixed children; B rescales children to a changed box.

---

## 0. Top decisions (recommendation first)

| # | Decision | Recommendation | Why |
|---|----------|----------------|-----|
| 1 | Auto-size: persistent flag vs one-shot action | **One-shot "Fit to contents" button + Command** | Reactive flag needs hooks on every child-mutation path (ops, gizmo live-drag, script edits, undo), risks feedback loops with (B) (fit fighting proportional resize mid-gesture), and adds per-frame cost. The button matches the stated acceptance and composes cleanly with undo. Flag deferred (see §7 Phase 3, "rejected for now"). |
| 2 | Bounds scope for fit | **Full-subtree union, including each nested Group2D's own box** | A nested group's `width`/`height` box is decorative today and may not wrap *its* contents, so direct-children-only can under- or over-shoot. Union of every descendant's node-only rect **plus** each descendant Group2D's own rect guarantees nothing (visual or logical) sticks out. Visibility-agnostic (hidden nodes included) — predictable, no surprise when unhiding. |
| 3 | Anchored (`layoutEnabled`) children during proportional resize | **Anchor wins; skip proportional for them** | Anchor layout is an explicit opt-in per child and already reflows on group resize via `reflowAnchoredChildren()` (Group2D setters, `packages/pix3-runtime/src/nodes/2D/Group2D.ts:34,48`). Applying both would double-move. Matches Figma's "constraints override scale". |
| 4 | Where the math lives: runtime vs editor | **Editor-side pure module; runtime untouched; DELETE the dead `updateLayout?.()` call** | No runtime caller exists or is needed (games get anchor layout for responsive needs). The node-measurement logic (`getNodeOnlyLocalCorners`, incl. `UIControl2D` measurement) already lives in `ViewportRenderService` — reuse beats duplicating it engine-side. The rule "purely editor geometry stays in the editor" applies. The new planner module is written dependency-light (three + `@pix3/runtime` types only) so it can be promoted into `packages/pix3-runtime/src/core/` later if a game ever needs `group.scaleContents()`. |
| 5 | Inspector W/H edits on Group2D | **Always proportional (route through new `ResizeGroup2DCommand`)** | Consistent with the gizmo. "Resize box only" is served by (A) + a future Ctrl-drag modifier (Phase 3). Non-inspector paths (generic schema `setValue`, agent tools, animation) keep today's box-only + anchor-reflow semantics — proportional is an *editor authoring* gesture, not a property semantic. |
| 6 | Gesture commit granularity | **One `BulkOperation` per drag gesture (group + descendants; also batches multi-select)** | Today `complete2DTransform` pushes one op **per node** (`src/services/ViewportRenderService.ts:7659-7666`) → multi-select drags already produce N undo steps (a wart). Child-scaling makes per-node commits untenable; batching fixes both. |
| 7 | Fit on group creation (`GroupSelectedNodesOperation`) | **Yes, Phase 2** — create the group pre-sized/pre-positioned to the selection's world bounds *before* `attach()`ing children | `attach()` already preserves world transforms (`src/features/scene/GroupSelectedNodesOperation.ts:341`), so no compensation pass is needed — cheapest possible implementation. Kept out of MVP to keep the first PR reviewable. |

---

## 1. Feature A — Fit Group2D to Contents

### 1.1 Coordinate model (verified)

- Group2D is **center-origin** with explicit `width`/`height` (default 100×100), `isContainer = true`
  (`packages/pix3-runtime/src/nodes/2D/Group2D.ts:11-49`). No anchor/pivot on Group2D.
- A child's `position` is expressed in the group's local frame (origin = group center). World 2D is
  Y-up (`Node2D.getPointerWorldPosition`, `packages/pix3-runtime/src/nodes/Node2D.ts:255-258`).
- Node-only local corners per type exist in `ViewportRenderService.getNodeOnlyLocalCorners`
  (`src/services/ViewportRenderService.ts:6395-6447`): Sprite2D/TiledSprite2D anchor-aware
  (`[-ax·w..(1-ax)·w] × [-ay·h..(1-ay)·h]`), Group2D/ColorRect2D/AnimatedSprite2D center-origin ±w/2,
  UIControl2D via `getUIControlDimensions`, fallback 50×50. World corners:
  `getNodeOnlyWorldCorners` (:6449-6452).

### 1.2 Exact algorithm

Inputs: group `G` (Group2D) with parent-frame transform: position `p`, rotation `θ` (`rotation.z`),
scale `s = (sx, sy)`; direct children `q_i` (positions in G-local).

**Step 1 — contents rect in G's local frame.**

```
Minv = G.matrixWorld.clone().invert()          // G.updateWorldMatrix(true, false) first
rect = empty
for each descendant d of G where d instanceof Node2D:      // full subtree, per decision #2
    for corner in getNodeOnlyWorldCorners(d):              // d's node-only rect, anchor-aware
        rect.expandByPoint(corner.applyMatrix4(Minv))      // corner now in G-local
```

Note: `getNodeOnlyWorldCorners` maps *node-local* corners through `d.matrixWorld`, so children's
rotation/scale and nesting depth are all handled by the matrix chain; the inverse map lands
everything in G-local regardless of G's own rotation/scale. Runtime meshes that are not `NodeBase`
children (label/skin meshes inside `UIControl2D` etc.) are already covered by the per-type corner
logic — only `instanceof Node2D` children are walked.

If `rect` is empty (no Node2D descendants) → `didMutate: false` (and the inspector button is
disabled, §5).

**Step 2 — new size and origin shift.**

```
newW = max(1, rect.max.x - rect.min.x)         // clamp ≥1 so the box stays selectable
newH = max(1, rect.max.y - rect.min.y)
c    = ((rect.min.x + rect.max.x) / 2,  (rect.min.y + rect.max.y) / 2)   // rect center, G-local
```

**Step 3 — compensated transforms (world positions must not move).**

The group's origin must land on `c`. Translating G's frame by `c` (expressed in G-local) equals
translating G's parent-space position by the linear part of G's local matrix applied to `c`:

```
p'.x = p.x + sx·c.x·cosθ − sy·c.y·sinθ
p'.y = p.y + sx·c.x·sinθ + sy·c.y·cosθ
```

Every **direct child** counter-shifts in G-local (rotation/scale/size untouched):

```
q_i' = q_i − c
```

Proof of invariance: child world position = `M_parent · (p + L·(q_i))` before, and
`M_parent · (p + L·c + L·(q_i − c))` after, where `L = R(θ)·diag(sx, sy)` — identical. Deeper
descendants are expressed relative to their own parents and are untouched → world-exact.
G's rotation and scale never change, so orientation/size of everything is preserved exactly
(no float drift beyond one add/sub).

Anchored (`layoutEnabled`) direct children get the same `−c` compensation and their commit
re-captures the authored layout rect (see §1.3), so the anchor system rebases cleanly.

**Step 4 — degenerate cases.** All children at one point → `newW = newH = 1` (clamp). Single child
→ box == child rect. Children partly outside the old box → box grows/shrinks to the true union
(that is the point of the feature).

### 1.3 Operation composition (atomic undo)

Follow the `Align2DNodesOperation` pattern exactly (`src/features/alignment/Align2DNodesOperation.ts:109-124`):
an outer Operation that `perform()`s per-node `Transform2DCompleteOperation`s and composes their
commits with `BulkOperationBuilder` (`src/core/BulkOperation.ts`).

```
FitGroup2DToContentsOperation.perform(context):
  plans = [
    { nodeId: G, previousState: {position:p,       width:w,    height:h},
                 currentState:  {position:p',      width:newW, height:newH} },      // GROUP FIRST
    ...directChildren.map(ch => ({ nodeId: ch, previousState:{position:q},
                                              currentState:{position:q'} })),
  ]
  bulk = new BulkOperationBuilder()
  for plan in plans:  result = await new Transform2DCompleteOperation(plan).perform(context)
                      if result.didMutate && result.commit: bulk.add(result.commit)
  → { didMutate: !bulk.isEmpty(), commit: bulk.build('Fit Group to Contents') }
```

**Ordering matters** (group first, children after):

- `Transform2DCompleteOperation.applyState` on the group calls `reflowAnchoredChildren()` +
  `captureAnchoredDescendantRects()` when size changes on a container
  (`src/features/properties/Transform2DCompleteOperation.ts:140-143`). Running the group commit
  first lets that reflow fire, then the explicit child commits overwrite with the compensated
  positions and re-capture each child's authored rect (`applyState` → 
  `captureAuthoredLayoutRectFromCurrent`, :139) — final state is exact regardless of reflow.
- Undo runs reversed (`BulkOperation.ts:35-39`): children restore explicit old positions and
  re-capture authored rects first, then the group restores old size/position and its reflow
  recomputes anchored children from the just-restored rects — deterministic, world-exact.

Viewport: each `Transform2DCompleteOperation` already calls `vr.updateNodeTransform(node)` on
apply/undo/redo (:70-76, :90-96, :105-111), which syncs the Group2D proxy
(`sizeGroup.scale.set(width, height, 1)` branch, `ViewportRenderService.ts:3512-3522`) and each
child proxy. The outer operation finishes with `vr.updateSelection()` (rebuilds the 2D selection
frame/handles to the new box) + `vr.requestRender()` — required because ops mutate three.js objects
outside pointer/state paths (CLAUDE.md "viewport renders on demand").

### 1.4 Command

`FitGroup2DToContentsCommand` (thin, mirrors `Align2DNodesCommand`,
`src/features/alignment/Align2DNodesCommand.ts`):

- `metadata.id: 'scene.fit-group2d-to-contents'`, title "Fit Group to Contents",
  keywords `['group', 'fit', 'resize', 'contents', '2d']`, `addToMenu: false` (MVP; menu/shortcut later).
- `preconditions`: active scene; target node exists, `instanceof Group2D`, has ≥1 `Node2D`
  descendant; not read-only/playing (`appState.collaboration.isReadOnly || appState.ui.isPlaying`).
- `execute`: `operationService.invokeAndPush(new FitGroup2DToContentsOperation({ nodeId }))`.

---

## 2. Feature B — Proportional child resize

### 2.1 What already exists vs what's missing (verified)

The gizmo scale branch (`src/services/TransformTool2d.ts:834-930`) already:

- computes `scaleFactorX/Y` from the overlay start size, repositions each **selected** node by
  scaling its offset-from-center in the overlay frame (:895-909), and for nodes exposing
  `width`+`height` sets `w = startW·fx`, `h = startH·fy` while keeping `node.scale` stable
  (:911-927). So when a *single Group2D* is selected, **only the group's own w/h change**; its
  children move only if `layoutEnabled` (via the runtime width/height setters → reflow).

Missing for (B):

1. **Non-anchored children are not touched at all** — neither position nor size.
2. **Child SIZE scaling** in general (the existing loop only covers selected nodes).
3. **The inspector numeric-edit path** — plain `width`/`height` inputs route through
   `UpdateObjectPropertyCommand` → box-only + anchor reflow.
4. The `groupChild.updateLayout?.()` call in `ViewportRenderService.update2DTransform`
   (:7599-7614) is a **dead no-op** (no such method on Group2D) — to be deleted.
5. Per-gesture atomic undo including children.

### 2.2 Scaling rules (the planner)

Given group `G` resized from `(oldW, oldH)` to `(newW, newH)`:
`fx = oldW > 0 ? newW/oldW : 1`, `fy = oldH > 0 ? newH/oldH : 1` (zero-size guard).

For each **direct child** `ch` of `G` (recursively, per the rules below), computed **from base
states** (never frame-over-frame — see §2.3):

| Case | Position | Size | Recurse into its Node2D children? |
|---|---|---|---|
| `ch.layoutEnabled === true` | skip (anchor reflow owns it) | skip | no (its subtree follows it) |
| duck-typed `width` & `height` (numbers): Group2D, Sprite2D, TiledSprite2D, ColorRect2D, UIControl2D… | `q → (q.x·fx, q.y·fy)` | `w·fx, h·fy` (clamp ≥0; live drag additionally clamps to gizmo `minSize`) — `node.scale` untouched | **yes**, with the same `(fx, fy)` — its frame did not scale, so contents must be scaled explicitly (this is the nested-group recursion) |
| no width/height (uniform `size`/`radius` nodes, plain Node2D, unknown types) | `q → (q.x·fx, q.y·fy)` | `scale.set(scale.x·fx, scale.y·fy)` | **no** — descendants inherit through the transform |

Key invariant: **"handled via width/height ⇒ recurse; handled via scale ⇒ stop."** This prevents
double-scaling and guarantees Figma-like results for arbitrary nesting.

- **Position scaling about the group origin** is correct because Group2D is center-origin — the
  origin *is* the box center, which is Figma's scale pivot for symmetric resize. (Handle-anchored
  resize is already handled upstream: the gizmo moves the group's own position so the anchor edge
  stays fixed; children only need scaling in the group's local frame.)
- **Rotation**: unchanged. For a rotated child under non-uniform `(fx ≠ fy)`, true proportional
  resize is a shear which `Object3D` cannot represent; we scale `width` by `fx` / `height` by `fy`
  in the child's own axes — the same approximation the existing multi-select gizmo already makes
  (`TransformTool2d.ts:911-927`). Documented, accepted. Uniform `fx == fy` is exact for any rotation.
- **Aspect-lock**: Group2D has no `aspectRatioLocked`; the gizmo's `preserveAspectRatio` option
  (Shift) keeps `fx == fy` upstream (:867-885) — planner needs no special handling. A child
  Sprite2D's own aspect lock is deliberately **not** enforced during group scaling (uniform scale
  preserves aspect anyway; non-uniform group resize wins, matching Figma).
- **Min clamps**: gizmo clamps group w/h to `minSize` (px-derived, :839,857-861); child sizes clamp
  ≥0 via runtime setters plus explicit `max(0, ·)` in the planner; live drag uses `max(minSize, ·)`
  for children with size, matching existing behavior for selected nodes.

### 2.3 Live gizmo drag — idempotent, no drift

Scaling children frame-over-frame accumulates error (and min-clamps break reversibility). Instead,
capture **descendant base states once at drag start** and reapply from them every frame:

- Extend `Active2DTransform` (`src/services/TransformTool2d.ts:50-62`) with
  `childStartStates?: Map<string, Transform2DState>` (same shape as `startStates`, :28-36).
- In `TransformTool2d.startTransform` (:628-672): when `handle` is a `scale-*` and a selected node
  is a `Group2D`, walk its subtree per §2.2 recursion rules and snapshot
  `position / scale / width? / height?` for every descendant the planner may touch (skip
  `layoutEnabled` subtrees).
- In the scale branch of `updateTransform`, after the existing per-selected-node block
  (:895-928): for each selected Group2D, apply the §2.2 plans computed from `childStartStates`
  with the current `(fx, fy)`. Pure function of (start states, current factors) ⇒ idempotent
  per frame, drift-free, and Escape-cancel can restore exactly from the same map.
- `ViewportRenderService.update2DTransform`: **delete** the dead `updateLayout?.()` block
  (:7599-7612); keep the `syncAll2DVisuals()` call for resize handles so child proxies repaint
  during the drag (:7613).

Multi-select note: when several Group2Ds are selected and resized together, each group's
descendants are captured and scaled with the same global `(fx, fy)`; the groups themselves are
already handled by the existing selected-node loop.

### 2.4 Commit path — one undo step per gesture

Replace the per-node `invokeAndPush` loop in `complete2DTransform`
(`ViewportRenderService.ts:7632-7666`) with a single composite op:

- New `Transform2DBatchOperation` (`src/features/properties/Transform2DBatchOperation.ts`):
  takes `plans: Transform2DCompleteParams[]`, `label: string`; `perform()` runs each
  `Transform2DCompleteOperation` and composes commits via `BulkOperationBuilder` (identical
  skeleton to `Align2DNodesOperation.perform`, :109-124). Since every node already carries the
  drag-final values, `applyState` on first perform is a no-op re-assignment (setters early-return
  on equal values) — cheap and safe.
- `complete2DTransform` builds plans for: (a) every selected node (previous = `startStates`,
  current = live node state — exactly the fields it collects today, :7639-7657), then (b) every
  entry in `childStartStates` whose current state differs (previous = captured, current = live;
  include `scale` for scale-fallback children). Order: **each group before its descendants**
  (same rationale as §1.3). One `operationService.invokeAndPush(new Transform2DBatchOperation(...))`.
- Side benefit: plain multi-select move/rotate/scale gestures become one undo step (currently N).
  `isStateEqual` filtering inside `Transform2DCompleteOperation` (:146-193) keeps no-op nodes out.
- Finish with `update2DSelectionOverlayForNodes(savedNodeIds)` (already there, :7673) — overlay
  and handles resync; `updateNodeTransform` per node came from the child ops; add
  `this.requestRender()`.

Undo/redo correctness: explicit per-node previous/current states for group **and** children — no
reliance on reflow determinism; world positions restore exactly. Anchored children are absent from
plans; the group commit's reflow recomputes them on undo/redo from their authored rects (existing,
tested behavior).

### 2.5 Inspector numeric path

New `ResizeGroup2DCommand` + `ResizeGroup2DOperation` (`src/features/properties/`), precedent:
`UpdateSprite2DSizeCommand`/`Operation`.

- Params: `{ nodeId, width, height }` (both always sent; unchanged axis ⇒ factor 1).
- Operation: reads current `(oldW, oldH)` from the node, computes `(fx, fy)`, builds plans via the
  shared planner (`buildProportionalResizePlans`, §3) from **current** node states (one-shot — no
  start-state map needed), composes group-first + descendants via `BulkOperationBuilder`, label
  `'Resize Group'`. `didMutate:false` when size unchanged.
- Inspector wiring (`src/ui/object-inspector/inspector-panel.ts`): `renderSizeGroup` (:2966)
  currently falls back to plain inputs for every non-Sprite2D node (:2989-2994). Add a
  `primaryNode instanceof Group2D` branch **before** that fallback:
  - W/H inline inputs (reuse the `size-inline-editor` markup from the Sprite2D branch, :3052-3069,
    minus aspect-lock), `@change` → `commandDispatcher.execute(new ResizeGroup2DCommand({...}))`.
  - A "Fit to contents" action button (§5) in the same section.
  - Read-only gating identical to the anchor toggle (:2842): 
    `appState.collaboration.isReadOnly || appState.ui.isPlaying`.
- Non-inspector width/height writes (generic `UpdateObjectPropertyCommand`, agent tools, scripts)
  keep existing semantics (box-only + anchor reflow via `afterNodePropertyApplied`,
  `src/features/properties/UpdateObjectPropertyOperation.ts:377-390`) — per decision #5.

---

## 3. Shared planner module (new)

`src/features/scene/group2d-resize-utils.ts` — pure functions, no DI, imports only `three` types +
`@pix3/runtime` node classes (deliberately liftable into the runtime later, decision #4):

```ts
export interface Node2DCornerMeasurer { (node: Node2D): THREE.Vector3[] }   // node-local corners

export function computeContentsLocalRect(
  group: Group2D, measure: Node2DCornerMeasurer): { min: Vector2; max: Vector2 } | null
// full-subtree union in group-local space (§1.2 step 1); null when no Node2D descendants

export function buildFitPlans(
  group: Group2D, rect): Transform2DCompleteParams[]
// group plan (position + width/height) + direct-child −c compensation plans (§1.2 steps 2-3)

export interface ProportionalBaseState { position: {x,y}; scale: {x,y}; width?; height? }

export function buildProportionalResizePlans(
  group: Group2D,
  from: { width: number; height: number },
  to:   { width: number; height: number },
  baseStates?: ReadonlyMap<string, ProportionalBaseState>,   // drag start-states; defaults to live
): Transform2DCompleteParams[]
// §2.2 rules; returns descendant plans only (group's own w/h plan is the caller's)
```

The corner measurer is passed in (not imported) so the module stays free of
`ViewportRenderService`. Callers pass `node => vrs.getNodeOnlyLocalCorners(node)` — change that
method from `private` to `public` (`ViewportRenderService.ts:6395`); `Align2DNodesOperation`
already injects VRS inside an operation, so precedent exists. TransformTool2d's live path calls the
planner directly with its captured base states (no measurer needed — proportional math never
measures bounds).

---

## 4. Files

### New

| File | Contents |
|---|---|
| `src/features/scene/group2d-resize-utils.ts` (+ `.spec.ts`) | Pure planner (§3) |
| `src/features/scene/FitGroup2DToContentsCommand.ts` | Command (§1.4) |
| `src/features/scene/FitGroup2DToContentsOperation.ts` (+ `.spec.ts`) | Operation (§1.3) |
| `src/features/properties/ResizeGroup2DCommand.ts` | Command (§2.5) |
| `src/features/properties/ResizeGroup2DOperation.ts` (+ `.spec.ts`) | Operation (§2.5) |
| `src/features/properties/Transform2DBatchOperation.ts` | Gesture-commit compositor (§2.4) |

### Modified

| File | Change |
|---|---|
| `src/services/TransformTool2d.ts` | `Active2DTransform.childStartStates`; capture in `startTransform` (scale handles + Group2D); apply proportional plans in `updateTransform` scale branch (§2.3) |
| `src/services/ViewportRenderService.ts` | `getNodeOnlyLocalCorners` → public; delete dead `updateLayout?.()` block (:7599-7612, keep `syncAll2DVisuals`); `complete2DTransform` → single `Transform2DBatchOperation` incl. descendant plans; `requestRender()` after commit |
| `src/ui/object-inspector/inspector-panel.ts` (+ sibling `.ts.css`) | Group2D branch in `renderSizeGroup`: W/H → `ResizeGroup2DCommand`; "Fit to contents" button → `FitGroup2DToContentsCommand` (§5) |
| `docs/pix3-specification.md` | Remove the stale `updateLayout` mention (:554); one paragraph on fit + proportional resize semantics |
| Phase 2: `src/features/scene/GroupSelectedNodesOperation.ts` | Create the group at selection world-bounds center with bounds size (replace fixed `width:100,height:100`, :95-101) *before* the `attach()` loop — attach preserves child world transforms, zero compensation needed |

No runtime package changes in MVP (decision #4) ⇒ no `yalc:publish`, no DeepCore impact, no
`docs/nodes-and-systems.md` entry (editor-only feature).

---

## 5. Inspector UI

In the new Group2D `renderSizeGroup` branch (§2.5):

```
Size
  W [ 320 ]   H [ 240 ]
  [ ⇱⇲ Fit to contents ]     ← action button, full-width secondary style
```

- Button: hand-coded (no schema action type), pattern-matched to the anchor toggle button
  (`inspector-panel.ts:2853-2863`) — `type="button"`, `?disabled` on read-only/playing **or** when
  the group has no `Node2D` descendants, `@click => commandDispatcher.execute(new FitGroup2DToContentsCommand({nodeId}))`.
- Icon: `IconService.getIcon('minimize-2', 14)` — Feather's inward-pointing arrows read as
  "shrink-wrap to contents". Vector only, no emoji/glyphs. (If design review prefers a bespoke
  "frame hugging corners" glyph, register it in `IconService.registerCustomIcons()` — not needed
  for MVP.)
- Styling via existing theme tokens (`--pix3-accent-color` for hover), classes in the sibling
  `inspector-panel.ts.css`; Light-DOM Lit as usual.

---

## 6. Edge cases & interactions

| Case | Behavior |
|---|---|
| Empty group (no Node2D descendants) | Fit: `didMutate:false`; button disabled. Proportional: planner returns `[]`, group resizes box-only (unchanged from today). |
| Single child | Fit → box == child's node-only rect; origin moves to child's rect center. |
| Children partly/fully outside the box | Fit uses the true union — box can grow *or* shrink; world positions never move. |
| Deeply nested groups | Fit: subtree union via matrix chain (§1.2). Proportional: explicit recursion with the width/height-vs-scale stop rule (§2.2). |
| Group with rotation and/or scale ≠ 1 | Fit: handled by `L·c` compensation (§1.2 step 3), exact. Proportional: factors apply in the group's local frame; rotated *children* under non-uniform factors use the documented shear-free approximation (§2.2). |
| `oldW == 0` or `oldH == 0` | Proportional factor forced to 1 on that axis (§2.2). Fit clamps results ≥1. |
| Anchored-layout children | Fit: compensated like others, authored rects re-captured by their commits (§1.3). Proportional: skipped — anchor reflow owns them (decision #3). |
| Undo/redo | Single bulk commit; explicit per-node previous/current states for group + children; undo replays reversed (children→group) so anchor reflow re-derives from restored rects. World positions restore exactly. |
| Prefab instances | Fit/resize are property-level edits (position/width/height) — representable as prefab overrides; only *reparenting* of prefab children is forbidden (cf. `GroupSelectedNodesOperation.ts:64-66`). Open item: verify save-time override capture includes `width`/`height` for prefab children (low risk; same exposure as today's gizmo resize). |
| Play mode / collab read-only | Inspector controls gated (§5); gizmo already gated upstream; commands re-check in `preconditions`. |
| Live drag vs commit | Drag mutates from start-state snapshots (idempotent, §2.3); commit records explicit states (§2.4); Escape-cancel restores from the same snapshots. |
| Viewport on-demand rendering | All mutation exits call `vr.updateNodeTransform` per node (built into `Transform2DCompleteOperation`) + `updateSelection`/overlay refresh + `requestRender()`. |
| 2D draw order | Untouched — no reparenting, no tree-order changes; render-order DFS is unaffected. |

---

## 7. Phased plan

**Phase 1 — MVP (one PR, both features):**
1. `group2d-resize-utils.ts` + unit specs (pure math: rotated/scaled groups, anchor-aware sprite
   corners, nested groups, zero sizes, layoutEnabled skip).
2. (A) `FitGroup2DToContentsOperation`/`Command` + inspector button + op spec (build a small scene
   graph, run, assert world corners of every descendant unchanged; assert single undo step
   restores byte-exact states — follow `Align2DNodesOperation.spec.ts` patterns).
3. (B-inspector) `ResizeGroup2DOperation`/`Command` + `renderSizeGroup` Group2D branch + op spec
   (children position+size scaled; nested group recursion; anchored child skipped; undo exact).
4. (B-gizmo) `Transform2DBatchOperation`; `TransformTool2d` child capture + live apply;
   `complete2DTransform` batching; delete dead `updateLayout` block; manual verify via
   editor (drag handles on a populated group; undo once restores everything).

**Phase 2:** auto-fit on group creation in `GroupSelectedNodesOperation` (decision #7) — create
pre-sized at selection bounds, `attach()` does the rest; update its spec.

**Phase 3 (optional, post-feedback):**
- Ctrl-drag / checkbox modifier for box-only group resize (Figma's "ignore constraints" analog).
- Menu entry + shortcut for Fit (`menuPath`, via CommandRegistry metadata).
- Reactive auto-size **flag** — still not recommended: needs recompute hooks on every child
  mutation path, feedback-loop guards against (B), serialization + runtime semantics questions
  (engine-agnostic rule). Revisit only if users ask after living with the button.
- Promote `buildProportionalResizePlans` into `packages/pix3-runtime/src/core/` +
  `Group2D.scaleContents(fx, fy)` if a game needs runtime proportional resize (then
  `yalc:publish` + `docs/nodes-and-systems.md` entry).
