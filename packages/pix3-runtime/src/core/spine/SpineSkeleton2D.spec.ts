import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';

import { AssetLoader } from '../AssetLoader';
import { ResourceManager } from '../ResourceManager';
import { SpineSkeleton2D } from '../../nodes/2D/SpineSkeleton2D';
import { getNodePropertySchema } from '../../fw/property-schema-utils';
import { parseSpineAtlasPageNames, resolveSpinePagePath } from './SpineAsset';
import {
  setSpineModuleLoader,
  type SpineAnimationStateListener,
  type SpineModule,
  type SpineSkeletonData,
  type SpineTrackEntry,
} from './spine-module';

const ATLAS_TEXT = `hero.png
\tsize: 256, 128
\tfilter: Linear, Linear
head
\tbounds: 2, 2, 40, 40
`;

const SKELETON_JSON = JSON.stringify({ skeleton: { spine: '4.3' } });

/**
 * Minimal stand-in for `@esotericsoftware/spine-threejs`. The real package is an
 * optional dependency the host injects (see `setSpineModuleLoader`), which is
 * exactly what makes it substitutable here: these tests exercise pix3's own
 * loading/playback/signal wiring, not spine's animation math.
 */
function createSpineModuleStub(): {
  module: SpineModule;
  listeners: SpineAnimationStateListener[];
  calls: string[];
} {
  const listeners: SpineAnimationStateListener[] = [];
  const calls: string[] = [];

  const skeletonData: SpineSkeletonData = {
    animations: [
      { name: 'idle', duration: 1 },
      { name: 'run', duration: 0.8 },
    ],
    skins: [{ name: 'default' }, { name: 'blue' }],
    defaultSkin: { name: 'default' },
    version: '4.3',
    x: -50,
    y: 0,
    width: 100,
    height: 200,
    findAnimation: name => skeletonData.animations.find(a => a.name === name) ?? null,
    findSkin: name => skeletonData.skins.find(s => s.name === name) ?? null,
  };

  // Extends the real three.js Object3D: the node parents the mesh with
  // Node2D.add, which traverses the subtree to stamp the 2D layer.
  class FakeSkeletonMesh extends Object3D {
    zOffset = 0.1;
    skeleton = {
      data: skeletonData,
      skin: null as { name: string } | null,
      color: { r: 1, g: 1, b: 1, a: 1 },
      scaleX: 1,
      scaleY: 1,
      setSkin: (skinName: string) => {
        calls.push(`setSkin:${skinName}`);
        this.skeleton.skin = { name: skinName };
      },
      setupPoseSlots: () => calls.push('setupPoseSlots'),
      setupPose: () => calls.push('setupPose'),
    };
    state = {
      data: {
        defaultMix: 0,
        setMix: (from: string, to: string, duration: number) =>
          calls.push(`setMix:${from}->${to}:${duration}`),
      },
      timeScale: 1,
      tracks: [] as (SpineTrackEntry | null)[],
      setAnimation: (trackIndex: number, animationName: string, loop = false) => {
        calls.push(`setAnimation:${trackIndex}:${animationName}:${loop}`);
        const entry: SpineTrackEntry = {
          animation: { name: animationName, duration: 1 },
          trackIndex,
          loop,
          trackTime: 0,
          timeScale: 1,
          mixDuration: 0,
        };
        this.state.tracks[trackIndex] = entry;
        return entry;
      },
      addAnimation: (trackIndex: number, animationName: string, loop = false, delay = 0) => {
        calls.push(`addAnimation:${trackIndex}:${animationName}:${loop}:${delay}`);
        return {
          animation: { name: animationName, duration: 1 },
          trackIndex,
          loop,
          trackTime: 0,
          timeScale: 1,
          mixDuration: 0,
        };
      },
      setEmptyAnimation: (trackIndex: number, mixDuration = 0) => {
        calls.push(`setEmptyAnimation:${trackIndex}:${mixDuration}`);
        return {
          animation: null,
          trackIndex,
          loop: false,
          trackTime: 0,
          timeScale: 1,
          mixDuration,
        };
      },
      clearTrack: (trackIndex: number) => calls.push(`clearTrack:${trackIndex}`),
      clearTracks: () => calls.push('clearTracks'),
      addListener: (listener: SpineAnimationStateListener) => listeners.push(listener),
    };
    update(dt: number): void {
      calls.push(`update:${dt}`);
    }
    dispose(): void {
      calls.push('dispose');
    }
  }

  const module = {
    TextureAtlas: class {
      pages = [
        {
          name: 'hero.png',
          width: 256,
          height: 128,
          pma: false,
          texture: null,
          setTexture(texture: unknown) {
            this.texture = texture as null;
          },
        },
      ];
      dispose(): void {
        calls.push('atlas.dispose');
      }
    },
    AtlasAttachmentLoader: class {},
    SkeletonJson: class {
      scale = 1;
      readSkeletonData(source: unknown): SpineSkeletonData {
        calls.push(`json:${typeof source}:${String(source).slice(0, 12)}`);
        return skeletonData;
      }
    },
    SkeletonBinary: class {
      scale = 1;
      readSkeletonData(source: unknown): SpineSkeletonData {
        calls.push(`binary:${source instanceof Uint8Array ? 'u8' : typeof source}`);
        return skeletonData;
      }
    },
    SkeletonMesh: FakeSkeletonMesh,
    ThreeJsTexture: class {
      texture = { colorSpace: '', generateMipmaps: true, minFilter: 0, magFilter: 0 };
      dispose(): void {}
    },
  } as unknown as SpineModule;

  return { module, listeners, calls };
}

class StubResourceManager extends ResourceManager {
  override async readText(resource: string): Promise<string> {
    if (resource.endsWith('.atlas')) {
      return ATLAS_TEXT;
    }
    if (resource.endsWith('.json')) {
      return SKELETON_JSON;
    }
    throw new Error(`Unexpected readText: ${resource}`);
  }

  override async readBlob(): Promise<Blob> {
    return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  }
}

const REQUEST = {
  skeletonPath: 'res://spine/hero.json',
  atlasPath: 'res://spine/hero.atlas',
};

describe('Spine atlas text parsing', () => {
  it('reads page image names and skips region names', () => {
    expect(parseSpineAtlasPageNames(ATLAS_TEXT)).toEqual(['hero.png']);
  });

  it('reads every page of a multi-page atlas', () => {
    const text = `a.png\n\tsize: 8, 8\nregion-a\n\tbounds: 0,0,1,1\n\nb.png\n\tsize: 8, 8\nregion-b\n\tbounds: 0,0,1,1\n`;
    expect(parseSpineAtlasPageNames(text)).toEqual(['a.png', 'b.png']);
  });

  it('resolves page names against the atlas directory', () => {
    expect(resolveSpinePagePath('res://spine/hero.atlas', 'hero.png')).toBe('res://spine/hero.png');
    expect(resolveSpinePagePath('res://spine/hero.atlas', './pages/hero.png')).toBe(
      'res://spine/pages/hero.png'
    );
    expect(resolveSpinePagePath('res://a/hero.atlas', 'res://shared/hero.png')).toBe(
      'res://shared/hero.png'
    );
  });
});

describe('SpineSkeleton2D playback', () => {
  let stub: ReturnType<typeof createSpineModuleStub>;
  let assetLoader: AssetLoader;

  beforeEach(() => {
    stub = createSpineModuleStub();
    setSpineModuleLoader(() => Promise.resolve(stub.module));
    assetLoader = new AssetLoader(new StubResourceManager('/'));
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({} as ImageBitmap));
  });

  afterEach(() => {
    setSpineModuleLoader(null);
    vi.unstubAllGlobals();
  });

  it('caches and de-duplicates asset loads by path triple', async () => {
    const [first, second] = await Promise.all([
      assetLoader.loadSpineAsset(REQUEST),
      assetLoader.loadSpineAsset(REQUEST),
    ]);

    expect(first).toBe(second);
    expect(assetLoader.getCachedSpineAsset(REQUEST)).toBe(first);
  });

  it('hands JSON exports to SkeletonJson as raw text and .skel to SkeletonBinary', async () => {
    // `SkeletonJson.readSkeletonData` takes `string | object` and parses a string
    // itself (spine-core 4.3), so the loader passes `readText` through untouched;
    // the binary reader needs a Uint8Array.
    await assetLoader.loadSpineAsset(REQUEST);
    expect(stub.calls).toContain(`json:string:${SKELETON_JSON.slice(0, 12)}`);

    await assetLoader.loadSpineAsset({ ...REQUEST, skeletonPath: 'res://spine/hero.skel' });
    expect(stub.calls).toContain('binary:u8');
  });

  it('rejects with actionable guidance when no Spine runtime is registered', async () => {
    setSpineModuleLoader(null);
    await expect(assetLoader.loadSpineAsset(REQUEST)).rejects.toThrow(
      /@esotericsoftware\/spine-threejs/
    );
  });

  it('starts the authored animation and exposes the skeleton catalogue', async () => {
    const node = new SpineSkeleton2D({
      id: 'hero',
      name: 'Hero',
      ...REQUEST,
      animation: 'run',
      loop: true,
    });

    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    expect(node.isLoaded).toBe(true);
    expect(node.getAnimationNames()).toEqual(['idle', 'run']);
    expect(node.getSkinNames()).toEqual(['default', 'blue']);
    expect(node.getSetupBounds()).toEqual({ x: -50, y: 0, width: 100, height: 200 });
    expect(stub.calls).toContain('setAnimation:0:run:true');
  });

  it('refuses unknown animation and skin names without throwing', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(node.play('nope')).toBe(false);
    expect(node.setSkin('nope')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();

    expect(node.play('idle')).toBe(true);
    expect(node.animation).toBe('idle');
    expect(node.setSkin('blue')).toBe(true);
    expect(node.skin).toBe('blue');
  });

  it('queues animations and mixes back to the setup pose on stop', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    expect(node.queue('run', { loop: true, delay: 0.25 })).toBe(true);
    expect(stub.calls).toContain('addAnimation:0:run:true:0.25');

    node.stop({ mixDuration: 0.3 });
    expect(stub.calls).toContain('setEmptyAnimation:0:0.3');
    expect(node.isPlaying).toBe(false);
  });

  it('emits animation signals and self-frees when freeOnFinish is set', async () => {
    const node = new SpineSkeleton2D({
      id: 'hero',
      name: 'Hero',
      ...REQUEST,
      animation: 'run',
      loop: false,
      freeOnFinish: true,
    });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    const finished: unknown[] = [];
    const looped: unknown[] = [];
    const events: unknown[] = [];
    const receiver = {};
    node.connect('animation-finished', receiver, (...args: unknown[]) => finished.push(args));
    node.connect('animation-looped', receiver, (...args: unknown[]) => looped.push(args));
    node.connect('spine-event', receiver, (...args: unknown[]) => events.push(args));
    const queueFree = vi.spyOn(node, 'queueFree');

    const listener = stub.listeners[0];
    listener.complete?.({
      animation: { name: 'run', duration: 1 },
      trackIndex: 0,
      loop: false,
      trackTime: 1,
      timeScale: 1,
      mixDuration: 0,
    });
    listener.complete?.({
      animation: { name: 'idle', duration: 1 },
      trackIndex: 1,
      loop: true,
      trackTime: 1,
      timeScale: 1,
      mixDuration: 0,
    });
    listener.event?.(
      {
        animation: { name: 'run', duration: 1 },
        trackIndex: 0,
        loop: false,
        trackTime: 0.5,
        timeScale: 1,
        mixDuration: 0,
      },
      { data: { name: 'footstep' }, intValue: 2, floatValue: 0.5, stringValue: 'left' }
    );

    expect(finished).toEqual([['run', 0]]);
    expect(looped).toEqual([['idle', 1]]);
    expect(events).toEqual([['footstep', { int: 2, float: 0.5, string: 'left' }, 0]]);
    expect(node.isPlaying).toBe(false);
    expect(queueFree).toHaveBeenCalledOnce();
  });

  it('advances the skeleton only while playing', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST, animation: 'idle' });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    stub.calls.length = 0;
    node.tick(0.016);
    expect(stub.calls.filter(call => call.startsWith('update:'))).toEqual(['update:0.016']);

    node.pause();
    stub.calls.length = 0;
    node.tick(0.016);
    expect(stub.calls.filter(call => call.startsWith('update:'))).toEqual([]);
  });

  it('holds the first frame in the editor by default and rewinds on demand', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST, animation: 'run' });
    // Editor playback is opt-in: a freshly authored node never animates the
    // viewport until `previewInEditor` is switched on.
    expect(node.previewInEditor).toBe(false);

    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    stub.calls.length = 0;
    node.resetToFirstFrame();
    // Re-set (not a trackTime poke) so mixing/events restart from zero, then one
    // geometry rebuild at dt 0 — and nothing about the authored state changes.
    expect(stub.calls).toEqual(['setAnimation:0:run:true', 'update:0']);
    expect(node.animation).toBe('run');
    expect(node.isPlaying).toBe(true);
  });

  it('rewinds to the setup pose when no animation is playing', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    stub.calls.length = 0;
    node.resetToFirstFrame();
    expect(stub.calls).toEqual(['setupPose', 'update:0']);
  });

  it('replaces the static animation/skin props instead of duplicating them', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    const merged = getNodePropertySchema(node);
    const animationProps = merged.properties.filter(p => p.name === 'animation');
    const skinProps = merged.properties.filter(p => p.name === 'skin');
    // One row each in the inspector — a text field next to its own dropdown was
    // the bug this guards.
    expect(animationProps).toHaveLength(1);
    expect(skinProps).toHaveLength(1);
    expect(animationProps[0].type).toBe('select');
    expect(skinProps[0].type).toBe('select');
    // Replaced in place, so the Animation group keeps its authored ordering.
    const staticNames = SpineSkeleton2D.getPropertySchema().properties.map(p => p.name);
    expect(merged.properties.map(p => p.name)).toEqual(staticNames);
  });

  it('upgrades animation/skin to dropdowns once the skeleton is loaded', async () => {
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    expect(node.getInstancePropertySchema()).toBeNull();

    node.setSpineAsset(await assetLoader.loadSpineAsset(REQUEST));

    const schema = node.getInstancePropertySchema();
    const animation = schema?.properties.find(p => p.name === 'animation');
    const skin = schema?.properties.find(p => p.name === 'skin');
    expect(animation?.type).toBe('select');
    expect(animation?.ui?.options).toEqual(['', 'idle', 'run']);
    expect(skin?.ui?.options).toEqual(['', 'default', 'blue']);
  });

  it('disposes the view but never the shared asset', async () => {
    const asset = await assetLoader.loadSpineAsset(REQUEST);
    const node = new SpineSkeleton2D({ id: 'hero', name: 'Hero', ...REQUEST });
    node.setSpineAsset(asset);

    node.dispose();

    expect(stub.calls).toContain('dispose');
    expect(stub.calls).not.toContain('atlas.dispose');
    expect(node.isLoaded).toBe(false);
    // Still cached for other nodes / the editor proxy.
    expect(assetLoader.getCachedSpineAsset(REQUEST)).toBe(asset);
  });
});
