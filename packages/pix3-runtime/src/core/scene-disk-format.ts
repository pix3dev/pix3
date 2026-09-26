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
export const CURRENT_SCENE_FORMAT_VERSION = '1.0.0';

/** Top-level keys of a scene document. */
export const SCENE_DOCUMENT_KEYS: readonly string[] = [
  'version',
  'description',
  'metadata',
  'root',
];

/** Keys of one node entry (`SceneNodeDefinition`). */
export const SCENE_NODE_DEFINITION_KEYS: readonly string[] = [
  'id',
  'type',
  'name',
  'instance',
  'instancePath',
  'groups',
  'properties',
  'metadata',
  'children',
  'components',
  'overrides',
];

/** Keys of one `components:` entry (`ComponentDefinition`). */
export const SCENE_COMPONENT_DEFINITION_KEYS: readonly string[] = [
  'id',
  'type',
  'enabled',
  'config',
];

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

const TRANSFORM_2D: SceneDiskKeyRule = {
  kind: 'record',
  nested: {
    position: { schemaName: 'position' },
    scale: { schemaName: 'scale' },
    rotation: { schemaName: 'rotation' },
  },
};

const ROTATION_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'] as const;

const TRANSFORM_3D: SceneDiskKeyRule = {
  kind: 'record',
  nested: {
    position: { schemaName: 'position' },
    translate: { schemaName: 'position', preferred: 'transform.position' },
    rotationEuler: { schemaName: 'rotation' },
    rotation: { schemaName: 'rotation', preferred: 'transform.rotationEuler' },
    euler: { schemaName: 'rotation', preferred: 'transform.rotationEuler' },
    scale: { schemaName: 'scale' },
    rotationOrder: { kind: 'enum', options: ROTATION_ORDERS },
  },
};

const LAYOUT_2D: SceneDiskKeyRule = {
  kind: 'record',
  nested: {
    enabled: { schemaName: 'layoutEnabled' },
    horizontalAlign: { schemaName: 'horizontalAlign' },
    verticalAlign: { schemaName: 'verticalAlign' },
  },
};

const FLOW_2D: SceneDiskKeyRule = {
  kind: 'record',
  nested: {
    enabled: { schemaName: 'flowEnabled' },
    direction: { schemaName: 'flowDirection' },
    gap: { schemaName: 'flowGap' },
    paddingX: { schemaName: 'flowPaddingX' },
    paddingY: { schemaName: 'flowPaddingY' },
    align: { schemaName: 'flowAlign' },
    autoSize: { schemaName: 'flowAutoSize' },
  },
};

/** Shader-effect stack (`Sprite2D`, `AnimatedSprite2D`, `Button2D`, `material.effects`). */
const EFFECTS: SceneDiskKeyRule = { kind: 'array' };

/** Schema props of every node that belong on the node entry, not under `properties`. */
const NODE_LEVEL_NOT_STORED: Readonly<Record<string, string>> = {
  id: "the node id is the entry's own `id:`, not a property",
  name: "the node name is the entry's own `name:`, not a property",
  type: "the node type is the entry's own `type:`, not a property",
  groups: "groups are the entry's own `groups:` list, not a property",
};

/** Flat transform keys the loader reads when `transform` is absent (read-compat). */
const FLAT_TRANSFORM_COMPAT: readonly string[] = ['position', 'rotation', 'scale'];

interface TypeSpec {
  readonly family: SceneNodeFamily;
  readonly classExport?: string;
  readonly extras?: Readonly<Record<string, SceneDiskKeyRule>>;
  readonly relocated?: Readonly<Record<string, string>>;
  readonly notStored?: Readonly<Record<string, string>>;
  readonly writeOnly?: readonly string[];
}

const TYPE_SPECS: Readonly<Record<string, TypeSpec>> = {
  Group: { family: 'base', classExport: 'NodeBase' },
  Node2D: { family: '2d' },
  Node3D: { family: '3d' },
  ColorRect2D: { family: '2d' },
  Sprite2D: {
    family: '2d',
    extras: {
      effects: EFFECTS,
      texturePath: { kind: 'resource-path', preferred: 'texture' },
      color: { kind: 'color' },
    },
  },
  TiledSprite2D: {
    family: '2d',
    extras: {
      texturePath: { kind: 'resource-path', preferred: 'texture' },
      color: { kind: 'color' },
    },
  },
  AnimatedSprite2D: { family: '2d', extras: { effects: EFFECTS } },
  SpineSkeleton2D: {
    family: '2d',
    extras: { texturePath: { kind: 'resource-path', preferred: 'texture' } },
  },
  // `UIControl2D.texturePath` is read by every control's loader branch except Label2D's, while
  // `SceneSaver.serializeCommonUIControlProps` writes it for all of them.
  Label2D: { family: '2d', writeOnly: ['texturePath'] },
  Group2D: { family: '2d' },
  CanvasLayer2D: { family: '2d' },
  Camera2D: { family: '2d' },
  Button2D: {
    family: '2d',
    extras: {
      effects: EFFECTS,
      stateTextureKeys: {
        kind: 'record',
        nested: {
          normal: { schemaName: 'textureNormalKey' },
          hover: { schemaName: 'textureHoverKey' },
          pressed: { schemaName: 'texturePressedKey' },
          disabled: { schemaName: 'textureDisabledKey' },
        },
      },
    },
  },
  Slider2D: { family: '2d' },
  Bar2D: { family: '2d', extras: { borderWidth: { kind: 'number' } } },
  Checkbox2D: { family: '2d' },
  Joystick2D: {
    family: '2d',
    extras: {
      handleRadius: { kind: 'number' },
      baseColor: { kind: 'color' },
      handleColor: { kind: 'color' },
    },
  },
  ScrollContainer2D: { family: '2d' },
  InventorySlot2D: {
    family: '2d',
    extras: { borderWidth: { kind: 'number' }, quantityFontSize: { kind: 'number' } },
  },
  GeometryMesh: {
    family: '3d',
    extras: {
      material: {
        kind: 'record',
        nested: {
          type: { schemaName: 'materialType' },
          color: { schemaName: 'color' },
          roughness: { schemaName: 'roughness' },
          metalness: { schemaName: 'metalness' },
          aoMap: { kind: 'resource-path' },
          aoMapIntensity: { schemaName: 'aoMapIntensity' },
          map: { kind: 'resource-path' },
          effects: EFFECTS,
        },
      },
    },
    relocated: { map: 'material.map' },
  },
  MeshInstance: { family: '3d', extras: { src: { kind: 'resource-path' } } },
  InstancedMesh3D: {
    family: '3d',
    extras: {
      material: {
        kind: 'record',
        nested: {
          type: { schemaName: 'materialType' },
          color: { schemaName: 'color' },
          roughness: { kind: 'number' },
          metalness: { kind: 'number' },
        },
      },
      frustumCulled: { kind: 'boolean' },
    },
    notStored: { visibleInstanceCount: 'computed at runtime from the instance buffer' },
  },
  Sprite3D: {
    family: '3d',
    extras: {
      texturePath: { kind: 'resource-path', preferred: 'texture' },
      color: { kind: 'color' },
    },
    notStored: {
      textureAspectRatio: 'derived from the loaded texture',
      aspectRatioLocked: 'an inspector-only toggle on Sprite3D',
    },
  },
  AnimatedSprite3D: {
    family: '3d',
    extras: { frames: { kind: 'array' } },
    notStored: { currentFrame: 'playback state, not saved on AnimatedSprite3D' },
  },
  Particles3D: {
    family: '3d',
    extras: { texturePath: { kind: 'resource-path', preferred: 'texture' } },
  },
  AmbientLightNode: { family: '3d' },
  DirectionalLightNode: { family: '3d' },
  HemisphereLightNode: { family: '3d' },
  PointLightNode: { family: '3d' },
  SpotLightNode: { family: '3d' },
  Camera3D: { family: '3d' },
  VirtualCamera3D: { family: '3d' },
  PostProcess: { family: 'base' },
  AudioPlayer: { family: 'base' },
};

/** Node types that load at all (`Layout2D` is in the vocabulary only to be rejected). */
export const SCENE_DISK_FORMAT_TYPES: readonly string[] = Object.keys(TYPE_SPECS);

const collectNestedSchemaNames = (
  rule: SceneDiskKeyRule,
  path: string,
  into: Record<string, string>
): void => {
  for (const [key, child] of Object.entries(rule.nested ?? {})) {
    if (child.schemaName && !child.preferred && !(child.schemaName in into)) {
      into[child.schemaName] = `${path}.${key}`;
    }
  }
};

const buildFormat = (type: string, spec: TypeSpec): SceneNodeDiskFormat => {
  const structural: Record<string, SceneDiskKeyRule> =
    spec.family === '2d'
      ? { transform: TRANSFORM_2D, layout: LAYOUT_2D, flow: FLOW_2D }
      : spec.family === '3d'
        ? { transform: TRANSFORM_3D }
        : {};
  const extras: Record<string, SceneDiskKeyRule> = { ...structural, ...spec.extras };
  const relocated: Record<string, string> = {};
  for (const [key, rule] of Object.entries(extras)) {
    collectNestedSchemaNames(rule, key, relocated);
  }
  // `transform.*` feeds position/rotation/scale, which the loader ALSO reads flat.
  for (const name of FLAT_TRANSFORM_COMPAT) delete relocated[name];
  Object.assign(relocated, spec.relocated);
  return {
    type,
    classExport: spec.classExport ?? type,
    family: spec.family,
    extras,
    relocated,
    notStored: { ...NODE_LEVEL_NOT_STORED, ...spec.notStored },
    writeOnly: spec.writeOnly ?? [],
  };
};

const FORMATS: ReadonlyMap<string, SceneNodeDiskFormat> = new Map(
  Object.entries(TYPE_SPECS).map(([type, spec]) => [type, buildFormat(type, spec)])
);

/** Disk format of a canonical scene `type:` (resolve aliases first), or `null` for none. */
export const getSceneNodeDiskFormat = (canonicalType: string): SceneNodeDiskFormat | null =>
  FORMATS.get(canonicalType) ?? null;

/** What one key under a node's `properties:` is, for a given type and its schema. */
export type SceneDiskKeyResolution =
  | {
      readonly kind: 'schema';
      readonly property: PropertyDefinition;
      /** Set for flat transform keys: the loader reads them, the saver writes `transform.*`. */
      readonly preferred?: string;
    }
  | { readonly kind: 'extra'; readonly rule: SceneDiskKeyRule }
  | { readonly kind: 'write-only'; readonly property: PropertyDefinition }
  | { readonly kind: 'relocated'; readonly property: PropertyDefinition; readonly diskPath: string }
  | { readonly kind: 'not-stored'; readonly property: PropertyDefinition; readonly reason: string }
  | { readonly kind: 'unknown' };

/**
 * Classify a key under `properties:`. `schema` is the node class's property list (static
 * `getPropertySchema().properties`).
 */
export const resolveSceneDiskKey = (
  format: SceneNodeDiskFormat,
  schema: readonly PropertyDefinition[],
  key: string
): SceneDiskKeyResolution => {
  const extra = format.extras[key];
  if (extra) return { kind: 'extra', rule: extra };
  const property = schema.find(candidate => candidate.name === key);
  if (!property) return { kind: 'unknown' };
  const notStored = format.notStored[key];
  if (notStored !== undefined) return { kind: 'not-stored', property, reason: notStored };
  const diskPath = format.relocated[key];
  if (diskPath !== undefined) return { kind: 'relocated', property, diskPath };
  if (format.writeOnly.includes(key)) return { kind: 'write-only', property };
  if (format.family !== 'base' && FLAT_TRANSFORM_COMPAT.includes(key)) {
    const preferred =
      format.family === '3d' && key === 'rotation' ? 'transform.rotationEuler' : `transform.${key}`;
    return { kind: 'schema', property, preferred };
  }
  return { kind: 'schema', property };
};

/**
 * Keys accepted on an **instance** node (`instance:`) and in `overrides.byLocalId.*.properties`.
 * These are applied through the prefab node's schema (`SceneLoader.applyLegacyInstanceRootProperties`),
 * so they are schema names in schema-value form, plus a `transform` block — not the disk format above.
 */
export const INSTANCE_TRANSFORM_KEYS: Readonly<Record<string, string>> = {
  position: 'position',
  translate: 'position',
  rotationEuler: 'rotation',
  rotation: 'rotation',
  euler: 'rotation',
  scale: 'scale',
};
