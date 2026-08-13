import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasTexture, Mesh, Vector2 } from 'three';

import { Label2D, type Label2DProps } from './Label2D';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';
import type { PropertyDefinition } from '../../../fw/property-schema';

interface LabelInternals {
  labelMesh: Mesh | null;
  labelTexture: CanvasTexture | null;
}

const internalsOf = (label: Label2D): LabelInternals => label as unknown as LabelInternals;

function createLabel(overrides: Partial<Label2DProps> = {}): Label2D {
  return new Label2D({ id: 'label', name: 'Label', label: 'Hello world', ...overrides });
}

describe('Label2D script assignments (reactive schema properties)', () => {
  // happy-dom has no canvas 2D context, so text layout/painting throws unless stubbed.
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
      if (kind !== '2d') {
        return null;
      }
      return {
        setTransform: () => {},
        scale: () => {},
        fillRect: () => {},
        fillText: () => {},
        strokeText: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        shadowColor: '',
        shadowBlur: 0,
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('re-wraps the text into the new box when a script assigns width', () => {
    const label = createLabel({ width: 0 });
    const internals = internalsOf(label);
    // Auto-sized: the mesh spans the measured text, not 50.
    expect(internals.labelMesh?.scale.x).not.toBe(50);

    label.width = 50;

    expect(internals.labelMesh?.scale.x).toBe(50);
  });

  it('resizes the box when a script assigns height', () => {
    const label = createLabel({ height: 0 });

    label.height = 80;

    expect(internalsOf(label).labelMesh?.scale.y).toBe(80);
  });

  it('repaints the canvas when a script assigns labelVAlign', () => {
    const label = createLabel({ height: 100 });
    const internals = internalsOf(label);
    const texture = internals.labelTexture;
    expect(texture).not.toBeNull();
    const versionBefore = texture!.version;

    label.labelVAlign = 'top';

    // Same-sized canvas → same texture repainted; the version bump is the GPU re-upload.
    expect(internals.labelTexture!.version).toBeGreaterThan(versionBefore);
  });

  it('starts the typewriter reveal when a script assigns typewriterSpeed', () => {
    const label = createLabel();
    expect(label.isTyping).toBe(false);

    label.typewriterSpeed = 30;

    expect(label.isTyping).toBe(true);
  });

  it('installs reactive accessors for the Label2D box fields and leaves label accessors alone', () => {
    const names = reactiveSchemaPropertyNames(createLabel());
    for (const expected of [
      'width',
      'height',
      'labelVAlign',
      'typewriterSpeed',
      'glowColor',
      'glowStrength',
      'outlineColor',
      'outlineWidth',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    // label/labelColor/... are UIControl2D accessors that already re-render on write.
    expect(names.has('label')).toBe(false);
    expect(names.has('labelColor')).toBe(false);
  });

  it('exposes glow/outline in the schema, off by default, and clamps the strength', () => {
    const schema = Label2D.getPropertySchema();
    const byName = new Map(schema.properties.map(prop => [prop.name, prop]));
    const definition = (name: string): PropertyDefinition => {
      const found = byName.get(name);
      expect(found, `${name} should be in the schema`).toBeDefined();
      return found as PropertyDefinition;
    };
    for (const name of ['glowColor', 'glowStrength', 'outlineColor', 'outlineWidth']) {
      expect(definition(name).ui?.group).toBe('Label');
    }
    expect(definition('glowColor').type).toBe('color');
    expect(definition('outlineColor').type).toBe('color');

    const label = createLabel();
    // Defaults are inert, so an existing scene renders exactly as before.
    expect(label.glowStrength).toBe(0);
    expect(label.outlineWidth).toBe(0);

    definition('glowStrength').setValue(label, 99);
    expect(label.glowStrength).toBe(4);
    definition('outlineWidth').setValue(label, -3);
    expect(label.outlineWidth).toBe(0);
  });

  it('grows the label box for glow bleed and keeps the authored hit area', () => {
    const plain = createLabel({ width: 200, height: 60, labelFontSize: 40 });
    const glowing = createLabel({
      width: 200,
      height: 60,
      labelFontSize: 40,
      glowStrength: 3,
      outlineWidth: 2,
    });

    const boxOf = (label: Label2D): { boxWidth: number; boxHeight: number; pad: number } =>
      (label as unknown as { renderState: { boxWidth: number; boxHeight: number; pad: number } })
        .renderState;

    expect(boxOf(plain).pad).toBe(0);
    expect(boxOf(glowing).pad).toBeGreaterThan(0);
    expect(boxOf(glowing).boxWidth).toBe(200 + boxOf(glowing).pad * 2);
    expect(boxOf(glowing).boxHeight).toBe(60 + boxOf(glowing).pad * 2);
    // The mesh spans the padded canvas, but the tap target stays the authored box.
    expect(internalsOf(glowing).labelMesh?.scale.x).toBe(boxOf(glowing).boxWidth);
    const insideAuthored = new Vector2(99, 0);
    const insidePadOnly = new Vector2(100 + boxOf(glowing).pad, 0);
    expect(glowing.isPointInBounds(insideAuthored)).toBe(true);
    expect(glowing.isPointInBounds(insidePadOnly)).toBe(false);
  });
});
