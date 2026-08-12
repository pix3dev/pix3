import { describe, expect, it } from 'vitest';
import type { Mesh, MeshBasicMaterial } from 'three';

import { AnimatedSprite2D } from './AnimatedSprite2D';
import { normalizeAnimationResource } from '../../core/AnimationResource';
import { reactiveSchemaPropertyNames } from '../../fw/reactive-schema-properties';

const meshOf = (sprite: AnimatedSprite2D): Mesh => (sprite as unknown as { mesh: Mesh }).mesh;
const materialOf = (sprite: AnimatedSprite2D): MeshBasicMaterial =>
  (sprite as unknown as { material: MeshBasicMaterial }).material;

/** Two clips whose playback is distinguishable: only "run" carries a frame event. */
function makeSprite(): AnimatedSprite2D {
  const sprite = new AnimatedSprite2D({
    id: 's',
    name: 'S',
    currentClip: 'walk',
    isPlaying: true,
  });
  sprite.setAnimationResource(
    normalizeAnimationResource({
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'walk',
          fps: 10,
          loop: true,
          playbackMode: 'normal',
          frames: [{ textureIndex: 0 }, { textureIndex: 1 }],
        },
        {
          name: 'run',
          fps: 10,
          loop: true,
          playbackMode: 'normal',
          frames: [
            { textureIndex: 0 },
            { textureIndex: 1, events: [{ signal: 'run-step', args: '' }] },
            { textureIndex: 2 },
          ],
        },
      ],
    })
  );
  return sprite;
}

describe('AnimatedSprite2D schema-property reactivity (direct script assignment)', () => {
  it('installs the schema-backed fields but leaves the currentFrame accessor alone', () => {
    const sprite = makeSprite();
    const reactive = reactiveSchemaPropertyNames(sprite);
    for (const name of ['currentClip', 'width', 'height', 'color', 'anchor', 'sizeMode']) {
      expect(reactive.has(name), `expected "${name}" to be reactive`).toBe(true);
    }
    // currentFrame was already a real accessor — the install must not touch it.
    expect(reactive.has('currentFrame')).toBe(false);
    sprite.currentFrame = 99;
    expect(sprite.currentFrame).toBe(1); // still clamps to the walk clip's last frame
  });

  it('currentClip assignment switches the PLAYING clip, not just the serialized field', () => {
    const sprite = makeSprite();
    const steps: unknown[][] = [];
    sprite.connect('run-step', {}, (...args) => steps.push(args));

    // Advance while on "walk": run's frame events must not fire.
    sprite.tick(0.1);
    expect(steps).toEqual([]);

    sprite.currentClip = 'run';
    expect(sprite.currentFrame).toBe(0); // clip switch rewinds (syncActiveClip resetFrame)

    // The proof is playback: entering run's frame 1 fires its event, which only happens
    // when the ACTIVE clip changed — the field alone changed only what got serialized.
    sprite.tick(0.1);
    expect(steps).toEqual([[]]);
  });

  it('width/height assignment rescales the mesh', () => {
    const sprite = makeSprite();
    sprite.width = 128;
    expect(meshOf(sprite).scale.x).toBe(128);
    sprite.height = 32;
    expect(meshOf(sprite).scale.y).toBe(32);
  });

  it('color assignment repaints the untextured material', () => {
    const sprite = makeSprite();
    sprite.color = '#00ff00';
    expect(materialOf(sprite).color.getHex()).toBe(0x00ff00);
  });

  it('anchor assignment moves the frame quad', () => {
    const sprite = makeSprite(); // default 64×64, centre anchor
    expect(meshOf(sprite).position.x).toBe(0);
    sprite.anchor = { x: 0, y: 0 };
    expect(meshOf(sprite).position.x).toBe(32);
    expect(meshOf(sprite).position.y).toBe(32);
  });

  it('sizeMode assignment syncs the serialized bag like the Inspector does', () => {
    const sprite = makeSprite();
    sprite.sizeMode = 'native';
    expect(sprite.properties.sizeMode).toBe('native');
  });
});
