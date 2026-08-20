import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Color, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { SceneSaver } from './SceneSaver';
import { AmbientLightNode } from '../nodes/3D/AmbientLightNode';
import { DirectionalLightNode } from '../nodes/3D/DirectionalLightNode';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { HemisphereLightNode } from '../nodes/3D/HemisphereLightNode';
import { PointLightNode } from '../nodes/3D/PointLightNode';
import { SpotLightNode } from '../nodes/3D/SpotLightNode';
import type { NodeBase } from '../nodes/NodeBase';
import type { PropertyDefinition } from '../fw/property-schema';

/**
 * Authored colours are sRGB hex strings. With `THREE.ColorManagement.enabled`
 * (three's default since r152, and never disabled here) `Color.set(hex)` already
 * converts into the linear working space and `getHexString()` already converts
 * back — so manual `convertSRGBToLinear` / `convertLinearToSRGB` calls apply the
 * transfer function twice and every authored 3D colour renders too dark.
 *
 * A deliberately non-fixed-point colour: white and black survive any number of
 * conversions, which is why the original bug hid behind `#ffffff` defaults.
 */
const AUTHORED = '#a8d8f0';

/** `AUTHORED` after exactly ONE sRGB -> linear transfer (the correct value). */
const AUTHORED_LINEAR = [0.391572, 0.686685, 0.871367] as const;

/** ...and after two, which is what the double-conversion bug produced. */
const AUTHORED_DOUBLE_LINEAR = [0.127038, 0.429261, 0.731937] as const;

const RUNTIME_SRC = path.resolve(__dirname, '..');

const listRuntimeSources = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listRuntimeSources(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(entryPath);
    }
  }
  return found;
};

const propertyDef = (
  schema: { properties: PropertyDefinition[] },
  name: string
): PropertyDefinition => {
  const def = schema.properties.find(p => p.name === name);
  if (!def) throw new Error(`no such property: ${name}`);
  return def;
};

const serialize = (node: NodeBase): string =>
  new SceneSaver().serializeScene({
    version: '1.0.0',
    metadata: {},
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
  });

const expectLinear = (color: Color): void => {
  expect(color.r).toBeCloseTo(AUTHORED_LINEAR[0], 4);
  expect(color.g).toBeCloseTo(AUTHORED_LINEAR[1], 4);
  expect(color.b).toBeCloseTo(AUTHORED_LINEAR[2], 4);
};

describe('authored colour convention', () => {
  it('pins the three.js side: set/getHexString convert exactly once', () => {
    const color = new Color(AUTHORED);

    expectLinear(color);
    // Guards against someone disabling ColorManagement, which would make every
    // `Color.set(hex)` in the runtime a no-op transfer instead.
    expect(color.r).not.toBeCloseTo(AUTHORED_DOUBLE_LINEAR[0], 3);
    expect('#' + color.getHexString()).toBe(AUTHORED);
  });

  it('lands a GeometryMesh material colour in linear space exactly once', () => {
    const mesh = new GeometryMesh({
      id: 'cube',
      name: 'Cube',
      geometry: 'box',
      material: { color: AUTHORED },
    });

    const material = (
      mesh.children.find(child => (child as unknown as Mesh).isMesh) as unknown as Mesh
    ).material as unknown as { color: Color };
    expectLinear(material.color);

    // Round-trips through both read paths the editor and the saver use.
    const def = propertyDef(GeometryMesh.getPropertySchema(), 'color');
    expect(def.getValue(mesh)).toBe(AUTHORED);
    expect((mesh.serializeConfig().material as Record<string, unknown>).color).toBe(AUTHORED);
  });

  it('round-trips a GeometryMesh inspector colour edit without drift', () => {
    const mesh = new GeometryMesh({ id: 'cube', name: 'Cube', geometry: 'box' });
    const def = propertyDef(GeometryMesh.getPropertySchema(), 'color');

    def.setValue(mesh, AUTHORED);

    expect(def.getValue(mesh)).toBe(AUTHORED);
    expect(serialize(mesh)).toContain(AUTHORED);
  });

  // Lights were the asymmetric case: the write side converted twice but the read
  // side (`getHexString`) un-converted once, so every save wrote a darker hex back
  // into the scene file and colours drifted one transfer step per save/load cycle.
  const lightCases: {
    label: string;
    make: () => NodeBase;
    property: string;
    schema: () => { properties: PropertyDefinition[] };
    live: (node: NodeBase) => Color;
  }[] = [
    {
      label: 'AmbientLight',
      make: () => new AmbientLightNode({ id: 'l', name: 'L', color: AUTHORED }),
      property: 'color',
      schema: () => AmbientLightNode.getPropertySchema(),
      live: n => (n as AmbientLightNode).light.color,
    },
    {
      label: 'DirectionalLight',
      make: () => new DirectionalLightNode({ id: 'l', name: 'L', color: AUTHORED }),
      property: 'color',
      schema: () => DirectionalLightNode.getPropertySchema(),
      live: n => (n as DirectionalLightNode).light.color,
    },
    {
      label: 'PointLight',
      make: () => new PointLightNode({ id: 'l', name: 'L', color: AUTHORED }),
      property: 'color',
      schema: () => PointLightNode.getPropertySchema(),
      live: n => (n as PointLightNode).light.color,
    },
    {
      label: 'SpotLight',
      make: () => new SpotLightNode({ id: 'l', name: 'L', color: AUTHORED }),
      property: 'color',
      schema: () => SpotLightNode.getPropertySchema(),
      live: n => (n as SpotLightNode).light.color,
    },
    {
      label: 'HemisphereLight skyColor',
      make: () => new HemisphereLightNode({ id: 'l', name: 'L', skyColor: AUTHORED }),
      property: 'skyColor',
      schema: () => HemisphereLightNode.getPropertySchema(),
      live: n => (n as HemisphereLightNode).light.color,
    },
    {
      label: 'HemisphereLight groundColor',
      make: () => new HemisphereLightNode({ id: 'l', name: 'L', groundColor: AUTHORED }),
      property: 'groundColor',
      schema: () => HemisphereLightNode.getPropertySchema(),
      live: n => (n as HemisphereLightNode).light.groundColor,
    },
  ];

  for (const testCase of lightCases) {
    it(`converts ${testCase.label} exactly once and survives a save cycle`, () => {
      const node = testCase.make();
      const def = propertyDef(testCase.schema(), testCase.property);

      expectLinear(testCase.live(node));
      expect(def.getValue(node)).toBe(AUTHORED);
      // The save-drift regression: the serialized hex must equal the authored hex.
      expect(serialize(node)).toContain(AUTHORED);

      // And an inspector edit must land in the same space as the constructor.
      def.setValue(node, AUTHORED);
      expectLinear(testCase.live(node));
    });
  }

  it('keeps manual sRGB conversions out of the runtime sources', () => {
    const offenders: string[] = [];
    for (const file of listRuntimeSources(RUNTIME_SRC)) {
      if (/convert(SRGBToLinear|LinearToSRGB)/.test(readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(RUNTIME_SRC, file).split(path.sep).join('/'));
      }
    }

    expect(
      offenders,
      'Authored colours are sRGB hex: `Color.set(hex)` already converts to the linear ' +
        'working space and `getHexString()` already converts back, so a manual conversion ' +
        'applies the transfer function twice and renders everything too dark. ' +
        'See the colour entry in CLAUDE.md.'
    ).toEqual([]);
  });
});
