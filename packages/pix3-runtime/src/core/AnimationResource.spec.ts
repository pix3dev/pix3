import { describe, expect, it } from 'vitest';

import { normalizeAnimationResource } from './AnimationResource';

describe('AnimationResource normalization', () => {
  it('hydrates new metadata fields with safe defaults for legacy assets', () => {
    const resource = normalizeAnimationResource({
      version: '1.0.0',
      texturePath: 'res://textures/hero.png',
      clips: [
        {
          name: 'idle',
          fps: 12,
          loop: true,
          frames: [
            {
              textureIndex: 0,
              offset: { x: 0, y: 0 },
              repeat: { x: 0.5, y: 1 },
            },
          ],
        },
      ],
    });

    expect(resource.clips[0]?.playbackMode).toBe('normal');
    expect(resource.clips[0]?.frames[0]).toMatchObject({
      durationMultiplier: 1,
      anchor: { x: 0.5, y: 0.5 },
      texturePath: '',
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      collisionPolygon: [],
    });
  });

  it('normalizes authored metadata without dropping frame geometry', () => {
    const resource = normalizeAnimationResource({
      version: '1.1.0',
      texturePath: 'res://textures/hero.png',
      clips: [
        {
          name: 'attack',
          fps: 24,
          loop: false,
          playbackMode: 'ping-pong',
          frames: [
            {
              textureIndex: 2.9,
              offset: { x: 0.25, y: 0 },
              repeat: { x: 0.25, y: 1 },
              durationMultiplier: 1.5,
              anchor: { x: 0.5, y: 1 },
              texturePath: 'res://textures/hero-attack.png',
              boundingBox: { x: 2, y: 3, width: 24, height: 28 },
              collisionPolygon: [
                { x: 1, y: 2 },
                { x: 14, y: 2 },
                { x: 10, y: 18 },
              ],
            },
          ],
        },
      ],
    });

    expect(resource.clips[0]).toMatchObject({
      playbackMode: 'ping-pong',
    });
    expect(resource.clips[0]?.frames[0]).toMatchObject({
      textureIndex: 2,
      durationMultiplier: 1.5,
      anchor: { x: 0.5, y: 1 },
      texturePath: 'res://textures/hero-attack.png',
      boundingBox: { x: 2, y: 3, width: 24, height: 28 },
      collisionPolygon: [
        { x: 1, y: 2 },
        { x: 14, y: 2 },
        { x: 10, y: 18 },
      ],
    });
  });
});
