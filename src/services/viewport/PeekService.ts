import * as THREE from 'three';
import { subscribe } from 'valtio/vanilla';

import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { isPrefabInstanceRoot } from '@/features/scene/prefab-utils';
import { CanvasLayer2D, NodeBase, SceneManager } from '@pix3/runtime';

import { isPeekDimmed, PEEK_DIM_OPACITY, setPeekDimmed } from './peek-gating';
import { ViewportRendererService } from './ViewportRenderService';

/** How many chips the strip shows before the tail moves into the "+N" popover. */
export const PEEK_VISIBLE_CHIP_LIMIT = 8;

const STORAGE_PREFIX = 'pix3.peek.hidden:';

/**
 * One toggleable branch in the Peek strip.
 *
 * `nodeId` is the identity (stable in the `.pix3scene`, so a rename keeps the mask and a deletion
 * silently drops it); `label` is only what the chip says.
 */
export interface PeekBranch {
  readonly nodeId: string;
  readonly label: string;
  readonly type: string;
  readonly hidden: boolean;
  /**
   * The branch's own `visible: false` in the scene file.
   *
   * Not Peek's doing and not Peek's to undo — but a chip that showed an open eye over a branch the
   * viewport is not drawing would be the strip lying about what is on screen, which is the one
   * thing the strip exists to report. The chip renders it as off and says where to change it.
   */
  readonly authoredHidden: boolean;
  /** Faded by an active solo on some OTHER branch. */
  readonly dimmed: boolean;
  /** This branch is (one of) the soloed ones. */
  readonly soloed: boolean;
}

export interface PeekSnapshot {
  readonly branches: readonly PeekBranch[];
  readonly hiddenCount: number;
  readonly soloActive: boolean;
}

/** Receives the mask so a running play session can apply it to its own (cloned) graph. */
export type PeekRuntimeSink = (hiddenNodeIds: readonly string[]) => void;

/**
 * Editor Peek: a per-user, non-serializable "what I do not want to look at right now" mask.
 *
 * ## What it is not
 *
 * It is not `visible` (that is authored game state and goes into the file), not `editorOnly` (that
 * is about scene content, not about this session), and not `groups` (queries, no visibility
 * semantics). It never reaches a `.pix3scene`, an export, or another collaborator — see
 * `docs/pix3-specification.md`, "Editor Peek".
 *
 * ## Where the chips come from
 *
 * Phase 0 invents no taxonomy. The branches are derived from structure the scene already has:
 * top-level nodes, descending one level when there is a single root (the common case), plus any
 * prefab instance root or `CanvasLayer2D` met on those levels. A playable ad has three to five
 * obvious groups and they already ARE parent nodes; a second taxonomy layered over the tree is the
 * feature class Unreal shipped as its Layers panel and then abandoned.
 *
 * ## How it takes effect
 *
 * By stamping `hiddenByEditor` / `dimmedByEditor` on the branch ROOT only. `visible` is an accessor
 * that folds the first flag in, and three.js already skips a hidden subtree at render time — so the
 * cost is O(branches), not O(nodes), and every existing reader (proxy mirroring, picking,
 * `isVisibleInTree`, hence `UIControl2D`'s input gate) is covered for free.
 */
@injectable()
export class PeekService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  /**
   * The active graph, or null when there is no scene — including when the container this service
   * was resolved from has no viewport stack at all.
   *
   * Peek is read from surfaces that have nothing to do with the viewport (the agent's system
   * prompt, the export dialog), and those are also the surfaces exercised by unit tests with a
   * partial container. A missing SceneManager there means "no branches", never a thrown error out
   * of an unrelated feature — the same reasoning as `buildPeekExportWarning`'s own guard.
   */
  private get activeGraph(): ReturnType<SceneManager['getActiveSceneGraph']> | null {
    try {
      return this.sceneManager.getActiveSceneGraph();
    } catch {
      return null;
    }
  }

  /** Ask for a repaint, tolerating a container with no renderer (see {@link activeGraph}). */
  private requestRender(): void {
    try {
      this.viewportRenderer.requestRender();
    } catch {
      // No viewport in this container — nothing to repaint.
    }
  }

  /** Mirror one node's new effective visibility into the viewport, same tolerance as above. */
  private updateNodeVisibility(node: NodeBase): void {
    try {
      this.viewportRenderer.updateNodeVisibility(node);
    } catch {
      // No viewport in this container.
    }
  }

  /**
   * Where a solo returns to. Alt-clicking the soloed chip again restores the PREVIOUS set rather
   * than "show all" — the same affordance as alt-clicking an eye in Photoshop, and the reason solo
   * is not a one-way trip.
   */
  private readonly previousSoloByScene = new Map<string, string[]>();

  private runtimeSink: PeekRuntimeSink | null = null;

  private lastAppliedSceneId: string | null = null;

  /**
   * The nodes the last {@link applyToActiveGraph} actually put a flag on.
   *
   * Kept so a node that stops being a branch can be released — see that method for why a hidden
   * non-branch is a trap rather than a cosmetic issue. Strong references are fine and in fact
   * wanted: the list is rebuilt on every apply, and the whole point is to reach a node that has
   * dropped out of the derived set but is still in the graph.
   */
  private stampedNodes: NodeBase[] = [];

  private readonly listeners = new Set<() => void>();

  private readonly disposeSceneWatch: () => void;

  constructor() {
    // The active scene changing is the one event that must both restore that scene's persisted
    // mask and re-stamp the flags: the previous scene's nodes are gone and the new graph's are
    // freshly built with every flag at its default.
    this.disposeSceneWatch = subscribe(appState.scenes, () => this.onScenesChanged());
    this.onScenesChanged();
  }

  dispose(): void {
    this.disposeSceneWatch();
    this.listeners.clear();
    this.runtimeSink = null;
  }

  /** Notified whenever the mask or the derived branch list may have changed (for the UI strip). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Register the play session's runner so a live game follows the mask.
   *
   * Called with the current mask immediately: hiding the HUD to see the world underneath is the
   * whole point, and it has to work while the game is running. Pass `null` on teardown.
   */
  setRuntimeSink(sink: PeekRuntimeSink | null): void {
    this.runtimeSink = sink;
    sink?.(this.getHiddenNodeIds());
  }

  /** Node ids currently masked in the active scene. */
  getHiddenNodeIds(): readonly string[] {
    const sceneId = appState.scenes.activeSceneId;
    return sceneId ? (appState.scenes.peekHiddenByScene[sceneId] ?? []) : [];
  }

  private getSoloNodeIds(): readonly string[] {
    const sceneId = appState.scenes.activeSceneId;
    return sceneId ? (appState.scenes.peekSoloByScene[sceneId] ?? []) : [];
  }

  /** Everything the strip needs to render, in one read. */
  getSnapshot(): PeekSnapshot {
    const hidden = new Set(this.getHiddenNodeIds());
    const solo = new Set(this.getSoloNodeIds());
    const soloActive = solo.size > 0;
    const branches = this.deriveBranches().map<PeekBranch>(node => ({
      nodeId: node.nodeId,
      label: node.name || node.type,
      type: node.type,
      hidden: hidden.has(node.nodeId),
      authoredHidden: !node.authoredVisible,
      dimmed: soloActive && !solo.has(node.nodeId),
      soloed: solo.has(node.nodeId),
    }));
    return {
      branches,
      // Counted over the branches actually on screen, so a stale id left by a deleted node never
      // shows a count the user cannot clear.
      hiddenCount: branches.filter(branch => branch.hidden).length,
      soloActive,
    };
  }

  // -- derivation ------------------------------------------------------------

  /**
   * The branch roots the strip offers, in scene-tree order.
   *
   * Deliberately deterministic and cheap: called on every structural change and on every render of
   * the strip.
   */
  deriveBranches(): readonly NodeBase[] {
    const graph = this.activeGraph;
    if (!graph) {
      return [];
    }
    const roots = graph.rootNodes.filter((node): node is NodeBase => node instanceof NodeBase);

    // A single root is the common authored shape ("Main" wrapping everything), and offering one
    // chip that hides the entire scene is useless — so the level below it is the interesting one.
    const base =
      roots.length === 1
        ? roots[0].children.filter((child): child is NodeBase => child instanceof NodeBase)
        : roots;

    const branches: NodeBase[] = [];
    const seen = new Set<string>();
    const add = (node: NodeBase): void => {
      if (seen.has(node.nodeId)) {
        return;
      }
      seen.add(node.nodeId);
      branches.push(node);
    };

    for (const node of base) {
      add(node);
      // A prefab instance root or a CanvasLayer2D one level deeper is a group the author already
      // thinks of as a unit (an imported end card, a HUD band), so it earns its own chip even when
      // its parent has one.
      for (const child of node.children) {
        if (child instanceof NodeBase && this.isAlwaysABranch(child)) {
          add(child);
        }
      }
    }

    return branches;
  }

  private isAlwaysABranch(node: NodeBase): boolean {
    return node instanceof CanvasLayer2D || isPrefabInstanceRoot(node);
  }

  // -- mutation --------------------------------------------------------------

  /**
   * Replace the mask for the active scene.
   *
   * The single write path: it persists, re-stamps the graph, pushes to a running game and asks for
   * a frame. Called from `SetPeekVisibilityOperation`, never directly from UI.
   */
  setHiddenNodeIds(nodeIds: Iterable<string>): boolean {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return false;
    }
    const next = [...new Set(nodeIds)].sort();
    const current = appState.scenes.peekHiddenByScene[sceneId] ?? [];
    if (current.length === next.length && current.every((id, i) => id === next[i])) {
      return false;
    }
    appState.scenes.peekHiddenByScene[sceneId] = next;
    this.persist(sceneId, next);
    return this.applyToActiveGraph();
  }

  setSoloNodeIds(nodeIds: Iterable<string>): boolean {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return false;
    }
    const next = [...new Set(nodeIds)].sort();
    const current = appState.scenes.peekSoloByScene[sceneId] ?? [];
    if (current.length === next.length && current.every((id, i) => id === next[i])) {
      return false;
    }
    appState.scenes.peekSoloByScene[sceneId] = next;
    return this.applyToActiveGraph();
  }

  /**
   * Alt-click semantics: solo this branch, or — if it is already the only soloed one — go back to
   * whatever was soloed before.
   *
   * Not "show all" on the way back. Landing on "everything visible" would quietly discard a mask
   * the author had built up, which is the complaint Blender's solo-on-plain-click generated for
   * five major versions.
   */
  toggleSolo(nodeId: string): boolean {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return false;
    }
    const current = [...this.getSoloNodeIds()];
    const isOnlySoloed = current.length === 1 && current[0] === nodeId;
    if (isOnlySoloed) {
      const restored = this.setSoloNodeIds(this.previousSoloByScene.get(sceneId) ?? []);
      this.previousSoloByScene.delete(sceneId);
      return restored;
    }
    this.previousSoloByScene.set(sceneId, current);
    return this.setSoloNodeIds([nodeId]);
  }

  /** The exit from every masked state — what the "N hidden" pill's button calls. */
  showAll(): boolean {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return false;
    }
    this.previousSoloByScene.delete(sceneId);
    // Both halves, and neither short-circuits the other: `setHiddenNodeIds` returns false when the
    // hidden mask was already empty, and the solo may still need clearing (or vice versa).
    const soloCleared = this.setSoloNodeIds([]);
    const hiddenCleared = this.setHiddenNodeIds([]);
    return soloCleared || hiddenCleared;
  }

  // -- application -----------------------------------------------------------

  /**
   * Stamp the mask onto the active graph's branch roots and report whether anything moved.
   *
   * Two things about the bookkeeping are load-bearing:
   *
   * - **The flags are always compared against the live nodes**, never against a cached description
   *   of the mask. `appState.scenes` is a busy proxy and this service is subscribed to all of it,
   *   so a cheap early-out is needed — but an early-out keyed on *ids* is a bug, because every path
   *   that swaps the active graph for a re-parsed one with the SAME ids hands back fresh nodes
   *   whose flags are all default: a remote collab update (`SceneCRDTBinding.setActiveSceneGraph`),
   *   a prefab refresh, a scene reload. Those would leave the chips claiming a mask the graph no
   *   longer has. Re-deriving and diffing is O(branches) — a handful of nodes — so it is simply not
   *   worth guarding against.
   * - **Nodes that stopped being branches get cleared.** The branch set moves under the mask's feet
   *   (adding a second top-level node switches derivation from "children of the single root" to
   *   "the roots"), and a hidden node that is no longer a branch would have no chip, no place in
   *   `hiddenCount`, no pill and no reachable "Show all" — invisible with no way back. The ids stay
   *   in the persisted mask, so a structure that changes back re-applies it; only the flag is
   *   released.
   *
   * Ends with `requestRender()` when something changed: flipping a flag on a three.js object is not
   * itself a dirty-marker, and without it the change would wait for the ≤500 ms idle heartbeat and
   * read as lag (see CLAUDE.md, "Editor viewport renders on demand").
   */
  applyToActiveGraph(): boolean {
    const hidden = new Set(this.getHiddenNodeIds());
    const solo = new Set(this.getSoloNodeIds());
    const soloActive = solo.size > 0;
    const branches = this.deriveBranches();
    const branchIds = new Set(branches.map(node => node.nodeId));
    let changed = false;

    // Release nodes that were stamped by a previous apply but are not branches any more.
    for (const stale of this.stampedNodes) {
      if (branchIds.has(stale.nodeId)) {
        continue;
      }
      if (stale.hiddenByEditor || isPeekDimmed(stale)) {
        stale.hiddenByEditor = false;
        setPeekDimmed(stale, false);
        this.updateNodeVisibility(stale);
        changed = true;
      }
    }
    this.stampedNodes = [];

    for (const node of branches) {
      const nextHidden = hidden.has(node.nodeId);
      const nextDimmed = soloActive && !solo.has(node.nodeId);
      if (nextHidden || nextDimmed) {
        this.stampedNodes.push(node);
      }
      if (node.hiddenByEditor === nextHidden && isPeekDimmed(node) === nextDimmed) {
        continue;
      }
      node.hiddenByEditor = nextHidden;
      setPeekDimmed(node, nextDimmed);
      changed = true;
      // The same call the scene tree's eye makes. Two things need it beyond the flag itself: the
      // 2D proxy visual root has to mirror the new value NOW rather than at whatever later pass
      // happens to sync it, and the selection adornments have to be rebuilt — they are gated on
      // visibility but only recomputed when the SELECTION changes, so masking a branch that
      // contains the selected node used to leave its frame floating over an empty viewport
      // (observed in the running editor).
      this.updateNodeVisibility(node);
    }

    // Always reconciled, not only on `changed`: a swapped graph brings new material instances that
    // need the fade even though the mask itself did not move.
    changed = this.applyDimTo3DMaterials(branches) || changed;

    if (!changed) {
      return false;
    }
    this.runtimeSink?.([...hidden]);
    this.requestRender();
    for (const listener of this.listeners) {
      listener();
    }
    return true;
  }

  /**
   * The 3D half of the solo fade.
   *
   * 2D nodes get it for free — the editor draws proxy visuals and
   * `Viewport2DProxyRegistry.apply2DVisualMaterialState` recomputes their opacity from
   * `isDimmedInTree()` on every sync. 3D nodes in the editor viewport are the REAL runtime nodes
   * with the real materials, so there is no proxy to fade and the material has to be written
   * directly — hence the save/restore map. `Node3D` applies its own `opacity` only on change (not
   * per frame), so the two do not fight; an `opacity` edit made DURING a solo wins until the solo
   * is toggled, which is a fair trade for not adding an editor concern to the runtime node.
   */
  private applyDimTo3DMaterials(branches: readonly NodeBase[]): boolean {
    const shouldDim = new Set<THREE.Material>();
    const mustStayBright = new Set<THREE.Material>();
    for (const branch of branches) {
      const target = isPeekDimmed(branch) ? shouldDim : mustStayBright;
      branch.traverse(object => {
        for (const material of materialsOf(object)) {
          target.add(material);
        }
      });
    }
    // A material shared between a faded branch and a bright one (a GLTF material reused across
    // instances, a `MeshInstance` pointing at the same one) has no per-branch opacity to give, so
    // fading it would fade the very branch the author soloed. Bright wins: a solo that fails to
    // fade something is a weaker failure than a solo that fades its own subject.
    for (const material of mustStayBright) {
      shouldDim.delete(material);
    }

    let changed = false;
    for (const material of shouldDim) {
      if (this.fadedMaterials.has(material)) {
        continue;
      }
      const faded = material.opacity * PEEK_DIM_OPACITY;
      this.fadedMaterials.set(material, {
        opacity: material.opacity,
        transparent: material.transparent,
        applied: faded,
      });
      material.opacity = faded;
      material.transparent = true;
      material.needsUpdate = true;
      changed = true;
    }

    for (const [material, saved] of [...this.fadedMaterials]) {
      if (shouldDim.has(material)) {
        continue;
      }
      this.fadedMaterials.delete(material);
      // Restore ONLY if the value is still the one we wrote. `Node3D` re-applies its own `opacity`
      // to its materials whenever that property changes (and when an async GLTF registers a new
      // one), so an opacity edit made DURING a solo takes ownership of the material — writing our
      // pre-solo snapshot back over it would silently revert the author's edit.
      if (material.opacity !== saved.applied) {
        continue;
      }
      material.opacity = saved.opacity;
      material.transparent = saved.transparent;
      material.needsUpdate = true;
      changed = true;
    }
    return changed;
  }

  /**
   * Materials the 3D fade has written: the values to put back, plus the value we wrote (so the
   * restore can tell whether anyone has taken the material over since).
   */
  private readonly fadedMaterials = new Map<
    THREE.Material,
    { opacity: number; transparent: boolean; applied: number }
  >();

  // -- persistence -----------------------------------------------------------

  /**
   * Mirrored to `localStorage` keyed by the scene's file path, not to the scene file.
   *
   * Unity keeps its per-user mask in `Library/SceneVisibilityState.asset` for exactly this reason.
   * A purely session-local mask makes the author re-hide everything after each reload; a mask in the
   * scene file travels to collaborators and to the build, which is the failure mode this feature
   * exists to avoid.
   */
  private persist(sceneId: string, nodeIds: readonly string[]): void {
    const key = this.storageKey(sceneId);
    if (!key) {
      return;
    }
    try {
      if (nodeIds.length === 0) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(nodeIds));
      }
    } catch {
      // Private windows and blocked site data throw. A mask that does not survive a reload is a
      // lesser problem than an editor that cannot hide anything.
    }
  }

  private restore(sceneId: string): string[] {
    const key = this.storageKey(sceneId);
    if (!key) {
      return [];
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Keyed by PROJECT + file path: the mask follows the scene rather than the session's scene-id
   * assignment, and it stops at the project boundary.
   *
   * The path alone was not enough, and the failure was silent. Every template project puts its scene
   * at `scenes/main.pix3scene`, so one key — `pix3.peek.hidden:res://scenes/main.pix3scene` — was
   * shared by all of them: hiding the HUD once, in one project, hid the HUD in every project created
   * afterwards. Measured: three freshly generated prototypes in a row came up with no score, no
   * timer and no lives bar on the stage, all three scenes containing those nodes, because a mask
   * left over from an unrelated project was still being applied. A project with no id (nothing
   * open) persists nothing rather than falling back to the shared key.
   */
  private storageKey(sceneId: string): string | null {
    const filePath = appState.scenes.descriptors[sceneId]?.filePath;
    const projectId = appState.project.id;
    return filePath && projectId ? `${STORAGE_PREFIX}${projectId}:${filePath}` : null;
  }

  /**
   * React to a scene switch or a structural mutation.
   *
   * Two different jobs share this callback because they share the trigger: a NEW active scene needs
   * its persisted mask read back, and any structural change needs the flags re-stamped (a node that
   * was just re-parented or replaced carries default flags).
   */
  private onScenesChanged(): void {
    const sceneId = appState.scenes.activeSceneId;
    if (sceneId !== this.lastAppliedSceneId) {
      this.lastAppliedSceneId = sceneId;
      if (sceneId && appState.scenes.peekHiddenByScene[sceneId] === undefined) {
        // A direct `appState` write outside the Command→Operation gateway. Legitimate under
        // AGENTS.md's "gateway scope" carve-out: this is session/infrastructure state hydrated by
        // its owning service (from localStorage), not document state — nothing here is undoable or
        // saveable. Every USER-driven change still goes through `SetPeekVisibilityOperation`.
        appState.scenes.peekHiddenByScene[sceneId] = this.restore(sceneId);
      }
    }
    if (sceneId) {
      this.applyToActiveGraph();
    }
  }
}

/** Every material hanging off one three.js object, flattening the array-material case. */
const materialsOf = (object: THREE.Object3D): readonly THREE.Material[] => {
  if (
    !(
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points ||
      object instanceof THREE.Sprite
    )
  ) {
    return [];
  }
  const material: THREE.Material | THREE.Material[] = object.material;
  return Array.isArray(material) ? material : [material];
};
