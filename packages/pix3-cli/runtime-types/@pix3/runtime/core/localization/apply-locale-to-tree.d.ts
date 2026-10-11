import type { Texture } from 'three';
import { NodeBase } from '../../nodes/NodeBase';
/** The slice of AssetLoader the locale walk needs (structural, keeps this module decoupled). */
export interface LocaleTextureLoader {
    loadTexture(path: string): Promise<Texture>;
}
/**
 * Re-render every localized node under `roots` after a locale switch or table edit. Walks the tree
 * once, repaints each `UIControl2D` whose `labelKey` is set (covers authored keys and script
 * `setTextKey`), and — when a `textureLoader` is supplied — re-resolves localized sprite textures
 * (`Sprite2D.textureKey`, `Button2D.stateTextureKeys`) through the active locale's `sprites` table.
 * Texture loads are async fire-and-forget; a stale load is dropped if the effective path changed
 * again before it landed (rapid locale toggling). Shared by the SceneRunner (play mode) and the
 * editor preview so they can't drift.
 */
export declare function applyLocaleToTree(roots: readonly NodeBase[], textureLoader?: LocaleTextureLoader | null): void;
