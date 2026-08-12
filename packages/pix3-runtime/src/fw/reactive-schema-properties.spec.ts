import { describe, expect, it, vi } from 'vitest';

import type { PropertySchema } from './property-schema';
import {
  assignWithoutSchemaRefresh,
  installReactiveSchemaProperties,
  makeSchemaPropertyReactive,
  reactiveSchemaPropertyNames,
} from './reactive-schema-properties';

/** A node in the shape that caused the bug: a plain field plus a schema setter that also redraws. */
class FakeBar {
  value = 0;
  minValue = 0;
  maxValue = 100;
  redraws = 0;

  /** Mirrors Bar2D: clamps, assigns its OWN public field, then refreshes. */
  applyValue(next: number): void {
    this.value = Math.max(this.minValue, Math.min(this.maxValue, next));
    this.redraws += 1;
  }

  static schema(): PropertySchema {
    return {
      nodeType: 'FakeBar',
      properties: [
        {
          name: 'value',
          type: 'number',
          getValue: n => (n as FakeBar).value,
          setValue: (n, v) => {
            (n as FakeBar).applyValue(Number(v));
          },
        },
      ],
    };
  }
}

describe('reactive schema properties', () => {
  it('runs the schema refresh when a script assigns the field directly', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());

    bar.value = 30;

    expect(bar.value).toBe(30);
    expect(bar.redraws).toBe(1);
  });

  it('does not recurse when setValue assigns the same property it owns', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());

    bar.value = 42;

    // One refresh, not a stack overflow: the inner assignment is absorbed by the guard.
    expect(bar.redraws).toBe(1);
    expect(bar.value).toBe(42);
  });

  it('reports the value setValue actually settled on, not the argument', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());

    bar.value = 500; // clamped to maxValue by applyValue

    expect(bar.value).toBe(100);
  });

  it('keeps working across repeated writes', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());

    bar.value = 10;
    bar.value = 20;
    bar.value = 30;

    expect(bar.value).toBe(30);
    expect(bar.redraws).toBe(3);
  });

  it('leaves an existing accessor alone — the class already refreshes itself', () => {
    const refresh = vi.fn();
    class AlreadyReactive {
      private stored = 'a';
      get label(): string {
        return this.stored;
      }
      set label(value: string) {
        this.stored = value;
        refresh();
      }
    }
    const node = new AlreadyReactive();
    const schemaSetValue = vi.fn();
    const added = installReactiveSchemaProperties(node, {
      nodeType: 'AlreadyReactive',
      properties: [
        { name: 'label', type: 'string', getValue: () => node.label, setValue: schemaSetValue },
      ],
    });

    node.label = 'b';

    expect(added).toEqual([]);
    expect(node.label).toBe('b');
    expect(refresh).toHaveBeenCalledTimes(1);
    // The class's own setter must remain the only path; the schema closure is not inserted.
    expect(schemaSetValue).not.toHaveBeenCalled();
  });

  it('skips a schema property the instance does not store as a field', () => {
    const node = {};
    const added = installReactiveSchemaProperties(node, {
      nodeType: 'Sparse',
      properties: [
        { name: 'ghost', type: 'string', getValue: () => undefined, setValue: () => undefined },
      ],
    });
    expect(added).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(node, 'ghost')).toBe(false);
  });

  it('is idempotent, so a subclass constructor can call it again', () => {
    const bar = new FakeBar();
    const first = installReactiveSchemaProperties(bar, FakeBar.schema());
    const second = installReactiveSchemaProperties(bar, FakeBar.schema());

    expect(first).toEqual(['value']);
    expect(second).toEqual([]);
    expect(reactiveSchemaPropertyNames(bar).has('value')).toBe(true);

    bar.value = 5;
    expect(bar.redraws).toBe(1);
  });

  it('releases the guard when setValue throws, so the property stays usable', () => {
    const node = { broken: 1 };
    makeSchemaPropertyReactive(node, {
      name: 'broken',
      type: 'number',
      getValue: n => (n as { broken: number }).broken,
      setValue: () => {
        throw new Error('refresh failed');
      },
    });

    expect(() => {
      node.broken = 2;
    }).toThrow('refresh failed');
    // A second write must still reach setValue rather than being swallowed as re-entrant.
    expect(() => {
      node.broken = 3;
    }).toThrow('refresh failed');
  });

  it('keeps the field value setValue stored when getValue dresses it up for the Inspector', () => {
    // Button2D's texture refs are the real case: the field is `TextureResourceRef | null`, but
    // getValue substitutes `{type:'texture', url:''}` so the Inspector editor always sees an
    // object. Storing getValue's result after a clearing write would leave the field truthy —
    // and SceneSaver, which checks the field's truthiness, would serialize an empty ref.
    interface Ref {
      url: string;
    }
    class WithInspectorFallback {
      ref: Ref | null = { url: 'res://a.png' };
    }
    const node = new WithInspectorFallback();
    installReactiveSchemaProperties(node, {
      nodeType: 'WithInspectorFallback',
      properties: [
        {
          name: 'ref',
          type: 'object',
          getValue: n => (n as WithInspectorFallback).ref ?? { url: '' },
          setValue: (n, v) => {
            const target = n as WithInspectorFallback;
            const url = typeof (v as Ref | null)?.url === 'string' ? (v as Ref).url : '';
            target.ref = url.length > 0 ? { url } : null;
          },
        },
      ],
    });

    node.ref = null;

    expect(node.ref).toBeNull();
  });

  it('preserves the field value that existed at install time', () => {
    const bar = new FakeBar();
    bar.value = 77; // set before install, the way a constructor does
    installReactiveSchemaProperties(bar, FakeBar.schema());

    expect(bar.value).toBe(77);
    expect(bar.redraws).toBe(0);
  });
});

describe('assignWithoutSchemaRefresh', () => {
  it('records the value without running the schema refresh', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());

    assignWithoutSchemaRefresh(bar, 'value', 61);

    expect(bar.value).toBe(61);
    // The point of the escape hatch: the caller already did the work.
    expect(bar.redraws).toBe(0);
  });

  it('leaves the property reactive for ordinary writes afterwards', () => {
    const bar = new FakeBar();
    installReactiveSchemaProperties(bar, FakeBar.schema());
    assignWithoutSchemaRefresh(bar, 'value', 61);

    bar.value = 12;

    expect(bar.value).toBe(12);
    expect(bar.redraws).toBe(1);
  });

  it('is a plain assignment on a property that was never made reactive', () => {
    const node: { plain?: number } = {};
    assignWithoutSchemaRefresh(node, 'plain', 3);
    expect(node.plain).toBe(3);
  });
});

describe('object-valued fields mutated in place', () => {
  it('keeps the live object when setValue mutates it instead of assigning', () => {
    // NodeBase.groups and TiledSprite2D.tileScale are the real cases: setValue mutates the Set /
    // Vector2 in place, and getValue returns a snapshot (an array, a plain {x,y}). Storing the
    // snapshot back would replace the live object, and the next .add()/.set() would throw.
    class WithVectorField {
      scale = {
        x: 1,
        y: 1,
        set(x: number, y: number) {
          this.x = x;
          this.y = y;
        },
      };
    }
    const node = new WithVectorField();
    const liveObject = node.scale;
    installReactiveSchemaProperties(node, {
      nodeType: 'WithVectorField',
      properties: [
        {
          name: 'scale',
          type: 'vector2',
          // A snapshot, exactly like the real Vector2 getters.
          getValue: n => ({ x: (n as WithVectorField).scale.x, y: (n as WithVectorField).scale.y }),
          setValue: (n, v) => {
            const next = v as { x: number; y: number };
            (n as WithVectorField).scale.set(next.x, next.y);
          },
        },
      ],
    });

    node.scale = { x: 3, y: 4, set: liveObject.set };

    expect(node.scale).toBe(liveObject);
    expect(node.scale.x).toBe(3);
    expect(typeof node.scale.set).toBe('function');
  });

  it('still reads back a primitive that setValue coerced elsewhere', () => {
    class WithPrivateStore {
      volume = 1;
      private clamped = 1;
      apply(next: number): void {
        this.clamped = Math.max(0, Math.min(1, next));
      }
      read(): number {
        return this.clamped;
      }
    }
    const node = new WithPrivateStore();
    installReactiveSchemaProperties(node, {
      nodeType: 'WithPrivateStore',
      properties: [
        {
          name: 'volume',
          type: 'number',
          getValue: n => (n as WithPrivateStore).read(),
          setValue: (n, v) => {
            (n as WithPrivateStore).apply(Number(v));
          },
        },
      ],
    });

    node.volume = 5;

    expect(node.volume).toBe(1);
  });
});
