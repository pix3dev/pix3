import { describe, expect, it } from 'vitest';

import { createHeadlessGame } from '@pix3/runtime/testing';
import { AnimatedSprite2D, CharacterVisual2DBehavior } from '@pix3/runtime';

import { compileCharacter } from './character-compiler';

/**
 * The Phase 0 gate of `.plans/asset-store-packs.md`, run through the REAL loader: the compiled
 * character boots as a prefab instance, the component drives clips, a repeated attack restarts,
 * idle comes back, and a variant switch after `die` works — with no script errors. Pixels are
 * covered by the SceneLoader/AnimatedSprite2D specs (this harness has no rasterizer).
 */
const px = (path: string) => ({ path, width: 100, height: 100 });

const GOBLIN = compileCharacter({
  name: 'Goblin',
  slug: 'goblin',
  defaultVariant: 'sword',
  defaultState: 'idle',
  clips: [
    { variant: 'sword', state: 'idle', frames: [px('s/i1.png'), px('s/i2.png')], fps: 10 },
    {
      variant: 'sword',
      state: 'attack',
      frames: [px('s/a1.png'), px('s/a2.png'), px('s/a3.png')],
      fps: 10,
    },
    { variant: 'sword', state: 'die', frames: [px('s/d1.png'), px('s/d2.png')], fps: 10 },
    { variant: 'bow', state: 'idle', frames: [px('b/i1.png'), px('b/i2.png')], fps: 10 },
    { variant: 'bow', state: 'attack', frames: [px('b/a1.png'), px('b/a2.png')], fps: 10 },
    { variant: 'bow', state: 'die', frames: [px('b/d1.png')], fps: 10 },
  ],
});

const MAIN_SCENE = [
  'version: 1.0.0',
  'root:',
  '  - id: stage',
  '    type: Group2D',
  '    name: Stage',
  '    properties:',
  '      width: 1920',
  '      height: 1080',
  '    children:',
  '      - id: goblin-1',
  '        name: Goblin',
  `        instance: res://${GOBLIN.prefabPath}`,
].join('\n');

describe('compiled character in a headless game', () => {
  it('boots, plays states through core:CharacterVisual2D and switches variants', async () => {
    const game = await createHeadlessGame({
      files: {
        'scenes/main.pix3scene': MAIN_SCENE,
        [GOBLIN.prefabPath]: GOBLIN.prefabYaml,
        [GOBLIN.animationPath]: GOBLIN.animationJson,
      },
    });
    try {
      await game.start('scenes/main.pix3scene');
      await game.flush();

      const visual = game.findNode('Visual');
      expect(visual).toBeInstanceOf(AnimatedSprite2D);
      const sprite = visual as AnimatedSprite2D;
      const character = game
        .findNode('Goblin')
        ?.components.find(
          (c): c is CharacterVisual2DBehavior => c instanceof CharacterVisual2DBehavior
        );
      expect(character).toBeDefined();
      if (!character) return;

      expect(sprite.currentClip).toBe('sword.idle');
      expect(sprite.isPlaying).toBe(true);
      expect(character.getVariants()).toEqual(['sword', 'bow']);
      expect(character.getStates()).toEqual(['idle', 'attack', 'die']);

      // idle → attack → (finishes, holds last frame) → attack again from frame 0 → idle
      expect(character.playState('attack')).toBe(true);
      await game.step(30); // 0.5 s at 60 fps; the 3-frame 10 fps clip ends
      expect(sprite.currentClip).toBe('sword.attack');
      expect(sprite.currentFrame).toBe(2);
      expect(sprite.isPlaying).toBe(false);

      expect(character.playState('attack', { restart: true })).toBe(true);
      expect(sprite.currentFrame).toBe(0);
      expect(sprite.isPlaying).toBe(true);
      await game.step(8);
      expect(sprite.currentFrame).toBe(1);

      expect(character.playState('idle')).toBe(true);
      expect(sprite.currentClip).toBe('sword.idle');
      await game.step(30);
      expect(sprite.isPlaying).toBe(true); // loops

      // die, then change the weapon: the bow's die clip starts over.
      expect(character.playState('die')).toBe(true);
      await game.step(30);
      expect(sprite.isPlaying).toBe(false);
      expect(character.setVariant('bow')).toBe(true);
      expect(sprite.currentClip).toBe('bow.die');
      expect(sprite.currentFrame).toBe(0);
      expect(character.setVariant('staff')).toBe(false); // no such variant
      expect(character.variant).toBe('bow');

      expect(character.playState('idle')).toBe(true);
      expect(sprite.currentClip).toBe('bow.idle');
      expect(game.errors).toEqual([]);
    } finally {
      game.dispose();
    }
  });
});
