import {
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  CylinderGeometry,
  ConeGeometry,
  TorusGeometry,
  Mesh,
  MeshStandardMaterial,
  MeshLambertMaterial,
  MeshBasicMaterial,
  Color,
  SRGBColorSpace,
  BufferGeometry,
  Float32BufferAttribute,
  Material,
  type Texture,
} from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { defineProperty, mergeSchemas } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import type { AttachedShaderEffect } from '../../shader-effects/shader-effect-types';
import {
  ShaderEffectStack,
  type ShaderEffectEntry,
  type ShaderEffectHost,
} from '../../shader-effects/ShaderEffectStack';

/**
 * Material families a GeometryMesh can wear, cheapest last.
 *
 * The default is `standard` (PBR) and stays that way: every scene and every consumer project
 * authored before this existed is a standard mesh, and re-materialling them on read would change
 * how shipped games look. New content picks: mobile creation paths author `lambert`, and a user who
 * asks for a high-end look gets `standard`.
 *
 * - `standard` — PBR. Roughness/metalness/IBL. The most expensive per pixel.
 * - `lambert` — diffuse-only lighting. Keeps the shape readable (a cube still reads as a cube)
 *   at a fraction of the cost. The right default for a phone.
 * - `basic` — unlit flat colour. Cheapest, and the only family that cannot render black for want
 *   of a light.
 */
/**
 * The slice of a material every GeometryMesh family shares: a colour, an albedo map and an AO map.
 * `MeshStandardMaterial`, `MeshLambertMaterial` and `MeshBasicMaterial` all carry these, so texture
 * and colour edits must not be gated on the mesh being PBR — only roughness/metalness are.
 */
type MappedMaterial = Material & {
  color: Color;
  map?: Texture | null;
  aoMap?: Texture | null;
  aoMapIntensity?: number;
};

export const GEOMETRY_MATERIAL_TYPES = ['standard', 'lambert', 'basic'] as const;
export type GeometryMaterialType = (typeof GEOMETRY_MATERIAL_TYPES)[number];

export const DEFAULT_GEOMETRY_MATERIAL_TYPE: GeometryMaterialType = 'standard';

const asMaterialType = (value: unknown): GeometryMaterialType =>
  typeof value === 'string' && (GEOMETRY_MATERIAL_TYPES as readonly string[]).includes(value)
    ? (value as GeometryMaterialType)
    : DEFAULT_GEOMETRY_MATERIAL_TYPE;

/**
 * Which shader-effect family a material type belongs to.
 *
 * `lambert` maps to `standard` rather than getting a family of its own: the four anchors the effect
 * composer injects at (`uv_vertex`, `color_fragment`, `emissivemap_fragment`, `opaque_fragment`)
 * all exist in three's meshlambert shader, so standard-targeted effects compile there. Giving
 * lambert no effects at all would mean picking the mobile material silently disables a project's
 * shader effects — a worse failure than the one this whole change is about.
 */
const effectTargetFor = (type: GeometryMaterialType): 'standard' | 'basic' =>
  type === 'basic' ? 'basic' : 'standard';

/** Supported primitive kinds. `size` is interpreted per-shape (see buildGeometry). */
export const GEOMETRY_KINDS = ['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus'] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

/**
 * One authored, serialized shader-effect attachment.
 * @deprecated Renamed to {@link ShaderEffectEntry} now that effects are
 * node-agnostic. Kept as an alias for DeepCore / consumer back-compat.
 */
export type GeometryMeshEffectEntry = ShaderEffectEntry;

/**
 * Ordered list of attached shader effects, as serialized under `material.effects`.
 * @deprecated Use `ShaderEffectEntry[]`.
 */
export type GeometryMeshEffectsConfig = ShaderEffectEntry[];

export interface GeometryMeshProps extends Omit<Node3DProps, 'type'> {
  geometry?: string;
  size?: [number, number, number];
  material?: {
    /** Material family (see {@link GEOMETRY_MATERIAL_TYPES}). Defaults to `standard`. */
    type?: string;
    color?: string;
    /** `standard` only. */
    roughness?: number;
    /** `standard` only. */
    metalness?: number;
    /** res:// path of a baked ambient-occlusion map (see the AO baker). */
    aoMap?: string;
    /** 0..1 strength of the AO map (default 1). */
    aoMapIntensity?: number;
    /** res:// path of the albedo (diffuse) map. Required for UV-scroll to show. */
    map?: string;
    /** Registry-backed shader effects attached to this mesh. */
    effects?: GeometryMeshEffectsConfig;
  };
}

export class GeometryMesh
  extends Node3D
  implements InstancePropertySchemaProvider, ShaderEffectHost
{
  private _geometry?: BufferGeometry;
  private _material?: Material;
  /** Authored geometry kind / size, kept so serialization survives round-trips
   * (the three.js BufferGeometry doesn't carry the authored primitive name). */
  private _geometryKind: GeometryKind;
  private _size: [number, number, number];
  /** res:// path of the baked AO map, kept for serialization (the runtime
   * Texture is loaded async by the loader / assigned by the AO baker). */
  private _aoMapSrc: string;
  /** Authored AO-map strength. Kept separate from the live
   * `material.aoMapIntensity` so runtime suppression (when realtime SSAO wins
   * the AO-mode cascade) can zero the effect without losing the authored value
   * on save. */
  private _aoMapIntensity = 1;
  /** When true, the baked AO map is suppressed at render time (SSAO is driving
   * AO instead). Runtime-only — never serialized. */
  private _aoSuppressed = false;
  /** res:// path of the albedo map, kept for serialization (the Texture itself
   * is loaded async by the loader / editor viewport sync). */
  private _mapSrc = '';
  /** Authored material family; decides what is built and what round-trips. */
  private _materialType: GeometryMaterialType;
  /**
   * Registry-backed shader effects attached to the mesh material.
   *
   * Built in the constructor rather than as a field initializer because its target family depends
   * on the authored material type, which is only known once props are in hand.
   */
  private readonly effectStack: ShaderEffectStack;

  constructor(props: GeometryMeshProps) {
    super(props, 'GeometryMesh');

    const geometryKind = normalizeGeometryKind(props.geometry);
    const size = props.size ?? [1, 1, 1];
    this._geometryKind = geometryKind;
    this._size = [size[0], size[1], size[2]];

    const geometry = GeometryMesh.buildGeometry(geometryKind, this._size);

    const mat = props.material ?? {};
    const color = new Color(mat.color ?? '#4e8df5');
    const roughness = typeof mat.roughness === 'number' ? mat.roughness : 0.35;
    const metalness = typeof mat.metalness === 'number' ? mat.metalness : 0.25;

    this._materialType = asMaterialType(mat.type);
    this.effectStack = new ShaderEffectStack({
      nodeType: 'GeometryMesh',
      target: effectTargetFor(this._materialType),
    });

    const material = GeometryMesh.buildMaterial(this._materialType, {
      color,
      roughness,
      metalness,
    });
    this._aoMapIntensity =
      typeof mat.aoMapIntensity === 'number' ? clamp01Number(mat.aoMapIntensity) : 1;
    (material as Material & { aoMapIntensity?: number }).aoMapIntensity = this._aoMapIntensity;

    // Wire the effect composer before first render; effects attached below set
    // their defines pre-compile so the first program is the right variant.
    this.installEffectComposer(material);

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${this.name}-Mesh`;
    this.add(mesh);

    this._geometry = geometry;
    this._material = material;
    this._aoMapSrc = typeof mat.aoMap === 'string' ? mat.aoMap : '';
    this._mapSrc = typeof mat.map === 'string' ? mat.map : '';

    for (const entry of mat.effects ?? []) {
      if (entry && typeof entry.type === 'string') {
        this.attachEffect(entry.type, { enabled: entry.enabled, params: entry.params });
      }
    }
  }

  protected override disposeResources(): void {
    try {
      this._geometry?.dispose();
      // eslint-disable-next-line no-empty
    } catch {}
    try {
      (this._material as unknown as { dispose?: () => void })?.dispose?.();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  /**
   * Build a primitive geometry from a kind + `size`. `size` is a single
   * `[x, y, z]` vector interpreted per-shape so one editable field works for
   * every primitive:
   * - box: full extents (x, y, z)
   * - sphere: diameter = x
   * - plane: a horizontal floor of x by z (rotated into the XZ plane)
   * - cylinder / cone: diameter = x, height = y
   * - torus: outer diameter = x, tube thickness scales with y
   */
  private static buildGeometry(kind: GeometryKind, size: [number, number, number]): BufferGeometry {
    const x = Math.max(0.0001, size[0]);
    const y = Math.max(0.0001, size[1]);
    const z = Math.max(0.0001, size[2]);
    switch (kind) {
      case 'sphere':
        return new SphereGeometry(x / 2, 32, 16);
      case 'plane': {
        const plane = new PlaneGeometry(x, z);
        plane.rotateX(-Math.PI / 2); // lie flat as a floor
        return plane;
      }
      case 'cylinder':
        return new CylinderGeometry(x / 2, x / 2, y, 32);
      case 'cone':
        return new ConeGeometry(x / 2, y, 32);
      case 'torus': {
        const radius = x / 2;
        const tube = Math.max(0.02, Math.min(radius * 0.6, y * 0.25));
        return new TorusGeometry(radius, tube, 20, 40);
      }
      case 'box':
      default:
        return new BoxGeometry(x, y, z);
    }
  }

  /**
   * Build the three.js material for a family. `roughness`/`metalness` exist only on `standard`;
   * the other two ignore them, and {@link serializeConfig} stops writing them so a round-trip does
   * not resurrect PBR values on a mesh that has no use for them.
   */
  private static buildMaterial(
    type: GeometryMaterialType,
    opts: { color: Color; roughness: number; metalness: number }
  ): Material {
    switch (type) {
      case 'basic':
        return new MeshBasicMaterial({ color: opts.color });
      case 'lambert':
        return new MeshLambertMaterial({ color: opts.color });
      case 'standard':
      default:
        return new MeshStandardMaterial({
          color: opts.color,
          roughness: opts.roughness,
          metalness: opts.metalness,
        });
    }
  }

  /** The authored material family. */
  get materialType(): GeometryMaterialType {
    return this._materialType;
  }

  /**
   * Swap the material family in place, carrying over everything the new family can hold.
   *
   * Colour and the albedo map survive every family; roughness/metalness only exist on `standard`
   * and are re-defaulted when coming back to it; the AO map survives because all three families
   * support `aoMap`. Attached shader effects are re-installed onto the new material, and the ones
   * whose GLSL does not target the new family are dropped with a warning rather than left attached
   * and silently dead.
   */
  set materialType(value: GeometryMaterialType) {
    const next = asMaterialType(value);
    if (next === this._materialType) {
      return;
    }
    const previous = this._material;
    const previousColor = this._colorMaterial?.color.clone() ?? new Color('#4e8df5');
    const previousMap = this._colorMaterial?.map ?? null;
    const std = this._stdMaterial;
    const material = GeometryMesh.buildMaterial(next, {
      color: previousColor,
      roughness: std?.roughness ?? 0.35,
      metalness: std?.metalness ?? 0.25,
    });
    this._materialType = next;
    this.effectStack.retarget(effectTargetFor(next));
    if (previous) {
      this.effectStack.uninstall(previous);
    }
    this.installEffectComposer(material);

    const withMaps = material as Material & { map?: Texture | null; aoMap?: Texture | null };
    if (previousMap) {
      withMaps.map = previousMap;
    }
    const previousAo = std?.aoMap ?? null;
    if (previousAo) {
      withMaps.aoMap = previousAo;
      (material as Material & { aoMapIntensity?: number }).aoMapIntensity = this._aoSuppressed
        ? 0
        : this._aoMapIntensity;
    }

    const mesh = this._mesh;
    if (mesh) {
      mesh.material = material;
    }
    this._material = material;
    material.needsUpdate = true;
    try {
      (previous as unknown as { dispose?: () => void })?.dispose?.();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  /** Swap the child mesh's geometry to match the current kind + size. */
  private rebuildGeometry(): void {
    const next = GeometryMesh.buildGeometry(this._geometryKind, this._size);
    const old = this._geometry;
    const mesh = this._mesh;
    if (mesh) {
      mesh.geometry = next;
    }
    this._geometry = next;
    // The lightmap UV set lives on the geometry, so a rebuilt shape needs it
    // regenerated when an AO map is in use.
    if (this._colorMaterial?.aoMap) {
      GeometryMesh.applyLightmapUV(this._geometryKind, next);
    }
    try {
      old?.dispose();
      // eslint-disable-next-line no-empty
    } catch {}
  }

  /**
   * Ensure the dedicated lightmap UV set (`uv1`) exists on the current geometry.
   * The AO baker calls this before baking — the UV must exist before the texture
   * does. Idempotent.
   */
  ensureLightmapUV(): void {
    GeometryMesh.applyLightmapUV(this._geometryKind, this._geometry);
  }

  /** The child render mesh (exposed for the AO baker to read geometry/matrix). */
  get renderMesh(): Mesh | undefined {
    return this._mesh;
  }

  /**
   * Assign (or clear) the baked ambient-occlusion map. The AO map samples the
   * dedicated lightmap UV set (channel 1 / `uv1`), which is generated lazily so
   * a mesh with no AO pays no extra attribute cost.
   */
  setAOMap(texture: Texture | null): void {
    const mat = this._colorMaterial;
    if (!mat) {
      return;
    }
    if (texture) {
      texture.channel = 1;
      texture.flipY = false;
      GeometryMesh.applyLightmapUV(this._geometryKind, this._geometry);
    }
    mat.aoMap = texture;
    mat.needsUpdate = true;
  }

  /** Authored strength of the AO map (0..1). Unaffected by runtime suppression. */
  get aoMapIntensity(): number {
    return this._aoMapIntensity;
  }
  set aoMapIntensity(value: number) {
    this._aoMapIntensity = clamp01Number(value);
    const mat = this._colorMaterial;
    if (mat && !this._aoSuppressed) {
      mat.aoMapIntensity = this._aoMapIntensity;
    }
  }

  /**
   * Runtime-only: suppress (or restore) the baked AO map's contribution without
   * touching the authored intensity. Used by the AO-mode cascade so a scene set
   * to realtime SSAO doesn't double up with its baked maps.
   */
  setAOSuppressed(suppressed: boolean): void {
    this._aoSuppressed = suppressed;
    const mat = this._colorMaterial;
    if (mat) {
      mat.aoMapIntensity = suppressed ? 0 : this._aoMapIntensity;
    }
  }

  /** res:// path of the baked AO map, or '' when none. Set by the AO baker. */
  get aoMapSrc(): string {
    return this._aoMapSrc;
  }
  set aoMapSrc(value: string) {
    this._aoMapSrc = typeof value === 'string' ? value : '';
  }

  /**
   * Assign (or clear) the albedo (diffuse) map. 3D textures keep mipmaps (unlike
   * the 2D pipeline); only the colour space is forced. The res:// path is tracked
   * separately in `_mapSrc` for serialization.
   */
  setMap(texture: Texture | null): void {
    const mat = this._colorMaterial;
    if (!mat) {
      return;
    }
    if (texture) {
      texture.colorSpace = SRGBColorSpace;
    }
    mat.map = texture;
    mat.needsUpdate = true;
  }

  /**
   * Update the authored albedo-map path from an inspector resource value
   * (`{ type: 'texture', url }` or a plain string). The Texture is loaded by the
   * editor viewport sync / scene loader, mirroring Sprite3D's texture ref.
   */
  setMapResource(value: unknown): void {
    this._mapSrc = readResourceUrl(value);
  }

  /** res:// path of the albedo map, or '' when none. */
  get mapSrc(): string {
    return this._mapSrc;
  }
  set mapSrc(value: string) {
    this._mapSrc = typeof value === 'string' ? value : '';
  }

  // ---------------------------------------------------------------------------
  // Shader effects (registry-backed attached list)
  // ---------------------------------------------------------------------------

  /** The shader-effect stack driving the mesh material (editor + script access). */
  getShaderEffectStack(): ShaderEffectStack {
    return this.effectStack;
  }

  /**
   * Wire the composer onto a freshly-built material via the effect stack, which
   * versions + injects the live attached-effect set (`onBeforeCompile` +
   * `customProgramCacheKey`) and syncs the `PIX3_FX_*` defines onto it.
   */
  private installEffectComposer(material: Material): void {
    this.effectStack.install(material);
  }

  /**
   * Attach a shader effect by registry id (e.g. `core:dissolve`). One instance
   * per type in v1 — a duplicate attach is a no-op. Returns whether it attached.
   */
  attachEffect(
    type: string,
    init?: { enabled?: boolean; params?: Record<string, unknown> }
  ): boolean {
    return this.effectStack.attach(type, init);
  }

  /** Detach an effect by type. Returns the removed attachment (for undo) or null. */
  detachEffect(type: string): AttachedShaderEffect | null {
    return this.effectStack.detach(type);
  }

  /** Enable/disable an attached effect (recompiles the program). */
  setEffectEnabled(type: string, on: boolean): void {
    this.effectStack.setEnabled(type, on);
  }

  /** The attached effects, in composition order (read-only view). */
  getAttachedEffects(): readonly AttachedShaderEffect[] {
    return this.effectStack.getAttached();
  }

  /**
   * Per-instance schema: the attached effects' params as `fx.<key>.<param>`
   * props (+ `fx.<key>.enabled`). Merged after the static schema by
   * `getNodePropertySchema` — so effect params are inspectable, keyframe-
   * animatable, undoable, and prefab-diffable. See {@link ShaderEffectStack}.
   */
  getInstancePropertySchema(): PropertySchema | null {
    return this.effectStack.buildInstanceSchema();
  }

  /** Play-mode only: advance any effect with a per-frame CPU update (uv-scroll). */
  override tick(dt: number): void {
    this.effectStack.tick(dt);
    super.tick(dt);
  }

  /**
   * Generate a deterministic, non-overlapping lightmap UV set (`uv1`) for a
   * primitive. A box needs a real 6-face atlas (its base `uv` overlaps faces);
   * the other primitives already have a unique [0,1] layout, so their base `uv`
   * is copied. Idempotent and cheap.
   */
  private static applyLightmapUV(kind: GeometryKind, geometry?: BufferGeometry): void {
    if (!geometry) {
      return;
    }
    const uv = geometry.getAttribute('uv');
    if (!uv) {
      return;
    }

    if (kind === 'box') {
      // BoxGeometry: 24 verts, 4 per face, faces in constructor order; each
      // face's base uv spans [0,1]. Pack the 6 faces into a 3x2 atlas with a
      // small inset so filtering doesn't bleed between cells.
      const cols = 3;
      const rows = 2;
      const cw = 1 / cols;
      const ch = 1 / rows;
      const inset = 0.04;
      const out = new Float32Array(uv.count * 2);
      for (let i = 0; i < uv.count; i += 1) {
        const face = Math.floor(i / 4) % 6;
        const col = face % cols;
        const row = Math.floor(face / cols);
        const u = uv.getX(i);
        const v = uv.getY(i);
        out[i * 2] = (col + inset + u * (1 - 2 * inset)) * cw;
        out[i * 2 + 1] = (row + inset + v * (1 - 2 * inset)) * ch;
      }
      geometry.setAttribute('uv1', new Float32BufferAttribute(out, 2));
      return;
    }

    // Other primitives: reuse the base UV as the lightmap UV.
    geometry.setAttribute('uv1', new Float32BufferAttribute(uv.array.slice(0), uv.itemSize));
  }

  get geometryKind(): GeometryKind {
    return this._geometryKind;
  }
  set geometryKind(value: string) {
    const next = normalizeGeometryKind(value);
    if (next !== this._geometryKind) {
      this._geometryKind = next;
      this.rebuildGeometry();
    }
  }

  /** Current `[x, y, z]` size vector (see {@link buildGeometry} for per-shape meaning). */
  get size(): [number, number, number] {
    return [this._size[0], this._size[1], this._size[2]];
  }
  set size(value: [number, number, number]) {
    this._size = [
      Number.isFinite(value[0]) ? value[0] : this._size[0],
      Number.isFinite(value[1]) ? value[1] : this._size[1],
      Number.isFinite(value[2]) ? value[2] : this._size[2],
    ];
    this.rebuildGeometry();
  }

  /**
   * Authored configuration as a plain object for scene serialization. Reads the
   * LIVE material so inspector edits (which mutate the three.js material in
   * place, not `node.properties`) survive save and the play-mode serialize→parse
   * clone. Keys match the loader's expected property names one-to-one; the
   * transform is serialized separately by the generic Node3D path.
   */
  serializeConfig(): Record<string, unknown> {
    const colorMat = this._colorMaterial;
    const material: Record<string, unknown> = { type: this._materialType };
    if (colorMat) {
      material.color = '#' + colorMat.color.getHexString();
    }
    // Roughness/metalness are meaningless off `standard`; writing them anyway would resurrect PBR
    // values the moment someone switched the material back, which is not what they authored.
    const std = this._stdMaterial;
    if (std) {
      material.roughness = std.roughness;
      material.metalness = std.metalness;
    }
    if (this._aoMapSrc) {
      material.aoMap = this._aoMapSrc;
      material.aoMapIntensity = this._aoMapIntensity;
    }
    if (this._mapSrc) {
      material.map = this._mapSrc;
    }
    if (!this.effectStack.isEmpty) {
      material.effects = this.effectStack.serialize();
    }
    return {
      geometry: this._geometryKind,
      size: [this._size[0], this._size[1], this._size[2]],
      material,
    };
  }

  private get _mesh(): Mesh | undefined {
    return (this.children as unknown as Mesh[]).find(c => c instanceof Mesh);
  }

  /**
   * The material as "something with a colour and a map" — true of all three families.
   * Colour edits must keep working when the mesh is not PBR, which `_stdMaterial` cannot express.
   */
  private get _colorMaterial(): MappedMaterial | undefined {
    const mat = this._mesh?.material;
    return mat && !Array.isArray(mat) && 'color' in mat ? (mat as MappedMaterial) : undefined;
  }

  private get _stdMaterial(): MeshStandardMaterial | undefined {
    const mat = this._mesh?.material;
    return mat instanceof MeshStandardMaterial ? mat : undefined;
  }

  static override getPropertySchema(): PropertySchema {
    const base = super.getPropertySchema();
    const props: PropertySchema = {
      nodeType: 'GeometryMesh',
      properties: [
        defineProperty('geometry', 'enum', {
          ui: { label: 'Shape', group: 'Geometry', options: [...GEOMETRY_KINDS] },
          getValue: (n: unknown) => (n as GeometryMesh).geometryKind,
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).geometryKind = String(v);
          },
        }),
        defineProperty('size', 'vector3', {
          ui: {
            label: 'Size',
            description: 'Interpreted per shape (box: extents, sphere: diameter, etc.)',
            group: 'Geometry',
            min: 0,
            step: 0.01,
            precision: 2,
          },
          getValue: (n: unknown) => {
            const s = (n as GeometryMesh)._size;
            return { x: s[0], y: s[1], z: s[2] };
          },
          setValue: (n: unknown, v: unknown) => {
            const vec = v as { x?: unknown; y?: unknown; z?: unknown };
            (n as GeometryMesh).size = [Number(vec?.x), Number(vec?.y), Number(vec?.z)];
          },
        }),
        defineProperty('materialType', 'enum', {
          ui: {
            label: 'Material',
            description:
              'standard = PBR (desktop look), lambert = diffuse-only (the mobile default), basic = unlit (needs no light at all)',
            group: 'Material',
            options: [...GEOMETRY_MATERIAL_TYPES],
          },
          getValue: (n: unknown) => (n as GeometryMesh).materialType,
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).materialType = String(v) as GeometryMaterialType;
          },
        }),
        defineProperty('color', 'color', {
          ui: { label: 'Color', group: 'Material' },
          getValue: (n: unknown) => {
            const mat = (n as GeometryMesh)._colorMaterial;
            return mat ? '#' + mat.color.getHexString() : '#4e8df5';
          },
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._colorMaterial;
            if (mat) mat.color.set(String(v));
          },
        }),
        defineProperty('roughness', 'number', {
          ui: {
            label: 'Roughness',
            group: 'Material',
            step: 0.01,
            precision: 2,
            min: 0,
            max: 1,
            // Only `standard` has these; greyed out rather than hidden so the reason a value does
            // nothing is visible next to the material picker that caused it.
            readOnly: t => !(t as GeometryMesh)._stdMaterial,
          },
          getValue: (n: unknown) => (n as GeometryMesh)._stdMaterial?.roughness ?? 0.35,
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            if (mat) mat.roughness = Number(v);
          },
        }),
        defineProperty('metalness', 'number', {
          ui: {
            label: 'Metalness',
            group: 'Material',
            step: 0.01,
            precision: 2,
            min: 0,
            max: 1,
            readOnly: t => !(t as GeometryMesh)._stdMaterial,
          },
          getValue: (n: unknown) => (n as GeometryMesh)._stdMaterial?.metalness ?? 0.25,
          setValue: (n: unknown, v: unknown) => {
            const mat = (n as GeometryMesh)._stdMaterial;
            if (mat) mat.metalness = Number(v);
          },
        }),
        defineProperty('aoMapIntensity', 'number', {
          ui: {
            label: 'AO Intensity',
            description: 'Strength of the baked ambient-occlusion map (0 = off)',
            group: 'Material',
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2,
            slider: true,
            readOnly: t => !(t as GeometryMesh)._colorMaterial?.aoMap,
          },
          getValue: (n: unknown) => (n as GeometryMesh).aoMapIntensity,
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).aoMapIntensity = Number(v);
          },
        }),
        defineProperty('map', 'object', {
          ui: {
            label: 'Albedo Map',
            description:
              'Diffuse texture (res://). Required for the UV Scroll effect to be visible.',
            group: 'Material',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (n: unknown) => ({ type: 'texture', url: (n as GeometryMesh)._mapSrc }),
          setValue: (n: unknown, v: unknown) => {
            (n as GeometryMesh).setMapResource(v);
          },
        }),
      ],
      groups: {
        Geometry: { label: 'Geometry', expanded: true },
        Material: { label: 'Material', expanded: true },
      },
    };

    return mergeSchemas(base, props);
  }
}

function normalizeGeometryKind(value: unknown): GeometryKind {
  const kind = typeof value === 'string' ? value.toLowerCase() : '';
  return (GEOMETRY_KINDS as readonly string[]).includes(kind) ? (kind as GeometryKind) : 'box';
}

function clamp01Number(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 1;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Pull a res:// url out of an inspector resource value (or plain string). */
function readResourceUrl(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const url = (value as { url?: unknown }).url;
    if (typeof url === 'string') {
      return url;
    }
  }
  return '';
}
