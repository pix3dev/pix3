import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeBase } from './NodeBase';
import { registerScriptErrorSink, type ScriptErrorInfo } from '../core/game-debug';
import type { ScriptComponent } from '../core/ScriptComponent';

const makeComponent = (overrides: Partial<ScriptComponent> = {}): ScriptComponent => ({
  id: 'c1',
  type: 'user:Test',
  node: null,
  enabled: true,
  config: {},
  _started: false,
  ...overrides,
});

// A leaked sink would bleed across tests (it lives on globalThis), so always
// clear it afterwards.
afterEach(() => {
  registerScriptErrorSink(null);
});

describe('NodeBase script error isolation', () => {
  it('catches a throwing onUpdate, disables the component, reports it, and keeps ticking siblings', () => {
    const captured: ScriptErrorInfo[] = [];
    registerScriptErrorSink(e => captured.push(e));

    const node = new NodeBase({ id: 'n1', name: 'Player' });
    const goodUpdate = vi.fn();
    const bad = makeComponent({
      id: 'bad',
      type: 'user:Bad',
      onUpdate: () => {
        throw new Error('boom');
      },
    });
    const ok = makeComponent({ id: 'ok', type: 'user:Ok', onUpdate: goodUpdate });

    node.addComponent(bad);
    node.addComponent(ok);

    expect(() => node.tick(0.016)).not.toThrow();

    // The failing component is disabled and the failure is reported once.
    expect(bad.enabled).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      phase: 'update',
      nodeName: 'Player',
      componentType: 'user:Bad',
      componentId: 'bad',
    });
    expect(captured[0].message).toContain('boom');

    // A sibling on the same node still runs — one bad script can't take out others.
    expect(goodUpdate).toHaveBeenCalledTimes(1);

    // Next frame: the disabled component is skipped (no duplicate report), the
    // healthy one keeps updating.
    node.tick(0.016);
    expect(captured).toHaveLength(1);
    expect(goodUpdate).toHaveBeenCalledTimes(2);
  });

  it('catches a throwing onStart, disables the component, and skips onUpdate that frame', () => {
    const captured: ScriptErrorInfo[] = [];
    registerScriptErrorSink(e => captured.push(e));

    const node = new NodeBase({ id: 'n2', name: 'Enemy' });
    const update = vi.fn();
    const comp = makeComponent({
      onStart: () => {
        throw new Error('start-fail');
      },
      onUpdate: update,
    });

    node.addComponent(comp);

    expect(() => node.tick(0.016)).not.toThrow();
    expect(comp.enabled).toBe(false);
    expect(comp._started).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].phase).toBe('start');
  });

  it('does not throw when no error sink is registered', () => {
    const node = new NodeBase({ id: 'n3', name: 'Solo' });
    node.addComponent(
      makeComponent({
        onUpdate: () => {
          throw new Error('unobserved');
        },
      })
    );

    expect(() => node.tick(0.016)).not.toThrow();
  });
});
