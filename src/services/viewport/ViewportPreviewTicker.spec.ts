import { afterEach, describe, expect, it, vi } from 'vitest';
import { Node3D, Script } from '@pix3/runtime';
import type { AssetLoader, EditorPreviewContext, NodeBase, SceneGraph } from '@pix3/runtime';
import { ViewportPreviewTicker } from '@/services/viewport/ViewportPreviewTicker';
import { appState, resetAppState } from '@/state';

/**
 * Render-on-demand contract for script editor previews: implementing `tickEditorPreview` is not a
 * reason to repaint every frame — only a `ctx.requestRender()` issued during the tick is. The old
 * rule counted every component with the method as "animating", which pinned DeepCore's editor at
 * 60 fps forever (Walls/Blocks/Clusters implement it to seed static preview geometry).
 */
function makeTicker(nodes: NodeBase[]) {
  const requestRender = vi.fn();
  const ticker = new ViewportPreviewTicker({
    getActiveSceneGraph: () => ({ rootNodes: nodes }) as unknown as SceneGraph,
    findNodeById: () => null,
    get2DVisualRoot: () => undefined,
    getAssetLoader: () => ({}) as AssetLoader,
    advanceSpinePreview: () => false,
    requestRender,
  });
  return { ticker, requestRender };
}

class StaticPreview extends Script {
  ticks = 0;
  override tickEditorPreview(): void {
    this.ticks += 1;
  }
}

class AnimatedPreview extends Script {
  animating = true;
  override tickEditorPreview(_dt: number, ctx: EditorPreviewContext): void {
    if (this.animating) ctx.requestRender();
  }
}

class DeferredPreview extends Script {
  stored: (() => void) | null = null;
  override tickEditorPreview(_dt: number, ctx: EditorPreviewContext): void {
    this.stored = ctx.requestRender;
  }
}

function nodeWith(component: Script, id: string): Node3D {
  const node = new Node3D({ id, name: id });
  node.addComponent(component);
  return node;
}

describe('ViewportPreviewTicker — component previews render on demand', () => {
  afterEach(() => {
    resetAppState();
  });

  it('ticks a component that only implements tickEditorPreview but keeps the loop idle', () => {
    appState.ui.isPlaying = false;
    const component = new StaticPreview('static', 'user:StaticPreview');
    const { ticker } = makeTicker([nodeWith(component, 'static-node')]);

    ticker.tickComponents(1 / 60);

    expect(component.ticks).toBe(1);
    expect(ticker.hasActivePreview()).toBe(false);
    expect(ticker.getActivePreviewReasons()).toEqual([]);
  });

  it('keeps painting while a component asks for the next frame, and stops when it stops asking', () => {
    appState.ui.isPlaying = false;
    const component = new AnimatedPreview('anim', 'user:AnimatedPreview');
    const { ticker, requestRender } = makeTicker([nodeWith(component, 'anim-node')]);

    ticker.tickComponents(1 / 60);
    expect(ticker.hasActivePreview()).toBe(true);
    expect(ticker.getActivePreviewReasons()).toEqual(['script preview: user:AnimatedPreview']);
    // An in-tick request is a "next frame" flag for the rAF loop, never a synchronous repaint
    // (with the loop parked that would re-enter the tick through microtasks forever).
    expect(requestRender).not.toHaveBeenCalled();

    component.animating = false;
    ticker.tickComponents(1 / 60);
    expect(ticker.hasActivePreview()).toBe(false);
  });

  it('treats a request made after the tick (async asset load) as an ordinary dirty mark', async () => {
    appState.ui.isPlaying = false;
    const component = new DeferredPreview('deferred', 'user:DeferredPreview');
    const { ticker, requestRender } = makeTicker([nodeWith(component, 'deferred-node')]);

    ticker.tickComponents(1 / 60);
    expect(ticker.hasActivePreview()).toBe(false);

    component.stored?.();
    await Promise.resolve();

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(ticker.hasActivePreview()).toBe(false);
  });

  it('drops pending frame requests when play mode starts', () => {
    appState.ui.isPlaying = false;
    const component = new AnimatedPreview('anim-play', 'user:AnimatedPreview');
    const { ticker } = makeTicker([nodeWith(component, 'anim-play-node')]);

    ticker.tickComponents(1 / 60);
    expect(ticker.hasActivePreview()).toBe(true);

    appState.ui.isPlaying = true;
    ticker.tickComponents(1 / 60);
    expect(ticker.hasActivePreview()).toBe(false);
  });
});
