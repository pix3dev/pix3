import { describe, expect, it } from 'vitest';
import { expandScatterDirectives } from '@/services/model-gen/scene/scene-scatter';

interface NodeLike {
  id?: string;
  type?: string;
  name?: string;
  instance?: string;
  properties?: Record<string, unknown>;
  children?: NodeLike[];
}

const scatterDoc = (overrides: Record<string, unknown> = {}): { version: string; root: NodeLike[] } => ({
  version: '1.0',
  root: [
    {
      id: 'rocks',
      type: 'Scatter',
      name: 'Rock field',
      properties: {
        asset: 'res://props/rock.glb',
        count: 5,
        seed: 7,
        area: { center: [0, 0, 0], size: [10, 10] },
        scaleRange: [0.5, 1.5],
        rotationYRange: [0, 360],
        ...overrides,
      },
    },
  ],
});

const rootNodes = (doc: unknown): NodeLike[] => (doc as { root: NodeLike[] }).root;

describe('expandScatterDirectives', () => {
  it('replaces a Scatter node with a Group of `count` concrete children', () => {
    const result = expandScatterDirectives(scatterDoc());
    expect(result.expandedCount).toBe(1);
    expect(result.warnings).toEqual([]);
    const [group] = rootNodes(result.doc);
    expect(group.type).toBe('Group');
    expect(group.id).toBe('rocks');
    expect(group.name).toBe('Rock field');
    expect(group.children).toHaveLength(5);
    expect(group.children?.map(child => child.id)).toEqual([
      'rocks-0',
      'rocks-1',
      'rocks-2',
      'rocks-3',
      'rocks-4',
    ]);
  });

  it('is fully deterministic for a fixed seed', () => {
    const a = expandScatterDirectives(scatterDoc());
    const b = expandScatterDirectives(scatterDoc());
    expect(JSON.stringify(rootNodes(a.doc))).toEqual(JSON.stringify(rootNodes(b.doc)));
  });

  it('produces different layouts for different seeds', () => {
    const a = expandScatterDirectives(scatterDoc({ seed: 1 }));
    const b = expandScatterDirectives(scatterDoc({ seed: 2 }));
    expect(JSON.stringify(rootNodes(a.doc))).not.toEqual(JSON.stringify(rootNodes(b.doc)));
  });

  it('emits MeshInstance children for a .glb asset with src set', () => {
    const result = expandScatterDirectives(scatterDoc());
    const child = rootNodes(result.doc)[0].children?.[0];
    expect(child?.type).toBe('MeshInstance');
    expect(child?.properties?.src).toBe('res://props/rock.glb');
    expect(child?.properties?.transform).toBeDefined();
  });

  it('emits prefab instance children (no type) for a .pix3scene asset', () => {
    const result = expandScatterDirectives(scatterDoc({ asset: 'res://prefabs/bush.pix3scene' }));
    const child = rootNodes(result.doc)[0].children?.[0];
    expect(child?.type).toBeUndefined();
    expect(child?.instance).toBe('res://prefabs/bush.pix3scene');
    expect(child?.properties?.transform).toBeDefined();
  });

  it('honors idPrefix for child ids', () => {
    const result = expandScatterDirectives(scatterDoc({ idPrefix: 'boulder' }));
    expect(rootNodes(result.doc)[0].children?.map(child => child.id)).toEqual([
      'boulder-0',
      'boulder-1',
      'boulder-2',
      'boulder-3',
      'boulder-4',
    ]);
  });

  it('keeps positions within the scatter area rectangle', () => {
    const result = expandScatterDirectives(scatterDoc());
    for (const child of rootNodes(result.doc)[0].children ?? []) {
      const position = (child.properties?.transform as { position: number[] }).position;
      expect(position[0]).toBeGreaterThanOrEqual(-5);
      expect(position[0]).toBeLessThanOrEqual(5);
      expect(position[2]).toBeGreaterThanOrEqual(-5);
      expect(position[2]).toBeLessThanOrEqual(5);
    }
  });

  it('leaves a directive missing asset unexpanded and warns', () => {
    const doc = scatterDoc();
    delete (rootNodes(doc)[0].properties as Record<string, unknown>).asset;
    const result = expandScatterDirectives(doc);
    expect(result.expandedCount).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(rootNodes(result.doc)[0].type).toBe('Scatter');
  });

  it('leaves a directive missing count unexpanded and warns', () => {
    const doc = scatterDoc();
    delete (rootNodes(doc)[0].properties as Record<string, unknown>).count;
    const result = expandScatterDirectives(doc);
    expect(result.expandedCount).toBe(0);
    expect(result.warnings.some(warning => warning.includes('count'))).toBe(true);
    expect(rootNodes(result.doc)[0].type).toBe('Scatter');
  });

  it('expands nested Scatter nodes under children', () => {
    const doc = {
      version: '1.0',
      root: [
        {
          id: 'world',
          type: 'Group',
          children: [
            {
              id: 'trees',
              type: 'Scatter',
              properties: { asset: 'res://props/tree.glb', count: 3, seed: 1, area: { center: [0, 0, 0], size: [4, 4] } },
            },
          ],
        },
      ],
    };
    const result = expandScatterDirectives(doc);
    expect(result.expandedCount).toBe(1);
    const nested = rootNodes(result.doc)[0].children?.[0];
    expect(nested?.type).toBe('Group');
    expect(nested?.children).toHaveLength(3);
  });

  it('passes a doc with no Scatter nodes through unchanged', () => {
    const doc = { version: '1.0', root: [{ id: 'a', type: 'Group', children: [] }] };
    const result = expandScatterDirectives(doc);
    expect(result.expandedCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.doc).toBe(doc);
  });

  it('tolerates non-object input', () => {
    expect(expandScatterDirectives(null).expandedCount).toBe(0);
    expect(expandScatterDirectives('nope').expandedCount).toBe(0);
    expect(expandScatterDirectives(42).expandedCount).toBe(0);
  });
});
