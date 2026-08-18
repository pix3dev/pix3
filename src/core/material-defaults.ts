import { appState } from '@/state';
import { DEFAULT_GEOMETRY_MATERIAL_TYPE, type GeometryMaterialType } from '@pix3/runtime';

/**
 * The material family new 3D geometry is created with, decided by the project's target platform.
 *
 * The engine's *node* default stays PBR (`standard`) so nothing already authored changes on read —
 * this is a creation-time policy, applied only where the editor makes a new mesh. What it encodes:
 * mobile is the default target, and PBR shading is a desktop-class cost that a phone pays on every
 * pixel for a look nobody asked for. Only a project that explicitly says `desktop` gets it.
 *
 * `universal` is treated as mobile on purpose: a universal build runs on phones too, and the
 * cheaper material is the one that is safe to be wrong about.
 */
export const defaultMaterialTypeForProject = (): GeometryMaterialType =>
  appState.project.manifest?.targetPlatform === 'desktop'
    ? DEFAULT_GEOMETRY_MATERIAL_TYPE
    : 'lambert';
