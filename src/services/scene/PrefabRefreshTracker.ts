import { injectable } from '@/fw/di';

/**
 * Remembers, per scene, a signature of the last-known modification times of the
 * prefab source files referenced by that scene.
 *
 * `RefreshPrefabInstancesOperation` uses it to skip rebuilding the scene graph
 * when no referenced prefab file has actually changed. That matters because a
 * rebuild replaces every live node instance, which would orphan the node
 * references captured in undo/redo history closures. The refresh runs on every
 * scene-tab (re)activation — including when exiting play mode — so a cheap
 * "nothing changed" check keeps history and node identity intact for the common
 * case, while genuine external prefab edits still trigger a rebuild.
 */
@injectable()
export class PrefabRefreshTracker {
  private readonly signatures = new Map<string, string>();

  get(sceneId: string): string | undefined {
    return this.signatures.get(sceneId);
  }

  set(sceneId: string, signature: string): void {
    this.signatures.set(sceneId, signature);
  }

  forget(sceneId: string): void {
    this.signatures.delete(sceneId);
  }
}
