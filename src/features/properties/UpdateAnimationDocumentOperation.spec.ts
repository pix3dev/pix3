import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OperationContext } from '@/core/Operation';
import { appState, getAppStateSnapshot, resetAppState } from '@/state';

import { UpdateAnimationDocumentOperation } from './UpdateAnimationDocumentOperation';

function createAnimationOperationContext(): OperationContext {
  const animationId = 'hero-idle';

  resetAppState();

  appState.animations.activeAnimationId = animationId;
  appState.animations.descriptors[animationId] = {
    id: animationId,
    filePath: 'res://animations/hero.pix3anim',
    name: 'hero.pix3anim',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    lastModifiedTime: null,
  };
  appState.animations.resources[animationId] = {
    version: '1.0.0',
    texturePath: 'res://textures/hero.png',
    clips: [
      {
        name: 'idle',
        fps: 12,
        loop: true,
        playbackMode: 'normal',
        frames: [
          {
            textureIndex: 0,
            offset: { x: 0, y: 0 },
            repeat: { x: 0.5, y: 1 },
            durationMultiplier: 1,
            anchor: { x: 0.5, y: 1 },
            texturePath: '',
            boundingBox: { x: 0, y: 0, width: 16, height: 24 },
            collisionPolygon: [
              { x: 0, y: 0 },
              { x: 16, y: 0 },
              { x: 12, y: 22 },
            ],
          },
        ],
      },
    ],
  };

  return {
    state: appState,
    snapshot: getAppStateSnapshot(),
    container: {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(): T => {
        throw new Error('No services are required for UpdateAnimationDocumentOperation test');
      },
    } as unknown as OperationContext['container'],
    requestedAt: Date.now(),
  } as OperationContext;
}

describe('UpdateAnimationDocumentOperation', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
  });

  it('updates authored clip and frame metadata and supports undo/redo', async () => {
    const context = createAnimationOperationContext();
    const animationId = 'hero-idle';
    const operation = new UpdateAnimationDocumentOperation({
      animationId,
      label: 'Update authored frame metadata',
      updater: resource => ({
        ...resource,
        version: '1.1.0',
        clips: resource.clips.map(clip =>
          clip.name === 'idle'
            ? {
                ...clip,
                playbackMode: 'ping-pong',
                frames: clip.frames.map((frame, index) =>
                  index === 0
                    ? {
                        ...frame,
                        durationMultiplier: 1.5,
                        anchor: { x: 0.25, y: 0.9 },
                        texturePath: 'res://textures/hero-idle-02.png',
                        boundingBox: { x: 2, y: 3, width: 18, height: 28 },
                        collisionPolygon: [
                          { x: 2, y: 1 },
                          { x: 17, y: 1 },
                          { x: 19, y: 24 },
                          { x: 4, y: 27 },
                        ],
                      }
                    : frame
                ),
              }
            : clip
        ),
      }),
    });

    const result = await operation.perform(context);

    expect(result.didMutate).toBe(true);
    expect(context.state.animations.descriptors[animationId]?.isDirty).toBe(true);
    expect(context.state.animations.descriptors[animationId]?.version).toBe('1.1.0');
    expect(context.state.animations.resources[animationId]?.clips[0]).toMatchObject({
      playbackMode: 'ping-pong',
    });
    expect(context.state.animations.resources[animationId]?.clips[0]?.frames[0]).toMatchObject({
      durationMultiplier: 1.5,
      anchor: { x: 0.25, y: 0.9 },
      texturePath: 'res://textures/hero-idle-02.png',
      boundingBox: { x: 2, y: 3, width: 18, height: 28 },
      collisionPolygon: [
        { x: 2, y: 1 },
        { x: 17, y: 1 },
        { x: 19, y: 24 },
        { x: 4, y: 27 },
      ],
    });

    await result.commit?.undo();

    expect(context.state.animations.descriptors[animationId]?.version).toBe('1.0.0');
    expect(context.state.animations.resources[animationId]?.clips[0]).toMatchObject({
      playbackMode: 'normal',
    });
    expect(context.state.animations.resources[animationId]?.clips[0]?.frames[0]).toMatchObject({
      durationMultiplier: 1,
      anchor: { x: 0.5, y: 1 },
      texturePath: '',
      boundingBox: { x: 0, y: 0, width: 16, height: 24 },
      collisionPolygon: [
        { x: 0, y: 0 },
        { x: 16, y: 0 },
        { x: 12, y: 22 },
      ],
    });

    await result.commit?.redo();

    expect(context.state.animations.descriptors[animationId]?.version).toBe('1.1.0');
    expect(context.state.animations.resources[animationId]?.clips[0]?.frames[0]).toMatchObject({
      durationMultiplier: 1.5,
      anchor: { x: 0.25, y: 0.9 },
      texturePath: 'res://textures/hero-idle-02.png',
    });
  });
});
