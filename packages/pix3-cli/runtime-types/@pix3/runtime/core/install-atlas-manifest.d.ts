import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';
/** Where the editor export writes the packed atlas. */
export declare const ATLAS_MANIFEST_PATH = "res://assets/.atlas/atlas-manifest.json";
export declare const ATLAS_SHEET_DIR = "res://assets/.atlas/";
/**
 * For exported / standalone / remote-preview games: if a pre-packed atlas
 * manifest is present, install a resolver so every eligible texture loads as a
 * view onto a bundled sheet (sheets are real res:// files — `loadTexture` loads
 * them like any texture, no preseeding needed). Call before
 * `SceneRunner.startScene`.
 *
 * Defensive: a missing/unreadable/invalid manifest leaves the loader un-atlased
 * (byte-identical to the pre-atlas path), so a game with no packed atlas — or a
 * malformed one — still starts.
 */
export declare function installAtlasFromManifest(assetLoader: AssetLoader, resourceManager: ResourceManager): Promise<boolean>;
