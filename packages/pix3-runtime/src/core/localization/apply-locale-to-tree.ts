import type { Texture } from 'three';
import { NodeBase } from '../../nodes/NodeBase';
import { UIControl2D } from '../../nodes/2D/UI/UIControl2D';
import { Button2D, type Button2DSpriteState } from '../../nodes/2D/UI/Button2D';
import { Sprite2D } from '../../nodes/2D/Sprite2D';

/** The slice of AssetLoader the locale walk needs (structural, keeps this module decoupled). */
export interface LocaleTextureLoader {
  loadTexture(path: string): Promise<Texture>;
}

const BUTTON_STATES: readonly Button2DSpriteState[] = ['normal', 'hover', 'pressed', 'disabled'];

/**
 * Re-render every localized node under `roots` after a locale switch or table edit. Walks the tree
 * once, repaints each `UIControl2D` whose `labelKey` is set (covers authored keys and script
 * `setTextKey`), and — when a `textureLoader` is supplied — re-resolves localized sprite textures
 * (`Sprite2D.textureKey`, `Button2D.stateTextureKeys`) through the active locale's `sprites` table.
 * Texture loads are async fire-and-forget; a stale load is dropped if the effective path changed
 * again before it landed (rapid locale toggling). Shared by the SceneRunner (play mode) and the
 * editor preview so they can't drift.
 */
export function applyLocaleToTree(
  roots: readonly NodeBase[],
  textureLoader?: LocaleTextureLoader | null
): void {
  const visit = (node: NodeBase): void => {
    if (node instanceof UIControl2D && node.labelKey) {
      node.refreshLocalizedLabel();
    }
    if (textureLoader) {
      if (node instanceof Sprite2D && node.textureKey) {
        refreshSprite2DTexture(node, textureLoader);
      } else if (node instanceof Button2D && node.hasLocalizedStateTextures()) {
        refreshButton2DStateTextures(node, textureLoader);
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
}

function refreshSprite2DTexture(node: Sprite2D, loader: LocaleTextureLoader): void {
  const path = node.getEffectiveTexturePath();
  if (!path) return;
  loader
    .loadTexture(path)
    .then(texture => {
      // Drop a stale load: the locale flipped again while this one was in flight.
      if (node.getEffectiveTexturePath() !== path) return;
      node.setTexture(texture);
    })
    .catch(error => {
      console.warn(`[Localization] Failed to load localized texture "${path}"`, error);
    });
}

function refreshButton2DStateTextures(node: Button2D, loader: LocaleTextureLoader): void {
  for (const state of BUTTON_STATES) {
    // Only keyed states can change with the locale; authored-only refs are static.
    if (!node.stateTextureKeys[state]) continue;
    const path = node.getEffectiveStateTexturePath(state);
    if (!path) continue;
    loader
      .loadTexture(path)
      .then(texture => {
        if (node.getEffectiveStateTexturePath(state) !== path) return;
        node.setStateTexture(state, texture);
      })
      .catch(error => {
        console.warn(`[Localization] Failed to load localized ${state} texture "${path}"`, error);
      });
  }
}
