import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';

import { Joystick2D, type Joystick2DProps } from './Joystick2D';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';

interface JoystickInternals {
  baseMaterial: MeshBasicMaterial;
  handleMaterial: MeshBasicMaterial;
}

const internalsOf = (joystick: Joystick2D): JoystickInternals =>
  joystick as unknown as JoystickInternals;

function createJoystick(overrides: Partial<Joystick2DProps> = {}): Joystick2D {
  return new Joystick2D({ id: 'joy', name: 'Joystick', ...overrides });
}

describe('Joystick2D script assignments (reactive schema properties)', () => {
  it('hides the visuals when a script assigns floating = true', () => {
    // A floating joystick stays invisible until a touch summons it; a plain field write used to
    // flip the flag while the joystick stayed fully visible on screen.
    const joystick = createJoystick({ floating: false });
    const internals = internalsOf(joystick);
    expect(internals.baseMaterial.opacity).toBeCloseTo(0.3);
    expect(internals.handleMaterial.opacity).toBeCloseTo(0.8);

    joystick.floating = true;

    expect(internals.baseMaterial.opacity).toBe(0);
    expect(internals.handleMaterial.opacity).toBe(0);
  });

  it('restores the visuals when a script assigns floating = false', () => {
    const joystick = createJoystick({ floating: true });
    const internals = internalsOf(joystick);
    expect(internals.baseMaterial.opacity).toBe(0);

    joystick.floating = false;

    expect(internals.baseMaterial.opacity).toBeCloseTo(0.3);
    expect(internals.handleMaterial.opacity).toBeCloseTo(0.8);
  });

  it('installs reactive accessors for every own schema field', () => {
    const names = reactiveSchemaPropertyNames(createJoystick());
    for (const expected of ['radius', 'floating', 'axisHorizontal', 'axisVertical']) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
  });
});
