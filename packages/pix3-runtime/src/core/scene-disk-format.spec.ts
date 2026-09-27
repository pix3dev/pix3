// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import * as runtime from '../index';
import type { PropertyDefinition, PropertySchema } from '../fw/property-schema';
import { getNodePropertySchema } from '../fw/property-schema-utils';
import type { NodeBase } from '../nodes/NodeBase';
import {
  collectLoaderWarnings,
  DiskResourceManager,
  installCanvasOnlyDocument,
  NodeAssetLoader,
} from '../node';
import { KNOWN_SCENE_NODE_TYPES } from './node-type-registry';
import {
  getSceneNodeDiskFormat,
  resolveSceneDiskKey,
  SCENE_DISK_FORMAT_TYPES,
  type SceneDiskKeyRule,
  type SceneNodeDiskFormat,
} from './scene-disk-format';
import { SceneLoader, type SceneNodeDefinition } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';

/**
 * Pins `scene-disk-format.ts` — the table `pix3 validate` uses for "unknown property" — against the
 * two things that actually define the file format: what `SceneLoader` reads and what `SceneSaver`
 * writes. Measured, not transcribed: every schema property of every node type is written to a scene
 * definition with a non-default value and read back through the real loader.
 */

let uninstallDocument: () => void = () => {};
beforeAll(() => {
  uninstallDocument = installCanvasOnlyDocument();
});
afterAll(() => uninstallDocument());

const disk = new DiskResourceManager('/nonexistent-pix3-project');
const loader = new SceneLoader(new NodeAssetLoader(disk), new ScriptRegistry(), disk);

/** `InstancedMesh3D` refuses to build without a positive `maxInstances`. */
const REQUIRED_PROPS: Readonly<Record<string, Record<string, unknown>>> = {
  InstancedMesh3D: { maxInstances: 4 },
};

const build = async (type: string, properties: Record<string, unknown>): Promise<NodeBase> => {
  const { result } = await collectLoaderWarnings(() =>
    loader.createNodeFromDefinition({
      id: 'probe',
      type,
      properties: { ...REQUIRED_PROPS[type], ...properties },
    })
  );
  return result;
};

interface Probe {
  /** The value as a scene file spells it. */
  readonly disk: unknown;
  /** The value as `setValue` takes it and `getValue` returns it. */
  readonly live: unknown;
}

const optionValues = (property: PropertyDefinition): unknown[] => {
  const options = property.ui?.options;
  if (Array.isArray(options)) return options;
  if (options && typeof options === 'object') return Object.values(options);
  return [];
};

/** A value of the property's type that differs from `current`, or null when none is derivable. */
const probeValue = (property: PropertyDefinition, current: unknown): Probe | null => {
  switch (property.type) {
    case 'number': {
      const min = property.ui?.min ?? Number.NEGATIVE_INFINITY;
      const max = property.ui?.max ?? Number.POSITIVE_INFINITY;
      const base = typeof current === 'number' && Number.isFinite(current) ? current : 0;
      const candidates = [base - 1, base + 1, base * 0.5, base * 2, 0.5, 3];
      const value = candidates.find(v => v !== base && v >= min && v <= max);
      return value === undefined ? null : { disk: value, live: value };
    }
    case 'boolean':
      return { disk: current !== true, live: current !== true };
    case 'color': {
      const value = String(current).toLowerCase() === '#123456' ? '#654321' : '#123456';
      return { disk: value, live: value };
    }
    case 'string':
      return { disk: 'probe-value', live: 'probe-value' };
    case 'enum':
    case 'select': {
      const other = optionValues(property).find(option => option !== current);
      return other === undefined ? null : { disk: other, live: other };
    }
    case 'vector2':
      return { disk: [3.5, 4.5], live: { x: 3.5, y: 4.5 } };
    case 'vector3':
      return { disk: [3.5, 4.5, 5.5], live: { x: 3.5, y: 4.5, z: 5.5 } };
    case 'euler':
      return { disk: [10, 20, 30], live: { x: 10, y: 20, z: 30 } };
    default:
      return null;
  }
};

const matches = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) < 1e-3;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    return Object.entries(expected).every(([key, value]) =>
      matches((actual as Record<string, unknown>)[key], value)
    );
  }
  return actual === expected;
};

/** `{ a: { b: v } }` for the disk path `a.b`. */
const atPath = (path: string, value: unknown): Record<string, unknown> => {
  const [head, ...rest] = path.split('.');
  return { [head]: rest.length === 0 ? value : atPath(rest.join('.'), value) };
};

/** Nested structural keys need their gate on to be read (`layout.enabled`, `flow.enabled`). */
const withGate = (path: string, value: unknown): Record<string, unknown> => {
  const block = atPath(path, value);
  const [head] = path.split('.');
  if (head === 'layout' || head === 'flow') {
    const inner = block[head] as Record<string, unknown>;
    if (!('enabled' in inner)) inner.enabled = true;
  }
  return block;
};

const schemaOf = (format: SceneNodeDiskFormat): PropertySchema => {
  const exported = (runtime as unknown as Record<string, unknown>)[format.classExport] as
    | { getPropertySchema?: () => PropertySchema }
    | undefined;
  if (typeof exported?.getPropertySchema !== 'function') {
    throw new Error(`${format.type}: export ${format.classExport} has no getPropertySchema()`);
  }
  return exported.getPropertySchema();
};

describe('scene disk format descriptor', () => {
  it('covers every loadable scene type, and each maps to an exported schema class', async () => {
    expect([...SCENE_DISK_FORMAT_TYPES].sort()).toEqual(
      KNOWN_SCENE_NODE_TYPES.filter(type => type !== 'Layout2D').sort()
    );
    for (const type of SCENE_DISK_FORMAT_TYPES) {
      const format = getSceneNodeDiskFormat(type);
      expect(format, type).not.toBeNull();
      if (!format) continue;
      const exported = (runtime as unknown as Record<string, unknown>)[format.classExport];
      expect(typeof exported, `${type} → ${format.classExport}`).toBe('function');
      const node = await build(type, {});
      expect(node, type).toBeInstanceOf(exported as new (...args: never[]) => unknown);
      // The static schema a DOM-free validator reads is the one the loader's node reports.
      expect(
        getNodePropertySchema(node).properties.map(p => p.name),
        `${type}: instance schema contributions would be invisible to validate`
      ).toEqual(schemaOf(format).properties.map(p => p.name));
    }
  });

  it('matches what the loader honours, flat and at the relocated path', async () => {
    const mismatches: string[] = [];
    for (const type of SCENE_DISK_FORMAT_TYPES) {
      const format = getSceneNodeDiskFormat(type)!;
      const schema = schemaOf(format).properties;
      const fresh = await build(type, {});
      for (const property of schema) {
        const probe = probeValue(property, property.getValue(fresh));
        if (!probe) continue;
        const resolution = resolveSceneDiskKey(format, schema, property.name);
        const flat = await build(type, { [property.name]: probe.disk });
        const honouredFlat = matches(property.getValue(flat), probe.live);
        const expectFlat = resolution.kind === 'schema';
        if (honouredFlat !== expectFlat) {
          mismatches.push(
            `${type}.${property.name}: loader ${honouredFlat ? 'reads' : 'ignores'} it flat, table says ${resolution.kind}`
          );
        }
        if (resolution.kind === 'relocated') {
          const nested = await build(type, withGate(resolution.diskPath, probe.disk));
          if (!matches(property.getValue(nested), probe.live)) {
            mismatches.push(`${type}.${property.name}: loader ignores ${resolution.diskPath}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('lists every key SceneSaver writes, for every node type with non-default values', async () => {
    const saver = new SceneSaver();
    const problems: string[] = [];
    const checkNested = (
      type: string,
      path: string,
      value: unknown,
      rule: SceneDiskKeyRule
    ): void => {
      if (!rule.nested || !value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const key of Object.keys(value)) {
        if (!(key in rule.nested)) problems.push(`${type}: saver writes ${path}.${key}`);
      }
    };
    for (const type of SCENE_DISK_FORMAT_TYPES) {
      const format = getSceneNodeDiskFormat(type)!;
      const node = await build(type, {});
      const schema = getNodePropertySchema(node).properties;
      for (const property of schema) {
        if (property.ui?.readOnly === true) continue;
        const probe =
          property.ui?.editor === 'texture-resource' || property.ui?.resourceType === 'texture'
            ? { disk: null, live: { type: 'texture', url: 'res://probe.png' } }
            : probeValue(property, property.getValue(node));
        if (!probe) continue;
        try {
          property.setValue(node, probe.live);
        } catch {
          // A setter that rejects the probe value writes nothing — nothing to check.
        }
      }
      const yaml = saver.serializeScene({
        version: '1.0.0',
        metadata: {},
        rootNodes: [node],
        nodeMap: new Map([[node.nodeId, node]]),
      });
      const document = parseYaml(yaml) as { root: SceneNodeDefinition[] };
      const properties = document.root[0]?.properties ?? {};
      for (const [key, value] of Object.entries(properties)) {
        const resolution = resolveSceneDiskKey(format, schema, key);
        if (resolution.kind === 'extra') {
          checkNested(type, key, value, resolution.rule);
        } else if (resolution.kind !== 'schema' && resolution.kind !== 'write-only') {
          problems.push(`${type}: saver writes "${key}", table says ${resolution.kind}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
