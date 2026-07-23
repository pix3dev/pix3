import { describe, expect, it } from 'vitest';
import { validateLevelSpec, type LevelSpec } from '@/services/model-gen/scene/LevelSpec';

const KNOWN = new Set(['rock-a', 'tree-b', 'shrine-prefab']);

/** A minimal spec that passes every rule; tests clone + mutate it to exercise each failure. */
const validSpec = (): LevelSpec => ({
  title: 'Desert canyon arena',
  brief: 'A desert canyon arena with a central shrine.',
  zones: [
    { id: 'arena', name: 'Arena floor', purpose: 'The central combat space.', paletteAssetIds: ['rock-a'] },
    { id: 'shrine', name: 'Shrine', purpose: 'Focal structure.', paletteAssetIds: ['shrine-prefab'] },
  ],
  lightingPlan: 'Warm low-angle desert sun with soft ambient fill.',
  cameraIntent: 'A 3/4 view framing the shrine.',
  paletteAssetIds: ['rock-a', 'tree-b', 'shrine-prefab'],
});

describe('validateLevelSpec', () => {
  it('accepts a well-formed spec', () => {
    const result = validateLevelSpec(validSpec(), KNOWN);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a missing title', () => {
    const spec = { ...validSpec(), title: '   ' };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('title'))).toBe(true);
  });

  it('rejects an empty zones array', () => {
    const spec = { ...validSpec(), zones: [] };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('zones'))).toBe(true);
  });

  it('rejects a zone missing its purpose', () => {
    const spec = validSpec();
    spec.zones[0] = { id: 'arena', name: 'Arena floor', purpose: '' };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('purpose'))).toBe(true);
  });

  it('rejects a dangling top-level palette reference', () => {
    const spec = validSpec();
    spec.paletteAssetIds = ['rock-a', 'ghost-asset'];
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('ghost-asset'))).toBe(true);
  });

  it('rejects a dangling per-zone palette reference', () => {
    const spec = validSpec();
    spec.zones[0].paletteAssetIds = ['does-not-exist'];
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('does-not-exist'))).toBe(true);
  });

  it('rejects garbage input', () => {
    expect(validateLevelSpec(null, KNOWN).ok).toBe(false);
    expect(validateLevelSpec('nope', KNOWN).ok).toBe(false);
    expect(validateLevelSpec([], KNOWN).ok).toBe(false);
    expect(validateLevelSpec(42, KNOWN).ok).toBe(false);
  });

  it('accepts a well-formed paletteGaps array and keeps it', () => {
    const spec = {
      ...validSpec(),
      paletteGaps: [{ need: 'A stone fountain', suggestedPrompt: 'A weathered stone fountain, 3D model.' }],
    };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(true);
    expect(spec.paletteGaps).toHaveLength(1);
  });

  it('repairs a malformed paletteGaps by dropping bad entries', () => {
    const spec: Record<string, unknown> = {
      ...validSpec(),
      paletteGaps: [
        { need: 'ok', suggestedPrompt: 'prompt' },
        { need: 'missing prompt' },
        'garbage',
        { need: '', suggestedPrompt: 'empty need' },
      ],
    };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(true);
    expect(spec.paletteGaps).toEqual([{ need: 'ok', suggestedPrompt: 'prompt' }]);
  });

  it('drops a non-array paletteGaps entirely without failing', () => {
    const spec: Record<string, unknown> = { ...validSpec(), paletteGaps: 'not an array' };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(true);
    expect(spec.paletteGaps).toBeUndefined();
  });

  it('drops a paletteGaps with no valid entries', () => {
    const spec: Record<string, unknown> = { ...validSpec(), paletteGaps: [{ need: 'no prompt' }] };
    const result = validateLevelSpec(spec, KNOWN);
    expect(result.ok).toBe(true);
    expect(spec.paletteGaps).toBeUndefined();
  });
});
