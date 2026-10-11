/**
 * The `.pix3scene` disk format, as data: which keys a node may carry under `properties:`, and which
 * schema property each one feeds.
 *
 * Why this exists: `getPropertySchema()` is the **inspector's** model, not the file's. The two
 * differ systematically — a 2D node's `position` lives at `transform.position`, its
 * `layoutEnabled` at `layout.enabled`, a `GeometryMesh`'s `color` at `material.color`, and a handful
 * of keys the saver writes or the loader reads (`effects`, `texturePath`, `stateTextureKeys`, …) are
 * no schema property at all. A strict checker that took the schema as the file format would flag
 * every scene the editor saves, and one that ignored the difference would wave through the commonest
 * authoring mistake there is: a schema name written where the loader never looks (`color:` flat on a
 * `GeometryMesh`, `horizontalAlign:` flat on a `Sprite2D`) — a key that loads "fine", survives
 * every save, and does nothing.
 *
 * The truth is what `SceneLoader.createNodeFromDefinition` reads and `SceneSaver` writes. This table
 * records it and is pinned against both by `scene-disk-format.spec.ts`:
 * - every key `SceneSaver` writes for an instance of every node type (non-default values) is
 *   listed here, and
 * - every schema name accepted *flat* here is actually honoured by the loader when written flat,
 *   and every one listed as relocated / not stored is actually ignored flat.
 * Add a node type or a saver branch without teaching this table, and that spec fails.
 *
 * Pure data + string work — no node imports (this module is exported from the package index, which
 * every player bundle reaches; see `strippable-runtime-modules.ts`). Consumers pass the node's
 * schema in: `pix3 validate` reads it from the class's static `getPropertySchema()`.
 */
import type { PropertyDefinition, PropertyType } from '../fw/property-schema';
/** The only scene format version in existence; the loader has no migrations. */
export declare const CURRENT_SCENE_FORMAT_VERSION = "1.0.0";
/** Top-level keys of a scene document. */
export declare const SCENE_DOCUMENT_KEYS: readonly string[];
/** Keys of one node entry (`SceneNodeDefinition`). */
export declare const SCENE_NODE_DEFINITION_KEYS: readonly string[];
/** Keys of one `components:` entry (`ComponentDefinition`). */
export declare const SCENE_COMPONENT_DEFINITION_KEYS: readonly string[];
/**
 * Value kinds for disk keys that are not schema properties.
 * - `texture`: a texture ref — `{ type: texture, url }` or a bare path string.
 * - `resource-path`: a path string (normally `res://…`).
 * - `array` / `record`: structure the loader parses itself; only the container shape is checked.
 */
export type SceneDiskValueKind = PropertyType | 'texture' | 'resource-path' | 'array' | 'record';
export interface SceneDiskKeyRule {
    /** The schema property this key feeds, when it feeds one (its type drives the value check). */
    readonly schemaName?: string;
    /** Value kind when the key feeds no schema property. */
    readonly kind?: SceneDiskValueKind;
    /** Allowed values for `kind: 'enum'`. */
    readonly options?: readonly string[];
    /** For a structural key (`transform`, `layout`, `flow`, `material`, …): its own keys. */
    readonly nested?: Readonly<Record<string, SceneDiskKeyRule>>;
    /**
     * Read-compat spelling: the loader accepts it, the saver writes this spelling instead
     * (a path relative to `properties`, e.g. `texture` or `transform.position`).
     */
    readonly preferred?: string;
}
/** Which transform/layout block a node type carries. */
export type SceneNodeFamily = '2d' | '3d' | 'base';
export interface SceneNodeDiskFormat {
    /** Canonical scene `type:`. */
    readonly type: string;
    /** `@pix3/runtime` export whose static `getPropertySchema()` describes this type. */
    readonly classExport: string;
    readonly family: SceneNodeFamily;
    /** Keys under `properties` that are not flat schema names. */
    readonly extras: Readonly<Record<string, SceneDiskKeyRule>>;
    /** Schema names NOT accepted flat → where they live on disk (`flow.enabled`, `material.color`). */
    readonly relocated: Readonly<Record<string, string>>;
    /** Schema names the file never stores (identity, runtime-derived, inspector-only) → why. */
    readonly notStored: Readonly<Record<string, string>>;
    /**
     * Schema names the saver writes but the loader does not read back — a loader gap, not an
     * authoring error. `pix3 validate` warns (`W_WRITE_ONLY_PROPERTY`) instead of failing.
     */
    readonly writeOnly: readonly string[];
}
/** Node types that load at all (`Layout2D` is in the vocabulary only to be rejected). */
export declare const SCENE_DISK_FORMAT_TYPES: readonly string[];
/** Disk format of a canonical scene `type:` (resolve aliases first), or `null` for none. */
export declare const getSceneNodeDiskFormat: (canonicalType: string) => SceneNodeDiskFormat | null;
/** What one key under a node's `properties:` is, for a given type and its schema. */
export type SceneDiskKeyResolution = {
    readonly kind: 'schema';
    readonly property: PropertyDefinition;
    /** Set for flat transform keys: the loader reads them, the saver writes `transform.*`. */
    readonly preferred?: string;
} | {
    readonly kind: 'extra';
    readonly rule: SceneDiskKeyRule;
} | {
    readonly kind: 'write-only';
    readonly property: PropertyDefinition;
} | {
    readonly kind: 'relocated';
    readonly property: PropertyDefinition;
    readonly diskPath: string;
} | {
    readonly kind: 'not-stored';
    readonly property: PropertyDefinition;
    readonly reason: string;
} | {
    readonly kind: 'unknown';
};
/**
 * Classify a key under `properties:`. `schema` is the node class's property list (static
 * `getPropertySchema().properties`).
 */
export declare const resolveSceneDiskKey: (format: SceneNodeDiskFormat, schema: readonly PropertyDefinition[], key: string) => SceneDiskKeyResolution;
/**
 * Keys accepted on an **instance** node (`instance:`) and in `overrides.byLocalId.*.properties`.
 * These are applied through the prefab node's schema (`SceneLoader.applyLegacyInstanceRootProperties`),
 * so they are schema names in schema-value form, plus a `transform` block — not the disk format above.
 */
export declare const INSTANCE_TRANSFORM_KEYS: Readonly<Record<string, string>>;
