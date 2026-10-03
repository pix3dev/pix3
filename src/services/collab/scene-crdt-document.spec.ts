import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parse, stringify } from 'yaml';
import {
  SCENE_FIELD_PREFIX,
  sameSceneField,
  sceneFieldsFromSnapshot,
  sceneSnapshotFromFields,
  type SceneFields,
} from '@pix3/collab-document';
import type { MergeDoc, MergeNode } from '@/services/project/external-merge/scene-doc';

const field = (...path: string[]) => SCENE_FIELD_PREFIX + JSON.stringify(path);
const encode = (doc: MergeDoc, previous?: SceneFields) =>
  sceneFieldsFromSnapshot(stringify(doc), previous);
const decode = (fields: SceneFields) => parse(sceneSnapshotFromFields(fields)) as MergeDoc;
const node = (id: string, own: Record<string, unknown> = {}): MergeNode => ({ id, ...own });
const doc = (...nodes: MergeNode[]): MergeDoc => ({ version: '1.0.0', root: nodes });

function writeDelta(map: Y.Map<unknown>, previous: SceneFields, next: SceneFields): void {
  for (const key of previous.keys()) if (!next.has(key)) map.set(key, { kind: 'deleted' });
  for (const [key, value] of next) {
    if (!previous.has(key) || !sameSceneField(previous.get(key), value)) map.set(key, value);
  }
}

/** Real disconnected Yjs replicas, exercising both possible deterministic LWW winners. */
function merge(
  initial: MergeDoc,
  first: (doc: MergeDoc) => void,
  second: (doc: MergeDoc) => void,
  reverseClients = false
): { document: MergeDoc; fields: SceneFields } {
  const baseline = encode(initial);
  const seed = new Y.Doc();
  seed.clientID = 1;
  for (const [key, value] of baseline) seed.getMap('scene').set(key, value);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(seed));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(seed));
  a.clientID = reverseClients ? 3 : 2;
  b.clientID = reverseClients ? 2 : 3;
  const left = structuredClone(initial);
  const right = structuredClone(initial);
  first(left);
  second(right);
  a.transact(() => writeDelta(a.getMap('scene'), baseline, encode(left, baseline)));
  b.transact(() => writeDelta(b.getMap('scene'), baseline, encode(right, baseline)));
  const aUpdate = Y.encodeStateAsUpdate(a);
  const bUpdate = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bUpdate);
  Y.applyUpdate(b, aUpdate);
  const fields = new Map(a.getMap('scene'));
  const document = decode(fields);
  expect(decode(new Map(b.getMap('scene')))).toEqual(document);
  expect(decode(new Map([...fields].reverse()))).toEqual(document);
  seed.destroy();
  a.destroy();
  b.destroy();
  return { document, fields };
}

describe('collaborative scene field codec', () => {
  it('round trips structural trees, document fields, empty objects, components and atomic arrays', () => {
    const original = {
      ...doc(
        node('parent', {
          name: 'Parent',
          properties: { empty: {}, position: [1, 2, 3], keyframes: [{ at: 0, value: 2 }] },
          components: [
            { id: 'component/["id"]', type: 'core:One', enabled: true, config: { a: 1, b: {} } },
            { id: '__proto__', type: 'core:Two', config: { vector: [2, 3] } },
          ],
          children: [node('child', { children: [], components: [] })],
        })
      ),
      metadata: { nested: { empty: {} }, tags: ['one', 'two'] },
    };
    const fields = encode(original);
    expect(decode(fields)).toEqual(original);
    expect(fields.get(field('node', 'parent', 'properties', 'position'))).toEqual({
      kind: 'value',
      value: [1, 2, 3],
    });
    expect([...fields.keys()].some(key => key.includes('component-order'))).toBe(true);
    expect(encode(decode(fields), fields)).toEqual(fields);
  });

  it('preserves authored components without IDs as atomic legacy arrays', () => {
    const original = doc(
      node('a', { components: [{ type: 'core:Legacy', config: { value: 1 } }] })
    );
    expect(decode(encode(original))).toEqual(original);
  });

  it('rejects duplicate nodes, malformed children and duplicate component IDs', () => {
    expect(() => encode(doc(node('a'), node('a')))).toThrow('Duplicate node IDs');
    expect(() => sceneFieldsFromSnapshot('root: [{ id: a, children: no }]')).toThrow('children');
    expect(() => encode(doc(node('a', { components: [{ id: 'c' }, { id: 'c' }] })))).toThrow(
      'Duplicate component IDs'
    );
  });

  it('preserves existing sibling ranks on prepend, insertion and deletion', () => {
    const initial = doc(node('a'), node('b'), node('c'));
    const baseline = encode(initial);
    const changed = doc(node('new-first'), node('a'), node('new-middle'), node('c'));
    const fields = encode(changed, baseline);
    for (const id of ['a', 'c']) {
      expect(fields.get(field('order', id))).toEqual(baseline.get(field('order', id)));
      expect(fields.get(field('parent', id))).toEqual(baseline.get(field('parent', id)));
    }
    expect(decode(fields)).toEqual(changed);
  });

  it('uses an LCS to retain the largest unchanged sibling sequence on a reorder', () => {
    const initial = doc(node('a'), node('b'), node('c'), node('d'));
    const baseline = encode(initial);
    const changed = doc(node('b'), node('c'), node('a'), node('d'));
    const fields = encode(changed, baseline);
    for (const id of ['b', 'c', 'd'])
      expect(fields.get(field('order', id))).toEqual(baseline.get(field('order', id)));
    expect(fields.get(field('order', 'a'))).not.toEqual(baseline.get(field('order', 'a')));
    expect(decode(fields)).toEqual(changed);
  });

  it('retains fractional ranks when re-encoding against the effective shared baseline', () => {
    const initial = encode(doc(node('a'), node('b')));
    const inserted = encode(doc(node('a'), node('new'), node('b')), initial);
    const afterRead = decode(inserted);
    afterRead.root[0].name = 'unrelated property';
    const next = encode(afterRead, inserted);
    for (const id of ['a', 'new', 'b'])
      expect(next.get(field('order', id))).toBe(inserted.get(field('order', id)));
  });

  it.each(['exhausted', 'tied', 'overflow'] as const)(
    'reindexes only the affected sibling group when ranks are %s',
    problem => {
      const original = doc(node('a'), node('b'), node('parent', { children: [node('child')] }));
      const baseline = encode(original);
      baseline.set(field('order', 'a'), problem === 'overflow' ? -Number.MAX_VALUE : 1);
      baseline.set(
        field('order', 'b'),
        problem === 'exhausted'
          ? 1 + Number.EPSILON
          : problem === 'overflow'
            ? -Number.MAX_VALUE / 2
            : 1
      );
      baseline.set(field('order', 'child'), 12.5);
      const changed =
        problem === 'overflow'
          ? doc(node('new'), ...original.root)
          : doc(node('a'), node('new'), ...original.root.slice(1));
      const fields = encode(changed, baseline);
      expect(decode(fields)).toEqual(changed);
      expect(fields.get(field('order', 'child'))).toBe(12.5);
      expect(fields.get(field('order', 'a'))).not.toBe(baseline.get(field('order', 'a')));
    }
  );

  it('ignores malformed fields without letting them recreate missing ancestors', () => {
    const fields = encode(doc(node('a')));
    fields.set('field:invalid-json', 1);
    fields.set('field:[1]', { kind: 'object' });
    fields.set(field('node', 'a', 'missing', 'child'), { kind: 'value', value: 42 });
    expect(decode(fields)).toEqual(doc(node('a')));
  });

  describe.each([false, true])(
    'independent concurrent changes (reverse client IDs: %s)',
    reverse => {
      it('keeps different prepend and append insertions without moving old siblings', () => {
        const { document } = merge(
          doc(node('a'), node('b')),
          left => left.root.unshift(node('first')),
          right => right.root.push(node('last')),
          reverse
        );
        expect(document.root.map(node => node.id)).toEqual(['first', 'a', 'b', 'last']);
      });

      it('keeps concurrent insertions into the same gap in deterministic ID order', () => {
        const { document } = merge(
          doc(node('a'), node('b')),
          left => left.root.splice(1, 0, node('c')),
          right => right.root.splice(1, 0, node('d')),
          reverse
        );
        expect(document.root.map(node => node.id)).toEqual(['a', 'c', 'd', 'b']);
      });

      it('preserves reparenting beside an unrelated concurrent prepend', () => {
        const { document } = merge(
          doc(node('a'), node('b'), node('parent')),
          left => {
            const moved = left.root.shift()!;
            left.root[1].children = [moved];
          },
          right => right.root.unshift(node('new')),
          reverse
        );
        expect(document.root.map(node => node.id)).toEqual(['new', 'b', 'parent']);
        expect(document.root[2].children?.map(node => node.id)).toEqual(['a']);
      });

      it('preserves a subtree deletion beside a prepend and hidden child edits', () => {
        const { document } = merge(
          doc(node('a', { children: [node('child', { name: 'old' })] }), node('b')),
          left => {
            left.root.shift();
          },
          right => {
            right.root[0].children![0].name = 'concurrent';
            right.root.unshift(node('new'));
          },
          reverse
        );
        expect(document.root.map(node => node.id)).toEqual(['new', 'b']);
      });

      it.each(['deleted', 'scalar'] as const)(
        'does not rebuild a %s object from a concurrent descendant edit',
        kind => {
          const initial = doc(node('a', { properties: { options: { x: 1, nested: { y: 2 } } } }));
          const { document } = merge(
            initial,
            left => {
              const properties = left.root[0].properties as Record<string, unknown>;
              if (kind === 'deleted') delete properties.options;
              else properties.options = 'replacement';
            },
            right => {
              const properties = right.root[0].properties as {
                options: { x: number; nested: { y: number; z?: number } };
              };
              properties.options.x = 3;
              properties.options.nested.z = 4;
            },
            reverse
          );
          expect(document.root[0].properties).toEqual(
            kind === 'deleted' ? {} : { options: 'replacement' }
          );
        }
      );

      it('merges independent new nested objects without replacing shared ancestors', () => {
        const { document } = merge(
          doc(node('a')),
          left => {
            left.root[0].metadata = { x: 1 };
          },
          right => {
            right.root[0].metadata = { y: 2 };
          },
          reverse
        );
        expect(document.root[0].metadata).toEqual({ x: 1, y: 2 });
      });

      it('merges edits to separate components and separate config leaves of one component', () => {
        const initial = doc(
          node('a', {
            components: [
              { id: 'one', type: 'core:One', config: { x: 1, y: 2 } },
              { id: 'two', type: 'core:Two', enabled: true, config: { z: 3 } },
            ],
          })
        );
        const { document } = merge(
          initial,
          left => {
            const components = left.root[0].components as Array<{ config: Record<string, number> }>;
            components[0].config.x = 10;
          },
          right => {
            const components = right.root[0].components as Array<{
              enabled?: boolean;
              config: Record<string, number>;
            }>;
            components[0].config.y = 20;
            components[1].enabled = false;
            components[1].config.z = 30;
          },
          reverse
        );
        expect(document.root[0].components).toEqual([
          { id: 'one', type: 'core:One', config: { x: 10, y: 20 } },
          { id: 'two', type: 'core:Two', enabled: false, config: { z: 30 } },
        ]);
      });

      it('merges component additions without overwriting edits to an existing component', () => {
        const initial = doc(node('a', { components: [{ id: 'old', config: { value: 1 } }] }));
        const { document } = merge(
          initial,
          left => {
            (left.root[0].components as unknown[]).unshift({ id: 'first', config: { x: 1 } });
          },
          right => {
            const components = right.root[0].components as Array<{
              id: string;
              config: Record<string, number>;
            }>;
            components[0].config.value = 2;
            components.push({ id: 'last', config: { y: 2 } });
          },
          reverse
        );
        expect(document.root[0].components).toEqual([
          { id: 'first', config: { x: 1 } },
          { id: 'old', config: { value: 2 } },
          { id: 'last', config: { y: 2 } },
        ]);
      });

      it('does not resurrect a removed component after a concurrent config edit or prepend', () => {
        const initial = doc(
          node('a', { components: [{ id: 'removed', config: { value: 1 } }, { id: 'kept' }] })
        );
        const { document } = merge(
          initial,
          left => {
            (left.root[0].components as unknown[]).shift();
          },
          right => {
            const components = right.root[0].components as Array<{
              id: string;
              config?: Record<string, number>;
            }>;
            components[0].config!.value = 2;
            components.unshift({ id: 'new' });
          },
          reverse
        );
        expect(document.root[0].components).toEqual([{ id: 'new' }, { id: 'kept' }]);
      });

      it('masks concurrent component additions if their collection is removed', () => {
        const initial = doc(node('a', { components: [{ id: 'old' }] }));
        const { document } = merge(
          initial,
          left => {
            delete left.root[0].components;
          },
          right => {
            (right.root[0].components as unknown[]).push({ id: 'new', config: { value: 1 } });
          },
          reverse
        );
        expect(document.root[0]).toEqual(node('a'));
      });

      it('breaks cycles at the smallest ID without dropping or duplicating nodes', () => {
        const { document } = merge(
          doc(node('a'), node('b')),
          left => {
            const moved = left.root.shift()!;
            left.root[0].children = [moved];
          },
          right => {
            const moved = right.root.pop()!;
            right.root[0].children = [moved];
          },
          reverse
        );
        expect(document.root.map(node => node.id)).toEqual(['a']);
        expect(document.root[0].children?.map(node => node.id)).toEqual(['b']);
        expect(document.root[0].children![0].children).toEqual([]);
      });
    }
  );

  it('keeps children of absent parents hidden and resolves self-cycles deterministically', () => {
    const fields = encode(doc(node('hidden'), node('self')));
    fields.set(field('parent', 'hidden'), 'deleted-parent');
    fields.set(field('parent', 'self'), 'self');
    expect(decode(fields)).toEqual(doc(node('self')));
  });
});
