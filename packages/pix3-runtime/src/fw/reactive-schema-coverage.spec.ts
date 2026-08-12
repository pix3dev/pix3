/**
 * Drift guard for the "Inspector refreshes, script assignment doesn't" bug class.
 *
 * A node property that lives as a plain public field while its schema `setValue` does real refresh
 * work is broken for game scripts: `node.prop = x` changes the field and redraws nothing, and the
 * getter still returns x so even state-based verification calls it a success. The runtime shipped 31
 * such properties across 16 node types before this was measured.
 *
 * The fix is per class — `installReactiveSchemaProperties(this, X.getPropertySchema)` as the last
 * statement of the constructor. This spec is what stops the next node from regressing: it constructs
 * every node type the SceneLoader can build and fails if any schema property is still a bare
 * writable data field.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { reactiveSchemaPropertyNames } from './reactive-schema-properties';
import type { PropertySchema } from './property-schema';

import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { TiledSprite2D } from '../nodes/2D/TiledSprite2D';
import { Bar2D } from '../nodes/2D/UI/Bar2D';
import { Button2D } from '../nodes/2D/UI/Button2D';
import { Checkbox2D } from '../nodes/2D/UI/Checkbox2D';
import { InventorySlot2D } from '../nodes/2D/UI/InventorySlot2D';
import { Joystick2D } from '../nodes/2D/UI/Joystick2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import { ScrollContainer2D } from '../nodes/2D/UI/ScrollContainer2D';
import { Slider2D } from '../nodes/2D/UI/Slider2D';
import { NodeBase } from '../nodes/NodeBase';

/**
 * Node types this spec can construct without assets, a GL context or a host-injected module, mapped
 * to a factory. Types deliberately absent are listed in {@link UNCOVERED} with the reason, and the
 * SceneLoader cross-check below fails if a new `case` appears in neither map.
 */
const FACTORIES: Record<string, () => NodeBase> = {
  Sprite2D: () => new Sprite2D({ id: 'n', name: 'n' }),
  TiledSprite2D: () => new TiledSprite2D({ id: 'n', name: 'n' }),
  AnimatedSprite2D: () => new AnimatedSprite2D({ id: 'n', name: 'n' }),
  ColorRect2D: () => new ColorRect2D({ id: 'n', name: 'n' }),
  Bar2D: () => new Bar2D({ id: 'n', name: 'n' }),
  Button2D: () => new Button2D({ id: 'n', name: 'n' }),
  Checkbox2D: () => new Checkbox2D({ id: 'n', name: 'n' }),
  Slider2D: () => new Slider2D({ id: 'n', name: 'n' }),
  Label2D: () => new Label2D({ id: 'n', name: 'n' }),
  InventorySlot2D: () => new InventorySlot2D({ id: 'n', name: 'n' }),
  Joystick2D: () => new Joystick2D({ id: 'n', name: 'n' }),
  ScrollContainer2D: () => new ScrollContainer2D({ id: 'n', name: 'n' }),
};

/** SceneLoader cases intentionally not exercised here, with the reason each is out of reach. */
const UNCOVERED: Record<string, string> = {
  Group: 'plain NodeBase container, no visual schema properties',
  Layout2D: 'legacy type, SceneLoader throws on it',
  // These are instantiable AND base classes for everything else. Installing in them would run
  // before every subclass's fields exist, and their own schema properties (name/type/groups/visible,
  // width/height) either use plain-assignment setters or are already accessors — not the bug class.
  Node2D: 'concrete but also the base of every 2D node; own properties are not the bug class',
  Node3D: 'concrete but also the base of every 3D node; own properties are not the bug class',
  Group2D: 'base of the container family; width/height are already accessors',
  CanvasLayer2D: 'thin Group2D subclass, adds no field-backed visual properties',
  Camera2D: 'knobs are read by the per-frame camera solve, so assignment already takes effect',
  AudioPlayer: 'covered by its own spec',
  Camera3D: 'schema properties are already accessors',
  VirtualCamera3D: 'schema properties are already accessors (private backing + per-frame solve)',
  PostProcess: 'schema properties are already accessors',
  GeometryMesh: 'schema properties are already accessors',
  MeshInstance: 'covered by its own spec',
  InstancedMesh3D: 'schema targets node.mesh, not node fields',
  Sprite3D: 'covered by its own spec',
  AnimatedSprite3D: 'covered by its own spec',
  Particles3D: 'allocates instanced buffers; covered by its own spec',
  SpineSkeleton2D: 'Spine is an optional host-injected module, absent under test',
  AmbientLightNode: 'colour lives on the three.js light, not a node field',
  DirectionalLightNode: 'colour lives on the three.js light, not a node field',
  PointLightNode: 'colour lives on the three.js light, not a node field',
  SpotLightNode: 'colour lives on the three.js light, not a node field',
  HemisphereLightNode: 'colour lives on the three.js light, not a node field',
};

/** True when `name` resolves to a getter somewhere on the prototype chain — the class's own fix. */
const hasAccessor = (node: object, name: string): boolean => {
  let proto: object | null = Object.getPrototypeOf(node);
  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor && 'get' in descriptor) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
};

const schemaOf = (node: NodeBase): PropertySchema | null => {
  const ctor = node.constructor as { getPropertySchema?: () => PropertySchema };
  return typeof ctor.getPropertySchema === 'function' ? ctor.getPropertySchema() : null;
};

describe('reactive schema coverage', () => {
  it('lists every node type the SceneLoader can build', () => {
    // Closes the drift loop: adding a `case` to SceneLoader without adding it here fails this test.
    const loaderSource = readFileSync(
      `${process.cwd()}/packages/pix3-runtime/src/core/SceneLoader.ts`,
      'utf8'
    );
    const cases = [...loaderSource.matchAll(/case '([A-Za-z0-9_]+)':/g)].map(m => m[1]);
    const known = new Set([...Object.keys(FACTORIES), ...Object.keys(UNCOVERED)]);
    const unaccounted = [...new Set(cases)].filter(type => !known.has(type));

    expect(
      unaccounted,
      `New node type(s) in SceneLoader. Add each to FACTORIES (preferred) or to UNCOVERED with the reason: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });

  for (const [type, create] of Object.entries(FACTORIES)) {
    it(`${type}: routes field writes through its property schema`, () => {
      const node = create();
      const schema = schemaOf(node);
      expect(schema, `${type} has no getPropertySchema()`).not.toBeNull();

      // Deciding WHICH properties need the treatment is the installer's job — it takes every schema
      // property the instance stores as a plain field. This spec only checks that the class asked,
      // because forgetting to ask is the regression: a new node would silently ship the bug.
      const reactive = reactiveSchemaPropertyNames(node);
      const fieldBacked = schema!.properties.filter(definition => {
        const descriptor = Object.getOwnPropertyDescriptor(node, definition.name);
        return descriptor !== undefined && ('get' in descriptor || descriptor.writable === true);
      });
      const ownAccessors = schema!.properties.filter(
        definition =>
          !Object.getOwnPropertyDescriptor(node, definition.name) &&
          hasAccessor(node, definition.name)
      ).length;

      expect(
        reactive.size,
        `${type} never calls installReactiveSchemaProperties, so a script assigning any of its ` +
          `${fieldBacked.length} field-backed schema properties would change the value and redraw ` +
          `nothing. Add installReactiveSchemaProperties(this, ${type}.getPropertySchema) as the ` +
          `LAST statement of its constructor. (${ownAccessors} of its properties are already ` +
          `accessors and need nothing.)`
      ).toBeGreaterThan(0);
    });
  }
});
