import type { SceneGraph } from './SceneManager';
import type { SceneNodeDefinition } from './SceneLoader';
/** The plain document `serializeScene` stringifies (see {@link SceneSaver.serializeSceneDocument}). */
export interface SavedSceneDocument {
    version: string;
    description?: string;
    metadata?: Record<string, unknown>;
    root: SceneNodeDefinition[];
}
export declare class SceneSaver {
    constructor();
    /**
     * The plain document `serializeScene` writes, before YAML stringification — the same keys and
     * values, as objects. For hosts that compare scene states (the editor's protected-set recorder
     * diffs it before/after each operation) without paying for a YAML round trip.
     */
    serializeSceneDocument(graph: SceneGraph): SavedSceneDocument;
    /**
     * Serialize a scene graph back to YAML format for saving.
     */
    serializeScene(graph: SceneGraph): string;
    private serializeNode;
    private serializeInstanceNode;
    private serializeMetadata;
    private serializeNodeProperties;
    private captureInstanceComparableMap;
    private captureComparableProperties;
    private diffRecord;
    private isEqualValue;
    private getPrefabMarker;
    private normalizeLocalId;
    private cloneValue;
    private serializeCommonUIControlProps;
    /**
     * Emit a texture resource ref, or drop the key when the slot is empty. A cleared
     * slot MUST delete rather than write null: the props map starts as the YAML the
     * node was loaded from, so leaving the old key would resurrect the sprite.
     */
    private serializeTextureRef;
    /**
     * The four `sliceBorder*` scalars, defaults (0) omitted — an unsliced control
     * serializes byte-for-byte as it did before nine-slice existed. Same spelling as
     * `TiledSprite2D`, which always emits them because slicing is its whole point.
     */
    private serializeSliceBorder;
}
