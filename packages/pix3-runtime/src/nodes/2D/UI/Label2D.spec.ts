import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasTexture, Mesh } from 'three';

import { Label2D, type Label2DProps } from './Label2D';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

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
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        fillStyle: '',
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
    for (const expected of ['width', 'height', 'labelVAlign', 'typewriterSpeed']) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    // label/labelColor/... are UIControl2D accessors that already re-render on write.
    expect(names.has('label')).toBe(false);
    expect(names.has('labelColor')).toBe(false);
  });
});
