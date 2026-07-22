import { injectable, ServiceContainer } from '@/fw/di';
import { CollaborationService, type CollabUserInfo } from '@/services/collab/CollaborationService';
import {
  Scene,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  LineBasicMaterial,
  EdgesGeometry,
  LineSegments,
  BoxGeometry,
  type Object3D,
} from 'three';
import { SceneManager } from '@pix3/runtime';

interface RemoteUserOverlay {
  clientId: number;
  name: string;
  color: string;
  cursorSprite: Sprite | null;
  selectionOutlines: Map<string, LineSegments>;
}

@injectable()
export class CollabViewportOverlayService {
  private overlays = new Map<number, RemoteUserOverlay>();
  private overlayScene: Scene | null = null;
  private awarenessHandler: (() => void) | null = null;
  private animationFrameId: number | null = null;

  /**
   * Initialize the overlay scene. Call once when the viewport is ready.
   */
  initialize(overlayScene: Scene): void {
    this.overlayScene = overlayScene;
    this.startAwarenessSync();
  }

  private startAwarenessSync(): void {
    try {
      const container = ServiceContainer.getInstance();
      const collabService = container.getService<CollaborationService>(
        container.getOrCreateToken(CollaborationService)
      );

      const awareness = collabService.getAwareness();
      if (!awareness) return;

      this.awarenessHandler = () => {
        this.syncFromAwareness();
      };
      awareness.on('change', this.awarenessHandler);
    } catch {
      // CollaborationService not registered
    }
  }

  private syncFromAwareness(): void {
    try {
      const container = ServiceContainer.getInstance();
      const collabService = container.getService<CollaborationService>(
        container.getOrCreateToken(CollaborationService)
      );

      const awareness = collabService.getAwareness();
      if (!awareness || !this.overlayScene) return;

      const localClientId = awareness.clientID;
      const activeRemoteIds = new Set<number>();

      awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
        if (clientId === localClientId) return;

        const user = state.user as CollabUserInfo | undefined;
        if (!user?.name) return;

        activeRemoteIds.add(clientId);

        let overlay = this.overlays.get(clientId);
        if (!overlay) {
          overlay = {
            clientId,
            name: user.name,
            color: user.color,
            cursorSprite: null,
            selectionOutlines: new Map(),
          };
          this.overlays.set(clientId, overlay);
        }

        // Update 3D cursor
        if (user.cursor3d) {
          if (!overlay.cursorSprite) {
            overlay.cursorSprite = this.createCursorSprite(user.name, user.color);
            this.overlayScene!.add(overlay.cursorSprite);
          }
          overlay.cursorSprite.position.set(user.cursor3d.x, user.cursor3d.y, user.cursor3d.z);
          overlay.cursorSprite.visible = true;
        } else if (overlay.cursorSprite) {
          overlay.cursorSprite.visible = false;
        }

        // Update selection outlines
        this.updateSelectionOutlines(overlay, user);
      });

      // Remove overlays for disconnected users
      for (const [clientId, overlay] of this.overlays) {
        if (!activeRemoteIds.has(clientId)) {
          this.removeOverlay(overlay);
          this.overlays.delete(clientId);
        }
      }
    } catch {
      // Service not available
    }
  }

  private updateSelectionOutlines(overlay: RemoteUserOverlay, user: CollabUserInfo): void {
    const selectedSet = new Set(user.selection);

    // Remove outlines for deselected nodes
    for (const [nodeId, outline] of overlay.selectionOutlines) {
      if (!selectedSet.has(nodeId)) {
        this.overlayScene?.remove(outline);
        outline.geometry.dispose();
        (outline.material as LineBasicMaterial).dispose();
        overlay.selectionOutlines.delete(nodeId);
      }
    }

    // Add outlines for newly selected nodes
    try {
      const container = ServiceContainer.getInstance();
      const sceneManager = container.getService<SceneManager>(
        container.getOrCreateToken(SceneManager)
      );
      const sceneGraph = sceneManager.getActiveSceneGraph();
      if (!sceneGraph) return;

      for (const nodeId of user.selection) {
        if (overlay.selectionOutlines.has(nodeId)) continue;

        const node = sceneGraph.nodeMap.get(nodeId) as Object3D | undefined;
        if (!node) continue;

        const outline = this.createSelectionOutline(node, overlay.color);
        if (outline) {
          this.overlayScene?.add(outline);
          overlay.selectionOutlines.set(nodeId, outline);
        }
      }
    } catch {
      // Scene/service not available
    }
  }

  private createCursorSprite(name: string, color: string): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext('2d')!;

    // Draw colored dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(12, 24, 6, 0, Math.PI * 2);
    ctx.fill();

    // Draw name
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px sans-serif';
    ctx.fillText(name, 24, 28);

    const texture = new CanvasTexture(canvas);
    const material = new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new Sprite(material);
    sprite.scale.set(2, 0.75, 1);
    sprite.renderOrder = 9999;
    return sprite;
  }

  private createSelectionOutline(object3d: Object3D, color: string): LineSegments | null {
    // Use a simple box edges geometry for the outline
    const geometry = new EdgesGeometry(new BoxGeometry(1, 1, 1));
    const material = new LineBasicMaterial({
      color,
      linewidth: 2,
      depthTest: false,
    });
    const outline = new LineSegments(geometry, material);
    outline.renderOrder = 9998;

    // Position at the object's world position
    object3d.getWorldPosition(outline.position);
    outline.scale.copy(object3d.scale);
    outline.rotation.copy(object3d.rotation);

    return outline;
  }

  private removeOverlay(overlay: RemoteUserOverlay): void {
    if (overlay.cursorSprite) {
      this.overlayScene?.remove(overlay.cursorSprite);
      (overlay.cursorSprite.material as SpriteMaterial).map?.dispose();
      (overlay.cursorSprite.material as SpriteMaterial).dispose();
    }
    for (const [, outline] of overlay.selectionOutlines) {
      this.overlayScene?.remove(outline);
      outline.geometry.dispose();
      (outline.material as LineBasicMaterial).dispose();
    }
  }

  dispose(): void {
    // Clean up awareness listener
    if (this.awarenessHandler) {
      try {
        const container = ServiceContainer.getInstance();
        const collabService = container.getService<CollaborationService>(
          container.getOrCreateToken(CollaborationService)
        );
        const awareness = collabService.getAwareness();
        awareness?.off('change', this.awarenessHandler);
      } catch {
        // Service not available
      }
      this.awarenessHandler = null;
    }

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Clean up all overlays
    for (const overlay of this.overlays.values()) {
      this.removeOverlay(overlay);
    }
    this.overlays.clear();
    this.overlayScene = null;
  }
}
