import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';

import { Joystick2D, type Joystick2DProps } from './Joystick2D';
import { AudioService } from '../../../core/AudioService';
import { AssetLoader } from '../../../core/AssetLoader';
import { InputService } from '../../../core/InputService';
import { ResourceManager } from '../../../core/ResourceManager';
import { SceneLoader } from '../../../core/SceneLoader';
import { SceneSaver } from '../../../core/SceneSaver';
import { ScriptRegistry } from '../../../core/ScriptRegistry';
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
    for (const expected of ['enabled', 'radius', 'floating', 'axisHorizontal', 'axisVertical']) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
  });
});

describe('Joystick2D enabled', () => {
  /** Input 200x200 with no scene → screen (100,100) is world (0,0), the joystick's own origin. */
  function createInputService(): InputService {
    const input = new InputService();
    input.width = 200;
    input.height = 200;
    return input;
  }

  it('refuses input and drops a drag in progress the moment it is switched off', () => {
    const joystick = createJoystick({ radius: 50, axisHorizontal: 'MoveX' });
    const input = createInputService();
    joystick.input = input;

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    joystick.tick(1 / 60);
    input.pointerPosition.set(150, 100);
    joystick.tick(1 / 60);
    expect(input.getAxis('MoveX')).toBeCloseTo(1, 5);

    // A stick that stops accepting input must not leave the axes it was writing pushed — the same
    // rule a disabled UIControl2D follows, and the reason a cancelled drag zeroes them too.
    joystick.enabled = false;
    joystick.tick(1 / 60);
    expect(input.getAxis('MoveX')).toBe(0);

    // And a semantic invocation reports the refusal instead of pretending it happened.
    expect(joystick.invokeInteraction('setStick', { dir: 'right', magnitude: 1 })).toBe(false);
    expect(input.getAxis('MoveX')).toBe(0);
  });

  it('round-trips a disabled joystick through save and load', async () => {
    // Serialization for this node is spelled out by hand in SceneSaver/SceneLoader, so an
    // inspector-authored `enabled` reaches the file only through the properties bag. A property the
    // Inspector shows but that silently returns to `true` on reload would be worse than none.
    const joystick = createJoystick();
    joystick.enabled = false;

    const yaml = new SceneSaver().serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [joystick],
      nodeMap: new Map([[joystick.nodeId, joystick]]),
    });
    expect(yaml).toContain('enabled: false');

    const loader = new SceneLoader(
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );
    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/stick.pix3scene' });
    const loaded = graph.rootNodes[0] as Joystick2D;

    expect(loaded).toBeInstanceOf(Joystick2D);
    expect(loaded.enabled).toBe(false);
  });

  it('leaves an untouched joystick out of the saved properties', () => {
    const yaml = new SceneSaver().serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [createJoystick()],
      nodeMap: new Map(),
    });
    expect(yaml).not.toContain('enabled:');
  });
});
