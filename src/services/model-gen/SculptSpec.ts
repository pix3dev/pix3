/**
 * Types + a deterministic (zero-token) validator for the Model Lab "sculpt spec" — the structured
 * plan a codegen model produces before it writes the procedural Three.js factory. The validator is a
 * port of img2threejs's `validate_sculpt_spec` quality gate: it blocks shallow / malformed specs
 * before any factory codegen is spent on them.
 *
 * Kept pure (no DI, no I/O) so it is trivially unit-testable and callable from anywhere.
 */

import type { ComplexityHint } from '@/services/model-gen/model-gen-types';

/** Vision-stage read of the reference image: what it is + how hard it is to reconstruct. */
export interface Assessment {
  objectClass: string;
  category: 'object' | 'character' | 'unknown';
  complexity: ComplexityHint;
  detailInventory: string[];
  notes?: string;
}

/** A PBR material referenced by components. */
export interface SculptMaterial {
  id: string;
  name: string;
  /** `#RRGGBB`. */
  baseColorHex: string;
  metalness: number;
  roughness: number;
  notes?: string;
}

/** One part of the object's component hierarchy. */
export interface SculptComponent {
  id: string;
  name: string;
  role?: string;
  parentId?: string | null;
  approxSizeMeters?: [number, number, number];
  materialId?: string;
  notes?: string;
}

/** The full plan for a hard-surface object reconstruction. */
export interface SculptSpec {
  objectClass: string;
  category: 'object';
  complexity: ComplexityHint;
  summary: string;
  components: SculptComponent[];
  materials: SculptMaterial[];
  detailInventory: string[];
}

/** Result of {@link validateSculptSpec}: `ok` plus a human-readable error list (empty when ok). */
export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

/** Minimum component count for a given complexity — deeper subjects must plan more parts. */
const COMPLEXITY_MIN_COMPONENTS: Record<ComplexityHint, number> = {
  simple: 1,
  moderate: 3,
  complex: 5,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COMPLEXITIES: readonly ComplexityHint[] = ['simple', 'moderate', 'complex'];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isComplexity = (value: unknown): value is ComplexityHint =>
  typeof value === 'string' && (COMPLEXITIES as readonly string[]).includes(value);

/**
 * Deterministically validate an untrusted (LLM-produced) sculpt spec. Rules:
 * - it must be a JSON object;
 * - `category` must be `"object"` (character/unknown are rejected here — handled upstream);
 * - `components` non-empty, and at least the complexity's minimum count;
 * - `materials` non-empty, each with a `#RRGGBB` `baseColorHex` and `metalness`/`roughness` in [0,1];
 * - every `component.materialId` (when set) must resolve to a declared material;
 * - `detailInventory` non-empty.
 */
export function validateSculptSpec(spec: unknown): SpecValidation {
  if (!isRecord(spec)) {
    return { ok: false, errors: ['Spec must be a JSON object.'] };
  }

  const errors: string[] = [];

  if (spec.category !== 'object') {
    errors.push(`category must be "object" (got ${JSON.stringify(spec.category)}).`);
  }

  const complexity = isComplexity(spec.complexity) ? spec.complexity : null;
  if (!complexity) {
    errors.push(
      `complexity must be one of simple|moderate|complex (got ${JSON.stringify(spec.complexity)}).`
    );
  }

  // Materials first: build the id set that components reference.
  const materialIds = new Set<string>();
  if (!Array.isArray(spec.materials) || spec.materials.length === 0) {
    errors.push('materials must be a non-empty array.');
  } else {
    spec.materials.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`materials[${index}] must be an object.`);
        return;
      }
      if (typeof raw.id !== 'string' || !raw.id) {
        errors.push(`materials[${index}].id must be a non-empty string.`);
      } else {
        materialIds.add(raw.id);
      }
      if (!isFiniteNumber(raw.metalness) || raw.metalness < 0 || raw.metalness > 1) {
        errors.push(`materials[${index}].metalness must be a number in [0, 1].`);
      }
      if (!isFiniteNumber(raw.roughness) || raw.roughness < 0 || raw.roughness > 1) {
        errors.push(`materials[${index}].roughness must be a number in [0, 1].`);
      }
      if (typeof raw.baseColorHex !== 'string' || !HEX_COLOR.test(raw.baseColorHex)) {
        errors.push(`materials[${index}].baseColorHex must match "#RRGGBB".`);
      }
    });
  }

  if (!Array.isArray(spec.components) || spec.components.length === 0) {
    errors.push('components must be a non-empty array.');
  } else {
    if (complexity && spec.components.length < COMPLEXITY_MIN_COMPONENTS[complexity]) {
      errors.push(
        `complexity "${complexity}" requires at least ${COMPLEXITY_MIN_COMPONENTS[complexity]} ` +
          `components (got ${spec.components.length}).`
      );
    }
    spec.components.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`components[${index}] must be an object.`);
        return;
      }
      if (typeof raw.id !== 'string' || !raw.id) {
        errors.push(`components[${index}].id must be a non-empty string.`);
      }
      if (raw.materialId !== undefined && raw.materialId !== null) {
        if (typeof raw.materialId !== 'string' || !materialIds.has(raw.materialId)) {
          errors.push(
            `components[${index}].materialId ${JSON.stringify(raw.materialId)} does not resolve ` +
              `to a declared material.`
          );
        }
      }
    });
  }

  if (!Array.isArray(spec.detailInventory) || spec.detailInventory.length === 0) {
    errors.push('detailInventory must be a non-empty array.');
  }

  return { ok: errors.length === 0, errors };
}
