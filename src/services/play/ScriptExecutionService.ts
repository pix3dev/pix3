/**
 * ScriptExecutionService - Manages script execution lifecycle
 *
 * This service runs a requestAnimationFrame loop that calls tick() on all root nodes
 * in the active scene, managing the script lifecycle (onStart, onUpdate, onDetach).
 */

import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import {
  SceneManager,
  type SceneGraph,
  InputService,
  MeshInstance,
  AudioService,
} from '@pix3/runtime';
import { NodeBase } from '@pix3/runtime';
import { AutoloadService } from '@/services/project/AutoloadService';
import { isDocumentActive } from '@/services/core/page-activity';

interface NodeStateSnapshot {
  nodeId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  visible: boolean;
}

@injectable()
export class ScriptExecutionService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(InputService)
  private readonly input!: InputService;

  @inject(AutoloadService)
  private readonly autoloadService!: AutoloadService;

  @inject(AudioService)
  private readonly audioService!: AudioService;

  private animationFrameId: number | null = null;
  private lastTimestamp: number = 0;
  private isRunning: boolean = false;
  private isPageActive: boolean = isDocumentActive(document);
  private currentSceneId: string | null = null;
  private nodeStateSnapshots: Map<string, NodeStateSnapshot[]> = new Map();
  private readonly handlePageActivityEvent = (): void => {
    this.updatePageActivity();
  };

  constructor() {
    window.addEventListener('focus', this.handlePageActivityEvent);
    window.addEventListener('blur', this.handlePageActivityEvent);
    window.addEventListener('pageshow', this.handlePageActivityEvent);
    window.addEventListener('pagehide', this.handlePageActivityEvent);
    document.addEventListener('visibilitychange', this.handlePageActivityEvent);
  }

  /**
   * Start the script execution loop
   */
  start(): void {
    if (this.isRunning) {
      console.warn('[ScriptExecutionService] Already running');
      return;
    }

    this.isRunning = true;
    this.lastTimestamp = performance.now();

    const scene = this.sceneManager.getActiveSceneGraph();
    if (scene) {
      this.captureNodeState(scene);
    }

    this.startAutoloadScripts();
    this.handlePageActivityChange();

    console.log('[ScriptExecutionService] Started script execution loop');
  }

  /**
   * Stop the script execution loop and detach all scripts
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    const scene = this.sceneManager.getActiveSceneGraph();
    if (scene) {
      this.restoreNodeState(scene);
      this.resetMeshInstanceAnimations(scene);
    }

    this.nodeStateSnapshots.delete(this.getSnapshotKey(this.currentSceneId));

    // Stop all audio when exiting play mode
    this.audioService.stopAll();

    // Detach all scripts from current scene
    this.detachScriptsFromScene();

    console.log('[ScriptExecutionService] Stopped script execution loop');
  }

  /**
   * Notify that the scene has changed - detach old scripts and prepare for new scene
   */
  onSceneChanged(newSceneId: string | null): void {
    if (this.currentSceneId === newSceneId) {
      return;
    }

    // Detach scripts from previous scene
    if (this.currentSceneId !== null) {
      this.detachScriptsFromScene();
    }

    this.currentSceneId = newSceneId;

    // Attach scripts to new scene
    if (newSceneId !== null) {
      this.attachScriptsToScene(newSceneId);
    }

    console.log('[ScriptExecutionService] Scene changed to:', newSceneId);
  }

  /**
   * Schedule the next animation frame
   */
  private scheduleNextFrame(): void {
    if (!this.isRunning || this.shouldPauseForBackgroundWork()) {
      return;
    }

    this.animationFrameId = requestAnimationFrame(timestamp => {
      this.tick(timestamp);
    });
  }

  /**
   * Main tick method called every frame
   */
  private tick(timestamp: number): void {
    if (!this.isRunning || this.shouldPauseForBackgroundWork()) {
      this.animationFrameId = null;
      return;
    }

    const input = this.getInputServiceSafe();
    if (!input) {
      return;
    }

    // Reset input state for the new frame
    input.beginFrame();

    // Calculate delta time in seconds
    const dt = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;

    const autoloadService = this.getAutoloadServiceSafe();
    if (autoloadService) {
      const globalRoot = autoloadService.getGlobalRoot();
      if (!globalRoot.input) {
        globalRoot.input = input;
      }
      globalRoot.tick(dt);
    }

    // Get active scene
    const scene = this.sceneManager.getActiveSceneGraph();
    if (scene) {
      for (const rootNode of scene.rootNodes) {
        if (!rootNode.input) {
          rootNode.input = this.input;
        }
        try {
          rootNode.tick(dt);
        } catch (err) {
          console.error(`[ScriptExecutionService] Error ticking node "${rootNode.name}":`, err);
        }
      }
    }

    // Schedule next frame
    this.scheduleNextFrame();
  }

  /**
   * Attach scripts to all nodes in the scene (call onAttach)
   */
  private attachScriptsToScene(sceneId: string): void {
    const scene = this.sceneManager.getSceneGraph(sceneId);
    if (!scene) {
      return;
    }

    for (const rootNode of scene.rootNodes) {
      this.attachScriptsToNode(rootNode);
    }
  }

  /**
   * Recursively attach scripts to a node and its children
   */
  private attachScriptsToNode(node: NodeBase): void {
    // Attach unified script components
    if (node.components && Array.isArray(node.components)) {
      for (const component of node.components) {
        component.node = node;
        if (component.onAttach) {
          component.onAttach(node);
        }
      }
    }

    // Recursively attach to children
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          this.attachScriptsToNode(child);
        }
      }
    }
  }

  /**
   * Detach scripts from all nodes in the current scene (call onDetach)
   */
  private detachScriptsFromScene(): void {
    const scene = this.currentSceneId
      ? this.sceneManager.getSceneGraph(this.currentSceneId)
      : this.sceneManager.getActiveSceneGraph();
    if (!scene) {
      return;
    }

    if (scene.rootNodes && Array.isArray(scene.rootNodes)) {
      for (const rootNode of scene.rootNodes) {
        this.detachScriptsFromNode(rootNode);
      }

      for (const rootNode of scene.rootNodes) {
        this.resetScriptStartedState(rootNode);
      }
    }
  }

  /**
   * Recursively detach scripts from a node and its children
   */
  private detachScriptsFromNode(node: NodeBase): void {
    if (node.components && Array.isArray(node.components)) {
      for (const component of node.components) {
        if (component.onDetach) {
          try {
            component.onDetach();
          } catch (error) {
            console.error('[ScriptExecutionService] Component onDetach failed', {
              componentId: component.id,
              nodeId: node.nodeId,
              error,
            });
          }
        }
      }
    }

    // Recursively detach from children
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          this.detachScriptsFromNode(child);
        }
      }
    }
  }

  /**
   * Recursively reset started state for all scripts in a node and its children
   */
  private resetScriptStartedState(node: NodeBase): void {
    if (node.components && Array.isArray(node.components)) {
      for (const component of node.components) {
        if (component.resetStartedState) {
          component.resetStartedState();
        } else {
          component._started = false;
        }
      }
    }

    // Recursively reset children
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child instanceof NodeBase) {
          this.resetScriptStartedState(child);
        }
      }
    }
  }

  /**
   * Reset all MeshInstance animations to their default pose (t=0) in the scene.
   * Called after stopping play mode so the viewport shows the correct initial frame.
   */
  private resetMeshInstanceAnimations(scene: SceneGraph): void {
    for (const rootNode of scene.rootNodes) {
      this.resetMeshInstanceAnimationsRecursive(rootNode);
    }
  }

  private resetMeshInstanceAnimationsRecursive(node: NodeBase): void {
    if (node instanceof MeshInstance) {
      node.showDefaultPose();
    }
    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.resetMeshInstanceAnimationsRecursive(child);
      }
    }
  }

  /**
   * Dispose the service
   */
  dispose(): void {
    this.stop();
    window.removeEventListener('focus', this.handlePageActivityEvent);
    window.removeEventListener('blur', this.handlePageActivityEvent);
    window.removeEventListener('pageshow', this.handlePageActivityEvent);
    window.removeEventListener('pagehide', this.handlePageActivityEvent);
    document.removeEventListener('visibilitychange', this.handlePageActivityEvent);
  }

  private updatePageActivity(): void {
    this.isPageActive = isDocumentActive(document);
    this.handlePageActivityChange();
  }

  private handlePageActivityChange(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.shouldPauseForBackgroundWork()) {
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      return;
    }

    this.lastTimestamp = performance.now();
    if (this.animationFrameId === null) {
      this.scheduleNextFrame();
    }
  }

  private shouldPauseForBackgroundWork(): boolean {
    return appState.ui.pauseRenderingOnUnfocus && !this.isPageActive;
  }

  /**
   * Capture the current state of all nodes in the scene
   */
  private captureNodeState(scene: SceneGraph): void {
    const snapshots: NodeStateSnapshot[] = [];

    for (const rootNode of scene.rootNodes) {
      this.captureNodeStateRecursive(rootNode, snapshots);
    }

    this.nodeStateSnapshots.set(this.getSnapshotKey(this.currentSceneId), snapshots);
    console.debug('[ScriptExecutionService] Captured state for', snapshots.length, 'nodes');
  }

  /**
   * Recursively capture state of a node and its children
   */
  private captureNodeStateRecursive(node: NodeBase, snapshots: NodeStateSnapshot[]): void {
    const snapshot: NodeStateSnapshot = {
      nodeId: node.nodeId,
      position: { x: node.position.x, y: node.position.y, z: node.position.z },
      rotation: { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z },
      scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
      visible: node.visible,
    };
    snapshots.push(snapshot);

    for (const child of node.children) {
      if (child instanceof NodeBase) {
        this.captureNodeStateRecursive(child, snapshots);
      }
    }
  }

  /**
   * Restore the captured state of all nodes in the scene
   */
  private restoreNodeState(scene: SceneGraph): void {
    const sceneId = this.getSnapshotKey(this.currentSceneId);
    const snapshots = this.nodeStateSnapshots.get(sceneId);

    if (!snapshots) {
      console.warn('[ScriptExecutionService] No state snapshots found for scene:', sceneId);
      return;
    }

    const snapshotMap = new Map(snapshots.map(s => [s.nodeId, s]));
    let restoredCount = 0;

    for (const rootNode of scene.rootNodes) {
      restoredCount += this.restoreNodeStateRecursive(rootNode, snapshotMap);
    }

    console.debug('[ScriptExecutionService] Restored state for', restoredCount, 'nodes');
  }

  /**
   * Recursively restore state of a node and its children
   */
  private restoreNodeStateRecursive(
    node: NodeBase,
    snapshotMap: Map<string, NodeStateSnapshot>
  ): number {
    const snapshot = snapshotMap.get(node.nodeId);
    let restoredCount = 0;

    if (snapshot) {
      node.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      node.rotation.set(snapshot.rotation.x, snapshot.rotation.y, snapshot.rotation.z);
      node.scale.set(snapshot.scale.x, snapshot.scale.y, snapshot.scale.z);
      node.visible = snapshot.visible;
      node.updateMatrix();
      restoredCount = 1;
    }

    for (const child of node.children) {
      if (child instanceof NodeBase) {
        restoredCount += this.restoreNodeStateRecursive(child, snapshotMap);
      }
    }

    return restoredCount;
  }

  private getSnapshotKey(sceneId: string | null): string {
    return sceneId ?? '__active_scene__';
  }

  private startAutoloadScripts(): void {
    const autoloadService = this.getAutoloadServiceSafe();
    if (!autoloadService) {
      return;
    }

    for (const component of autoloadService.getAutoloadInstances()) {
      if (!component.enabled || component._started || !component.onStart) {
        continue;
      }
      component.onStart();
      component._started = true;
    }
  }

  private getAutoloadServiceSafe(): AutoloadService | null {
    try {
      return this.autoloadService;
    } catch {
      return null;
    }
  }

  private getInputServiceSafe(): InputService | null {
    try {
      return this.input;
    } catch {
      return null;
    }
  }
}
