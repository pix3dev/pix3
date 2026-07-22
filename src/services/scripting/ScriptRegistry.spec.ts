/**
 * Tests for ScriptRegistry (unified component API)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScriptRegistry } from '@pix3/runtime';
import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@/fw';

class TestComponent extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = { value: 0 };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TestComponent',
      properties: [
        {
          name: 'value',
          type: 'number',
          getValue: (c: unknown) => (c as TestComponent).config.value,
          setValue: (c: unknown, v: unknown) => {
            (c as TestComponent).config.value = Number(v);
          },
        },
      ],
    };
  }
}

describe('ScriptRegistry (component API)', () => {
  let registry: ScriptRegistry;

  beforeEach(() => {
    registry = new ScriptRegistry();
  });

  it('registers and retrieves a component type', () => {
    registry.registerComponent({
      id: 'test_component',
      displayName: 'Test Component',
      description: 'A test component',
      category: 'Test',
      componentClass: TestComponent,
      keywords: ['test'],
    });

    const type = registry.getComponentType('test_component');
    expect(type).toBeDefined();
    expect(type?.displayName).toBe('Test Component');
  });

  it('creates component instances', () => {
    registry.registerComponent({
      id: 'test_component',
      displayName: 'Test Component',
      description: 'A test component',
      category: 'Test',
      componentClass: TestComponent,
      keywords: ['test'],
    });

    const instance = registry.createComponent('test_component', 'instance-1');
    expect(instance).toBeDefined();
    expect(instance?.id).toBe('instance-1');
    expect(instance?.type).toBe('test_component');
  });

  it('returns component property schema', () => {
    registry.registerComponent({
      id: 'test_component',
      displayName: 'Test Component',
      description: 'A test component',
      category: 'Test',
      componentClass: TestComponent,
      keywords: ['test'],
    });

    const schema = registry.getComponentPropertySchema('test_component');
    expect(schema).toBeDefined();
    expect(schema?.nodeType).toBe('TestComponent');
  });

  it('searches components by keyword', () => {
    registry.registerComponent({
      id: 'alpha',
      displayName: 'Alpha',
      description: 'First',
      category: 'Group',
      componentClass: TestComponent,
      keywords: ['first'],
    });
    registry.registerComponent({
      id: 'beta',
      displayName: 'Beta',
      description: 'Second',
      category: 'Group',
      componentClass: TestComponent,
      keywords: ['second'],
    });

    const results = registry.searchComponents('first');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('alpha');
  });

  it('returns all registered component types', () => {
    registry.registerComponent({
      id: 'a',
      displayName: 'A',
      description: 'A',
      category: 'T',
      componentClass: TestComponent,
      keywords: [],
    });
    registry.registerComponent({
      id: 'b',
      displayName: 'B',
      description: 'B',
      category: 'T',
      componentClass: TestComponent,
      keywords: [],
    });

    const types = registry.getAllComponentTypes();
    expect(types).toHaveLength(2);
  });

  it('dispose clears all types', () => {
    registry.registerComponent({
      id: 'test',
      displayName: 'Test',
      description: 'Test',
      category: 'Test',
      componentClass: TestComponent,
      keywords: [],
    });

    registry.dispose();
    expect(registry.getAllComponentTypes()).toHaveLength(0);
  });
});
