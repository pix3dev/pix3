import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

import { Checkbox2D, type Checkbox2DProps } from './Checkbox2D';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

interface CheckboxInternals {
  boxMaterial: MeshBasicMaterial;
  checkMesh: Mesh | null;
  checkMaterial: MeshBasicMaterial | null;
  geometry: PlaneGeometry;
  checkGeometry: PlaneGeometry | null;
}

const internalsOf = (checkbox: Checkbox2D): CheckboxInternals =>
  checkbox as unknown as CheckboxInternals;

function createCheckbox(overrides: Partial<Checkbox2DProps> = {}): Checkbox2D {
  // No label: happy-dom has no canvas 2D context, and these tests exercise the box visuals.
  return new Checkbox2D({ id: 'cb', name: 'Checkbox', ...overrides });
}

function hexOf(style: string): number {
  return new Color(style).getHex();
}

describe('Checkbox2D script assignments (reactive schema properties)', () => {
  it('draws the checkmark and recolours the box when a script assigns checked', () => {
    // Only toggle() worked before; `checkbox.checked = true` changed the field and drew nothing.
    const checkbox = createCheckbox({ checkedColor: '#4a9eff', uncheckedColor: '#ffffff' });
    const internals = internalsOf(checkbox);
    expect(internals.checkMesh).toBeNull();

    checkbox.checked = true;

    expect(internals.checkMesh).not.toBeNull();
    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#4a9eff'));
  });

  it('removes the checkmark when a script unchecks', () => {
    const checkbox = createCheckbox({ checked: true });
    const internals = internalsOf(checkbox);
    expect(internals.checkMesh).not.toBeNull();

    checkbox.checked = false;

    expect(internals.checkMesh).toBeNull();
    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#ffffff'));
  });

  it('rebuilds the box and checkmark geometry when size changes', () => {
    const checkbox = createCheckbox({ checked: true, size: 30 });
    const internals = internalsOf(checkbox);

    checkbox.size = 50;

    expect(internals.geometry.parameters.width).toBe(50);
    // Checkmark tracks the box: 0.6 * size wide.
    expect(internals.checkGeometry?.parameters.width).toBe(30);
  });

  it('pushes colour assignments into the active materials', () => {
    const checkbox = createCheckbox({ checked: true });
    const internals = internalsOf(checkbox);

    checkbox.checkedColor = '#112233';
    checkbox.checkmarkColor = '#445566';

    expect(internals.boxMaterial.color.getHex()).toBe(hexOf('#112233'));
    expect(internals.checkMaterial?.color.getHex()).toBe(hexOf('#445566'));
  });

  it('installs reactive accessors for every own schema field', () => {
    const names = reactiveSchemaPropertyNames(createCheckbox());
    for (const expected of [
      'size',
      'checked',
      'uncheckedColor',
      'checkedColor',
      'checkmarkColor',
      'checkmarkAction',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    expect(names.has('label')).toBe(false);
  });
});
