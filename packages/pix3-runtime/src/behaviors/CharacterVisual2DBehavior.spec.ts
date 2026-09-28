import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';

import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';
import { Group2D } from '../nodes/2D/Group2D';
import type { AnimationResource } from '../core/AnimationResource';
import { CharacterVisual2DBehavior } from './CharacterVisual2DBehavior';

function frame(path: string) {
  return {
    textureIndex: 0,
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    durationMultiplier: 1,
    anchor: { x: 0.5, y: 1 },
    texturePath: path,
    boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    collisionPolygon: [],
  };
}

function clip(name: string, frameCount: number, loop: boolean) {
  return {
    name,
    fps: 10,
    loop,
    playbackMode: 'normal' as const,
    frames: Array.from({ length: frameCount }, (_, i) => frame(`res://f/${name}-${i}.png`)),
  };
}

const RESOURCE: AnimationResource = {
  version: '1.0.0',
  texturePath: '',
  clips: [
    clip('sword.idle', 2, true),
    clip('sword.attack', 3, false),
    clip('bow.idle', 2, true),
    clip('bow.attack', 2, false),
    clip('die', 2, false),
  ],
};

function makeCharacter(config: Partial<CharacterVisual2DBehavior> = {}, loaded = true) {
  const root = new Group2D({ id: 'goblin', name: 'Goblin' });
  const sprite = new AnimatedSprite2D({
    id: 'visual',
    name: 'Visual',
    animationResourcePath: 'res://goblin.pix3anim',
    isPlaying: false,
  });
  root.add(sprite);
  if (loaded) {
    sprite.setAnimationResource(RESOURCE);
    for (const c of RESOURCE.clips) {
      for (const f of c.frames) {
        const texture = new Texture();
        texture.name = f.texturePath;
        sprite.setFrameTexture(f.texturePath, texture);
      }
    }
  }
  const behavior = new CharacterVisual2DBehavior('cv', 'core:CharacterVisual2D');
  Object.assign(behavior, config);
  behavior.node = root;
  behavior.onStart();
  return { root, sprite, behavior };
}

describe('CharacterVisual2DBehavior', () => {
  it('plays the configured variant/state on start and lists variants and states', () => {
    const { sprite, behavior } = makeCharacter({ variant: 'sword', state: 'idle' });
    expect(sprite.currentClip).toBe('sword.idle');
    expect(sprite.isPlaying).toBe(true);
    expect(behavior.getVariants()).toEqual(['sword', 'bow', '']);
    expect(behavior.getStates()).toEqual(['idle', 'attack']);
    expect(behavior.getStates('')).toEqual(['die']);
  });

  it('switches states, restarts a repeated attack, and refuses unknown pairs', () => {
    const { sprite, behavior } = makeCharacter({ variant: 'sword', state: 'idle' });

    expect(behavior.playState('attack')).toBe(true);
    expect(sprite.currentClip).toBe('sword.attack');
    sprite.tick(1); // one-shot runs out
    expect(sprite.isPlaying).toBe(false);
    expect(sprite.currentFrame).toBe(2);

    // Repeated attack must begin at frame 0.
    expect(behavior.playState('attack', { restart: true })).toBe(true);
    expect(sprite.currentFrame).toBe(0);
    expect(sprite.isPlaying).toBe(true);

    // Unknown state under this variant: refused, previous clip untouched.
    expect(behavior.playState('jump')).toBe(false);
    expect(behavior.state).toBe('attack');
    expect(sprite.currentClip).toBe('sword.attack');

    expect(behavior.playState('idle')).toBe(true);
    expect(sprite.currentClip).toBe('sword.idle');
  });

  it('keeps the state across a variant switch and restarts its clip', () => {
    const { sprite, behavior } = makeCharacter({ variant: 'sword', state: 'attack' });
    sprite.tick(1);
    expect(sprite.currentFrame).toBe(2);

    expect(behavior.setVariant('bow')).toBe(true);
    expect(behavior.variant).toBe('bow');
    expect(behavior.state).toBe('attack');
    expect(sprite.currentClip).toBe('bow.attack');
    expect(sprite.currentFrame).toBe(0);
    expect(sprite.isPlaying).toBe(true);

    // No `staff.attack` clip: refused, nothing changes.
    expect(behavior.setVariant('staff')).toBe(false);
    expect(behavior.variant).toBe('bow');
    expect(sprite.currentClip).toBe('bow.attack');
  });

  it('emits state-finished on the host when the current one-shot ends', () => {
    const { root, sprite, behavior } = makeCharacter({ variant: 'sword', state: 'idle' });
    const finished = vi.fn();
    root.connect('state-finished', root, finished);

    sprite.tick(1); // looping idle never finishes
    expect(finished).not.toHaveBeenCalled();

    behavior.playState('attack');
    sprite.tick(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith('attack', 'sword');

    behavior.onDetach();
    behavior.playState('attack', { restart: true });
    sprite.tick(1);
    expect(finished).toHaveBeenCalledTimes(1); // unbound after detach
  });

  it('accepts the start state before the resource has loaded', () => {
    const { sprite } = makeCharacter({ variant: 'bow', state: 'idle' }, false);
    expect(sprite.currentClip).toBe('bow.idle');
    sprite.setAnimationResource(RESOURCE);
    expect(sprite.currentClip).toBe('bow.idle');
    expect(sprite.isPlaying).toBe(true);
  });

  it('drives the host itself when it is the AnimatedSprite2D', () => {
    const sprite = new AnimatedSprite2D({ id: 'v', name: 'V', isPlaying: false });
    sprite.setAnimationResource(RESOURCE);
    const behavior = new CharacterVisual2DBehavior('cv', 'core:CharacterVisual2D');
    behavior.state = 'die';
    behavior.node = sprite;
    behavior.onStart();
    expect(sprite.currentClip).toBe('die');
    expect(behavior.getVariants()).toContain('');
  });
});
