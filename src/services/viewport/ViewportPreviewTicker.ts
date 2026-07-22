import * as THREE from 'three';
import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { Particles3D } from '@pix3/runtime';
import type {
  AssetLoader,
  EditorAppearanceOverride,
  EditorPreviewContext,
  SceneGraph,
  ScriptComponent,
} from '@pix3/runtime';
import { applyTextureRegionToTexture, describeThrown, reportScriptError } from '@pix3/runtime';
import { appState } from '@/state';

/**
 * Dependencies the preview ticker borrows from {@link ViewportRendererService}.
 * Scoped to exactly what this collaborator needs; the facade owns the scene
 * graph, node lookups, the 2D visual proxies, the asset loader, and the render
 * request path, and passes them in via closures so the ticker never reaches
 * back into the facade directly.
 */
export interface ViewportPreviewTickerDeps {
  getActiveSceneGraph(): SceneGraph | null;
  findNodeById(nodeId: string, nodes: NodeBase[]): NodeBase | null;
  get2DVisualRoot(nodeId: string): THREE.Group | undefined;
  getAssetLoader(): AssetLoader;
  requestRender(): void;
}

/**
 * Owns the editor-only "keep rendering while a preview animates" tickers for
 * particle previews and script-component editor previews, plus the transient
 * appearance overrides those components push. Extracted from
 * ViewportRendererService (decomposition step 5/13). Not `@injectable()` — it is
 * an owned collaborator constructed by the facade with borrowed dependencies.
 */
export class ViewportPreviewTicker {
  private activeParticlePreviewCount = 0;
  private activeComponentPreviewCount = 0;

  /**
   * Editor appearance overrides a script pushed via `setAppearanceOverride`,
   * keyed by nodeId. `stamp` is the preview frame it was last pushed on;
   * anything not re-pushed on the current frame is reverted and dropped. This is
   * transient editor-only presentation state — never serialized, never in undo.
   */
  private readonly componentAppearanceOverrides = new Map<
    string,
    { override: EditorAppearanceOverride; stamp: number }
  >();
  private previewFrameStamp = 0;

  constructor(private readonly deps: ViewportPreviewTickerDeps) {}

  tickParticles(dt: number): void {
    if (appState.ui.isPlaying) {
      this.activeParticlePreviewCount = 0;
      return;
    }

    if (dt <= 0) {
      return;
    }

    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      this.activeParticlePreviewCount = 0;
      return;
    }

    let active = 0;
    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node instanceof Particles3D && node.preview) {
          node.tick(dt);
          active += 1;
        }

        if (node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
    this.activeParticlePreviewCount = active;
  }

  tickComponents(dt: number): void {
    if (appState.ui.isPlaying) {
      this.activeComponentPreviewCount = 0;
      // Play mode owns rendering; drop any editor-preview overrides so the
      // proxies (if still around) revert, and re-apply cleanly on return.
      this.clearComponentAppearanceOverrides();
      return;
    }

    if (dt <= 0) {
      return;
    }

    const sceneGraph = this.deps.getActiveSceneGraph();
    if (!sceneGraph) {
      this.activeComponentPreviewCount = 0;
      this.clearComponentAppearanceOverrides();
      return;
    }

    this.previewFrameStamp += 1;
    const frameStamp = this.previewFrameStamp;

    let active = 0;
    const visit = (nodes: NodeBase[]) => {
      for (const node of nodes) {
        if (node.components && Array.isArray(node.components) && node.components.length > 0) {
          // Per-node context: setAppearanceOverride records against this nodeId,
          // last writer per frame wins.
          const context: EditorPreviewContext = {
            assetLoader: this.deps.getAssetLoader(),
            requestRender: () => {
              queueMicrotask(() => this.deps.requestRender());
            },
            setAppearanceOverride: (override: EditorAppearanceOverride) => {
              this.componentAppearanceOverrides.set(node.nodeId, { override, stamp: frameStamp });
            },
          };
          for (const component of node.components) {
            if (component.enabled && typeof component.tickEditorPreview === 'function') {
              active += 1;
            }
            this.tickPreviewComponent(node, component, dt, context);
          }
        }

        if (node.children && node.children.length > 0) {
          visit(node.children);
        }
      }
    };

    visit(sceneGraph.rootNodes);
    this.activeComponentPreviewCount = active;
    this.flushComponentAppearanceOverrides(sceneGraph, frameStamp);
  }

  /**
   * True while a particle or script-component editor preview is animating and
   * therefore needs a fresh frame every tick. The counts are refreshed by their
   * tickers on every rendered frame.
   */
  hasActivePreview(): boolean {
    return this.activeParticlePreviewCount > 0 || this.activeComponentPreviewCount > 0;
  }

  /**
   * True when a live script appearance override is currently active for the
   * given node. Callers rebuilding a proxy's texture use this to avoid fighting
   * an override that will be re-applied on top each preview frame
   * ({@link flushComponentAppearanceOverrides}).
   */
  hasOverride(nodeId: string): boolean {
    return this.componentAppearanceOverrides.has(nodeId);
  }

  /**
   * Raw clear of the appearance-override map with NO per-node revert, for
   * teardown call sites (scene rebuild, dispose) where the proxies are already
   * being destroyed — reverting their visuals first would be wasted work on
   * soon-to-be-discarded objects. Use {@link clearComponentAppearanceOverrides}
   * when the proxies must actually revert.
   */
  resetOverrides(): void {
    this.componentAppearanceOverrides.clear();
  }

  private tickPreviewComponent(
    node: NodeBase,
    component: ScriptComponent,
    dt: number,
    context: EditorPreviewContext
  ): void {
    if (!component.enabled || !component.tickEditorPreview) {
      return;
    }

    // Error isolation: a throwing tickEditorPreview must not kill the frame or
    // the editor. Disable the component and surface the failure the same way the
    // runtime does for play-mode hooks (Logs panel / Game tab).
    try {
      component.tickEditorPreview(dt, context);
    } catch (thrown) {
      component.enabled = false;
      const { message, stack } = describeThrown(thrown);
      console.error(
        `[ViewportRenderService] Script "${component.type}" threw in editor-preview on node "${node.name}" (disabled):`,
        thrown
      );
      reportScriptError({
        phase: 'update',
        message,
        stack,
        nodeId: node.nodeId,
        nodeName: node.name,
        componentType: component.type,
        componentId: component.id,
      });
    }
  }

  /**
   * Apply the appearance overrides pushed this preview frame to their proxies,
   * and revert + drop any that were not re-pushed (immediate-mode lifecycle).
   */
  private flushComponentAppearanceOverrides(sceneGraph: SceneGraph, frameStamp: number): void {
    if (this.componentAppearanceOverrides.size === 0) {
      return;
    }

    for (const [nodeId, entry] of this.componentAppearanceOverrides) {
      const node = this.deps.findNodeById(nodeId, sceneGraph.rootNodes);
      if (entry.stamp === frameStamp) {
        if (node) {
          this.applyAppearanceOverrideToProxy(node, entry.override);
        }
      } else {
        if (node) {
          this.applyAppearanceOverrideToProxy(node, null);
        }
        this.componentAppearanceOverrides.delete(nodeId);
      }
    }
  }

  /** Revert every active appearance override and clear the map. */
  private clearComponentAppearanceOverrides(): void {
    if (this.componentAppearanceOverrides.size === 0) {
      return;
    }
    const sceneGraph = this.deps.getActiveSceneGraph();
    for (const [nodeId] of this.componentAppearanceOverrides) {
      const node = sceneGraph ? this.deps.findNodeById(nodeId, sceneGraph.rootNodes) : null;
      if (node) {
        this.applyAppearanceOverrideToProxy(node, null);
      }
    }
    this.componentAppearanceOverrides.clear();
  }

  /**
   * Apply (or, when `override` is null, revert) a script-driven editor
   * appearance override on a node's proxy visual. v1 supports Sprite2D proxies;
   * `tint`/`visible` apply to any proxy with a root group and MeshBasicMaterial.
   */
  private applyAppearanceOverrideToProxy(
    node: NodeBase,
    override: EditorAppearanceOverride | null
  ): void {
    const visualRoot = this.deps.get2DVisualRoot(node.nodeId);
    if (!visualRoot) {
      return;
    }

    // Visibility: fall back to the node's own visibility when not overridden.
    const nodeVisible = node instanceof Node2D ? node.visible : true;
    visualRoot.visible = override?.visible ?? nodeVisible;

    const mesh = visualRoot.userData.spriteMesh as THREE.Mesh | undefined;
    const material =
      mesh && mesh.material instanceof THREE.MeshBasicMaterial ? mesh.material : undefined;
    if (!material) {
      return;
    }

    // Texture region (Sprite2D): override wins, else the node's own transient
    // region, else the full texture.
    if (material.map) {
      const nodeRegion = node instanceof Sprite2D ? (node.textureRegion ?? null) : null;
      applyTextureRegionToTexture(material.map, override?.textureRegion ?? nodeRegion);
    }

    // Tint: override color, else restore the material's authored base color
    // (white when a texture is present, the placeholder grey otherwise).
    if (override?.tint) {
      material.color.set(override.tint);
    } else {
      material.color.set(material.map ? 0xffffff : 0xcccccc);
    }
  }
}
