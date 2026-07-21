import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Texture } from 'three';

import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';
import { AudioService } from './AudioService';
import { AssetLoader } from './AssetLoader';
import type { AnimationResource } from './AnimationResource';
import { ResourceManager } from './ResourceManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';

const TEST_RESOURCE: AnimationResource = {
  version: '1.0.0',
  texturePath: 'res://textures/player.png',
  clips: [
    {
      name: 'idle',
      fps: 4,
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
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
        {
          textureIndex: 0,
          offset: { x: 0.5, y: 0 },
          repeat: { x: 0.5, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath: '',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
      ],
    },
    {
      name: 'attack',
      fps: 8,
      loop: false,
      playbackMode: 'normal',
      frames: [
        {
          textureIndex: 0,
          offset: { x: 0, y: 0 },
          repeat: { x: 0.25, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath: '',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
        {
          textureIndex: 0,
          offset: { x: 0.25, y: 0 },
          repeat: { x: 0.25, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath: '',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
        {
          textureIndex: 0,
          offset: { x: 0.5, y: 0 },
          repeat: { x: 0.25, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath: '',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
      ],
    },
  ],
};

const SEQUENCE_RESOURCE: AnimationResource = {
  version: '1.0.0',
  texturePath: '',
  clips: [
    {
      name: 'idle',
      fps: 8,
      loop: true,
      playbackMode: 'ping-pong',
      frames: [
        {
          textureIndex: 0,
          offset: { x: 0, y: 0 },
          repeat: { x: 1, y: 1 },
          durationMultiplier: 1,
          anchor: { x: 0.5, y: 1 },
          texturePath: 'res://animations/player/frame_0001.png',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
        {
          textureIndex: 0,
          offset: { x: 0, y: 0 },
          repeat: { x: 1, y: 1 },
          durationMultiplier: 2,
          anchor: { x: 0.5, y: 1 },
          texturePath: 'res://animations/player/frame_0002.png',
          boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          collisionPolygon: [],
        },
      ],
    },
  ],
};

class StubAssetLoader extends AssetLoader {
  async loadAnimationResource(resourcePath: string): Promise<AnimationResource> {
    expect(resourcePath).toBe('res://animations/player.pix3anim');
    return TEST_RESOURCE;
  }

  async loadTexture(resourcePath: string): Promise<Texture> {
    expect(resourcePath).toBe(TEST_RESOURCE.texturePath);
    return new Texture();
  }
}

class SequenceAssetLoader extends AssetLoader {
  private readonly textureByPath = new Map<string, Texture>([
    ['res://animations/player/frame_0001.png', new Texture()],
    ['res://animations/player/frame_0002.png', new Texture()],
  ]);

  async loadAnimationResource(resourcePath: string): Promise<AnimationResource> {
    expect(resourcePath).toBe('res://animations/player.pix3anim');
    return SEQUENCE_RESOURCE;
  }

  async loadTexture(resourcePath: string): Promise<Texture> {
    const texture = this.textureByPath.get(resourcePath);
    expect(texture).toBeDefined();
    return texture ?? new Texture();
  }
}

function getSpriteMaterial(sprite: AnimatedSprite2D): MeshBasicMaterial {
  const mesh = sprite.children.find(child => child instanceof Mesh);
  expect(mesh).toBeInstanceOf(Mesh);
  return (mesh as Mesh).material as MeshBasicMaterial;
}

async function flushMicrotasks(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe('AnimatedSprite2D animation runtime', () => {
  it('advances clip frames by fps and loops using UV transforms on a per-node texture clone', () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-loop',
      name: 'Looper',
      currentClip: 'idle',
    });
    const baseTexture = new Texture();

    sprite.setAnimationResource(TEST_RESOURCE);
    sprite.setSpritesheetTexture(baseTexture);

    const material = getSpriteMaterial(sprite);
    const map = material.map;

    expect(map).toBeInstanceOf(Texture);
    expect(map).not.toBe(baseTexture);
    expect(map?.offset.x).toBeCloseTo(0);
    expect(map?.repeat.x).toBeCloseTo(0.5);

    sprite.tick(0.26);
    expect(sprite.currentFrame).toBe(1);
    expect(map?.offset.x).toBeCloseTo(0.5);

    sprite.tick(0.26);
    expect(sprite.currentFrame).toBe(0);
    expect(map?.offset.x).toBeCloseTo(0);
  });

  it('stops on the final frame for a non-looping clip', () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-once',
      name: 'Once',
      currentClip: 'attack',
    });

    sprite.setAnimationResource(TEST_RESOURCE);
    sprite.tick(0.4);

    expect(sprite.currentFrame).toBe(2);
    expect(sprite.isPlaying).toBe(false);
  });

  it('uses sequence frame textures and honors duration multipliers with ping-pong playback', () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-sequence',
      name: 'Sequence',
      currentClip: 'idle',
    });
    const frameOne = new Texture();
    const frameTwo = new Texture();

    sprite.setAnimationResource(SEQUENCE_RESOURCE);
    sprite.setFrameTexture(0, frameOne);
    sprite.setFrameTexture(1, frameTwo);

    const material = getSpriteMaterial(sprite);

    expect(material.map).toBeInstanceOf(Texture);
    expect(material.map).not.toBe(frameOne);
    expect(material.map?.offset.x).toBeCloseTo(0);
    expect(material.map?.repeat.x).toBeCloseTo(1);

    sprite.tick(0.13);
    expect(sprite.currentFrame).toBe(1);
    expect(material.map?.offset.x).toBeCloseTo(0);
    expect(material.map?.repeat.x).toBeCloseTo(1);

    sprite.tick(0.13);
    expect(sprite.currentFrame).toBe(1);

    sprite.tick(0.13);
    expect(sprite.currentFrame).toBe(0);
  });

  it('serializes authored animation properties and hydrates the sprite from .pix3anim metadata', async () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-persisted',
      name: 'Persisted',
      animationResourcePath: 'res://animations/player.pix3anim',
      currentClip: 'attack',
      currentFrame: 1,
      isPlaying: false,
      width: 96,
      height: 64,
      color: '#ff00ff',
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
    });

    expect(yaml).toContain('animationResourcePath: res://animations/player.pix3anim');
    expect(yaml).toContain('currentClip: attack');
    expect(yaml).toContain('isPlaying: false');
    expect(yaml).not.toContain('\n  frames:');

    const loader = new SceneLoader(
      new StubAssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );

    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as AnimatedSprite2D;
    await flushMicrotasks();

    const material = getSpriteMaterial(loaded);
    const map = material.map;

    expect(loaded.animationResourcePath).toBe('res://animations/player.pix3anim');
    expect(loaded.currentClip).toBe('attack');
    expect(loaded.currentFrame).toBe(1);
    expect(loaded.isPlaying).toBe(false);
    expect(map).toBeInstanceOf(Texture);
    expect(map?.offset.x).toBeCloseTo(0.25);
    expect(map?.repeat.x).toBeCloseTo(0.25);
  });

  it('loads sequence frame textures during scene hydration', async () => {
    const sprite = new AnimatedSprite2D({
      id: 'sprite-sequence-persisted',
      name: 'SequencePersisted',
      animationResourcePath: 'res://animations/player.pix3anim',
      currentClip: 'idle',
      currentFrame: 0,
      isPlaying: true,
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
    });

    const loader = new SceneLoader(
      new SequenceAssetLoader(new ResourceManager('/'), new AudioService()),
      new ScriptRegistry(),
      new ResourceManager('/')
    );

    const graph = await loader.parseScene(yaml, { filePath: 'res://scenes/main.pix3scene' });
    const loaded = graph.rootNodes[0] as AnimatedSprite2D;
    await flushMicrotasks();

    const material = getSpriteMaterial(loaded);
    expect(material.map).toBeInstanceOf(Texture);

    loaded.tick(0.13);
    expect(loaded.currentFrame).toBe(1);
  });
});