import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import type { NodeBase } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { syncViewportTransform } from './sync-viewport-transform';

/**
 * The three transform operations call this after mutating a node and again in each of their undo
 * and redo closures.
 *
 * It replaced nine copies of a bare `try { … } catch {}`, whose intent was "the viewport is
 * optional" and whose effect was "no failure here is ever reported" — including one raised inside
 * `updateNodeTransform` during an undo, which leaves the canvas showing a transform the document no
 * longer has. The distinction those two cases is exactly what is asserted here.
 */

const node = { name: 'Box' } as unknown as NodeBase;

let container: ServiceContainer;
let token: symbol;

beforeEach(() => {
  container = new ServiceContainer();
  token = container.getOrCreateToken(ViewportRendererService);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncViewportTransform', () => {
  it('does nothing, quietly, when no viewport is registered', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => syncViewportTransform(container, node)).not.toThrow();
    // A headless container is normal, not an error.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('forwards the node to the registered viewport', () => {
    const updateNodeTransform = vi.fn();
    class FakeViewport {
      updateNodeTransform = updateNodeTransform;
    }
    container.addService(token, FakeViewport as never, ServiceLifetime.Singleton);

    syncViewportTransform(container, node);

    expect(updateNodeTransform).toHaveBeenCalledWith(node);
  });

  it('reports a failure inside the viewport instead of swallowing it', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('proxy mesh is gone');
    class ExplodingViewport {
      updateNodeTransform(): void {
        throw failure;
      }
    }
    container.addService(token, ExplodingViewport as never, ServiceLifetime.Singleton);

    // Still no throw: the document mutation succeeded, and a failed repaint must not undo it.
    expect(() => syncViewportTransform(container, node)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure);
  });
});
