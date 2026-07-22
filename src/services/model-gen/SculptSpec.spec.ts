import { describe, expect, it } from 'vitest';
import { validateSculptSpec, type SculptSpec } from '@/services/model-gen/SculptSpec';

/** A minimal spec that passes every rule; tests clone + mutate it to exercise each failure. */
const validSpec = (): SculptSpec => ({
  objectClass: 'brass cog',
  category: 'object',
  complexity: 'simple',
  summary: 'A single brass cog.',
  materials: [
    { id: 'brass', name: 'Brass', baseColorHex: '#c08a3e', metalness: 0.85, roughness: 0.35 },
  ],
  components: [{ id: 'body', name: 'Cog body', materialId: 'brass' }],
  detailInventory: ['toothed rim', 'central hub'],
});

describe('validateSculptSpec', () => {
  it('accepts a well-formed spec', () => {
    const result = validateSculptSpec(validSpec());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a spec with no materials', () => {
    const spec = { ...validSpec(), materials: [] };
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('materials'))).toBe(true);
  });

  it('rejects out-of-range roughness', () => {
    const spec = validSpec();
    spec.materials[0].roughness = 1.5;
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('roughness'))).toBe(true);
  });

  it('rejects a malformed hex color', () => {
    const spec = validSpec();
    spec.materials[0].baseColorHex = 'c08a3e';
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('baseColorHex'))).toBe(true);
  });

  it('rejects a component referencing an unknown material', () => {
    const spec = validSpec();
    spec.components[0].materialId = 'gold';
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('materialId'))).toBe(true);
  });

  it('rejects too few components for the declared complexity', () => {
    const spec: SculptSpec = { ...validSpec(), complexity: 'complex' };
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('at least 5 components'))).toBe(true);
  });

  it('rejects an empty detail inventory', () => {
    const spec = { ...validSpec(), detailInventory: [] };
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('detailInventory'))).toBe(true);
  });

  it('rejects a non-object category', () => {
    const spec = { ...validSpec(), category: 'character' };
    const result = validateSculptSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('category'))).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(validateSculptSpec(null).ok).toBe(false);
    expect(validateSculptSpec('nope').ok).toBe(false);
    expect(validateSculptSpec([]).ok).toBe(false);
    expect(validateSculptSpec(42).ok).toBe(false);
  });
});
