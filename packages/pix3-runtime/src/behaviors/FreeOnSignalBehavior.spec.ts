import { describe, expect, it, vi } from 'vitest';
import { NodeBase } from '../nodes/NodeBase';
import { FreeOnSignalBehavior } from './FreeOnSignalBehavior';

function attach(config?: Record<string, unknown>): { node: NodeBase; behavior: FreeOnSignalBehavior; free: ReturnType<typeof vi.fn> } {
  const node = new NodeBase({ id: 'fx', type: 'AnimatedSprite2D', name: 'FX' });
  const free = vi.fn();
  node.queueFree = free;
  const behavior = new FreeOnSignalBehavior('free-on-signal', 'core:FreeOnSignal');
  behavior.node = node;
  if (config) Object.assign(behavior.config, config);
  behavior.onStart();
  return { node, behavior, free };
}

describe('FreeOnSignalBehavior', () => {
  it('frees the node on the default signal (animation-finished) after the signal fires', () => {
    const { node, behavior, free } = attach();

    behavior.onUpdate(0.016);
    expect(free).not.toHaveBeenCalled(); // no signal yet

    node.emit('animation-finished', 'burst');
    behavior.onUpdate(0.016); // delay 0 → frees on the next update
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('waits the configured delay before freeing', () => {
    const { node, behavior, free } = attach({ delay: 0.1 });

    node.emit('animation-finished');
    behavior.onUpdate(0.05);
    expect(free).not.toHaveBeenCalled(); // still within the delay
    behavior.onUpdate(0.06); // total 0.11 > 0.1
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('listens to a custom signal name', () => {
    const { node, behavior, free } = attach({ signal: 'died' });

    node.emit('animation-finished'); // wrong signal — ignored
    behavior.onUpdate(0.016);
    expect(free).not.toHaveBeenCalled();

    node.emit('died');
    behavior.onUpdate(0.016);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('frees only once even if the signal fires repeatedly', () => {
    const { node, behavior, free } = attach();

    node.emit('animation-finished');
    node.emit('animation-finished');
    behavior.onUpdate(0.016);
    behavior.onUpdate(0.016);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('does not free after onDetach', () => {
    const { node, behavior, free } = attach();
    behavior.onDetach();

    node.emit('animation-finished');
    behavior.onUpdate(0.016);
    expect(free).not.toHaveBeenCalled();
  });
});
