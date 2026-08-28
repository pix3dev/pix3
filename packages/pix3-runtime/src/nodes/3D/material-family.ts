import {
  Color,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
} from 'three';

/**
 * The three material families authored 3D geometry can be built from, and the one function that
 * builds them.
 *
 * Extracted from `GeometryMesh` because it was never mesh-specific: `InstancedMesh3D` is the same
 * question asked about hundreds of copies of one mesh, which is precisely the case where the
 * material family costs the most. It lived as a private static there, so a scene-authored instanced
 * mesh got no material at all and fell back to a shared white PBR default — invisible in the
 * inspector, and the exact opposite of the mobile policy the rest of the engine follows.
 *
 * - `standard` — PBR. Desktop-class per-pixel cost; the node-level default, for back-compat.
 * - `lambert` — diffuse-only. The shapes still read, at a fraction of the cost. Right for a phone.
 * - `basic` — unlit flat colour. Cheapest, and the only family that cannot render black for want
 *   of a light.
 */
export const GEOMETRY_MATERIAL_TYPES = ['standard', 'lambert', 'basic'] as const;
export type GeometryMaterialType = (typeof GEOMETRY_MATERIAL_TYPES)[number];

/**
 * What a node built with no authored `material.type` gets.
 *
 * Deliberately PBR: this is the *engine* default, so nothing already authored changes meaning on
 * read. Preferring the cheap family is a creation-time policy the editor applies
 * (`defaultMaterialTypeForProject`), not a reinterpretation of existing scene files.
 */
export const DEFAULT_GEOMETRY_MATERIAL_TYPE: GeometryMaterialType = 'standard';

/** Coerce an authored/serialized value to a family, falling back to the default. */
export const asMaterialType = (value: unknown): GeometryMaterialType =>
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
export const effectTargetFor = (type: GeometryMaterialType): 'standard' | 'basic' =>
  type === 'basic' ? 'basic' : 'standard';

/**
 * Which family a live material belongs to, or `null` for anything outside the three.
 *
 * Read off three's own `isMesh*Material` flags rather than `instanceof`, so it also answers for a
 * material built by another copy of three. A node that takes a material from code uses this to keep
 * its authored family honest — otherwise it would go on serializing the family it was *authored*
 * with while rendering something else.
 */
export const materialFamilyOf = (material: unknown): GeometryMaterialType | null => {
  const flags = material as Record<string, unknown> | null | undefined;
  if (flags?.isMeshStandardMaterial === true || flags?.isMeshPhysicalMaterial === true) {
    return 'standard';
  }
  if (flags?.isMeshLambertMaterial === true) {
    return 'lambert';
  }
  if (flags?.isMeshBasicMaterial === true) {
    return 'basic';
  }
  return null;
};

/**
 * Build the three.js material for a family. `roughness`/`metalness` exist only on `standard`; the
 * other two ignore them, and serialization stops writing them so a round-trip does not resurrect
 * PBR values on a mesh that has no use for them.
 */
export const buildFamilyMaterial = (
  type: GeometryMaterialType,
  opts: { color: Color; roughness: number; metalness: number }
): Material => {
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
};
