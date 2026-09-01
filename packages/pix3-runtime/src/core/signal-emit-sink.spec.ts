import { afterEach, describe, expect, it } from 'vitest';

import { NodeBase } from '../nodes/NodeBase';
import { registerSignalEmitSink, type SignalEmitInfo } from './game-debug';

/**
 * Signals are how one part of a game tells another that something happened, and they used to be
 * completely unobservable: a signal that fired into nothing looked exactly like a signal that
 * never fired. The editor registers a sink that puts them in the Logs panel; an exported build
 * registers none and pays one property read.
 */
describe('signal-emit sink', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  const makeNode = () => new NodeBase({ id: 'coin-1', name: 'Coin' });

  it('reports an emission with its listener count and arguments', () => {
    const seen: SignalEmitInfo[] = [];
    dispose = registerSignalEmitSink(info => seen.push(info));

    const node = makeNode();
    node.signal('collected');
    node.connect('collected', node, () => undefined);
    node.emit('collected', 7);

    expect(seen).toEqual([
      { nodeId: 'coin-1', nodeName: 'Coin', signal: 'collected', listenerCount: 1, args: [7] },
    ]);
  });

  it('reports a signal nobody listens to — the case worth seeing', () => {
    const seen: SignalEmitInfo[] = [];
    dispose = registerSignalEmitSink(info => seen.push(info));

    makeNode().emit('opened');

    expect(seen).toHaveLength(1);
    expect(seen[0].listenerCount).toBe(0);
  });

  it('is a no-op with no sink registered, and survives a sink that throws', () => {
    const node = makeNode();
    node.connect('collected', node, () => undefined);
    expect(() => node.emit('collected')).not.toThrow();

    dispose = registerSignalEmitSink(() => {
      throw new Error('observer exploded');
    });
    // Observing the game must never be able to change it.
    expect(() => node.emit('collected')).not.toThrow();
  });

  it('still delivers to listeners while a sink is attached', () => {
    dispose = registerSignalEmitSink(() => undefined);
    const node = makeNode();
    const received: unknown[] = [];
    node.connect('collected', node, (...args: unknown[]) => received.push(...args));

    node.emit('collected', 'gold');

    expect(received).toEqual(['gold']);
  });
});
