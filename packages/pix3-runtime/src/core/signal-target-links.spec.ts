import { describe, expect, it, vi } from 'vitest';

import { NodeBase } from '../nodes/NodeBase';
import { Script } from './ScriptComponent';

/** A HUD-style script that listens to a signal on ANOTHER node. */
class ListenerScript extends Script {
  readonly calls: unknown[] = [];
  readonly other: unknown[] = [];

  constructor(id = 'listener') {
    super(id, 'test:Listener');
  }

  readonly onScore = (value: unknown): void => {
    this.calls.push(value);
  };

  readonly onOther = (value: unknown): void => {
    this.other.push(value);
  };
}

/** Overrides onDetach without calling super — the engine must still clean up. */
class ForgetfulScript extends ListenerScript {
  override onDetach(): void {
    // intentionally no super.onDetach()
  }
}

function setup(ScriptClass: typeof ListenerScript = ListenerScript) {
  const emitter = new NodeBase({ id: 'game-root' });
  const owner = new NodeBase({ id: 'hud' });
  const script = new ScriptClass();
  owner.addComponent(script);
  emitter.connect('score', script, script.onScore as (...args: unknown[]) => void);
  return { emitter, owner, script };
}

describe('cross-node signal connections are auto-disconnected on script detach', () => {
  it('stops calling the handler after the component is removed', () => {
    const { emitter, owner, script } = setup();
    emitter.emit('score', 1);
    owner.removeComponent(script);
    emitter.emit('score', 2);
    expect(script.calls).toEqual([1]);
  });

  it('cleans up even when an override skips super.onDetach()', () => {
    const { emitter, owner, script } = setup(ForgetfulScript);
    owner.removeComponent(script);
    emitter.emit('score', 2);
    expect(script.calls).toEqual([]);
  });

  it('cleans up when the owner node is queueFree()d', () => {
    const { emitter, owner, script } = setup();
    owner.queueFree();
    NodeBase.flushFreeQueue();
    emitter.emit('score', 3);
    expect(script.calls).toEqual([]);
  });

  it('cleans up when the owner node is disposed directly', () => {
    const { emitter, owner, script } = setup(ForgetfulScript);
    owner.dispose();
    emitter.emit('score', 4);
    expect(script.calls).toEqual([]);
  });

  it('disconnecting one of two handlers keeps the other', () => {
    const { emitter, script } = setup();
    emitter.connect('score', script, script.onOther as (...args: unknown[]) => void);
    emitter.disconnect('score', script, script.onScore as (...args: unknown[]) => void);
    emitter.emit('score', 5);
    expect(script.calls).toEqual([]);
    expect(script.other).toEqual([5]);
  });

  it('a manual disconnect before detach is not undone or doubled by the detach', () => {
    const { emitter, owner, script } = setup();
    const spy = vi.spyOn(emitter, 'disconnect');
    emitter.disconnect('score', script, script.onScore as (...args: unknown[]) => void);
    spy.mockClear();
    owner.removeComponent(script);
    expect(spy).not.toHaveBeenCalled();
    // Reconnecting after detach works normally.
    emitter.connect('score', script, script.onScore as (...args: unknown[]) => void);
    emitter.emit('score', 6);
    expect(script.calls).toEqual([6]);
  });

  it('disconnectAllFromTarget still works, and the later detach is a no-op', () => {
    const { emitter, owner, script } = setup();
    const bystander = new ListenerScript('bystander');
    emitter.connect('score', bystander, bystander.onScore as (...args: unknown[]) => void);
    emitter.disconnectAllFromTarget(script);
    emitter.emit('score', 7);
    expect(script.calls).toEqual([]);
    expect(bystander.calls).toEqual([7]);
    expect(() => owner.removeComponent(script)).not.toThrow();
    emitter.emit('score', 8);
    expect(bystander.calls).toEqual([7, 8]);
  });

  it('a disposed emitter does not throw when the listener detaches', () => {
    const { emitter, owner, script } = setup();
    emitter.dispose();
    expect(() => owner.removeComponent(script)).not.toThrow();
    expect(script.calls).toEqual([]);
  });

  it('detaching one script leaves another script on the same signal connected', () => {
    const { emitter, owner, script } = setup();
    const otherOwner = new NodeBase({ id: 'other' });
    const survivor = new ListenerScript('survivor');
    otherOwner.addComponent(survivor);
    emitter.connect('score', survivor, survivor.onScore as (...args: unknown[]) => void);
    owner.removeComponent(script);
    emitter.emit('score', 9);
    expect(script.calls).toEqual([]);
    expect(survivor.calls).toEqual([9]);
  });

  it('still disconnects own-node connections on detach', () => {
    const owner = new NodeBase({ id: 'self' });
    const script = new ListenerScript();
    owner.addComponent(script);
    owner.connect('score', script, script.onScore as (...args: unknown[]) => void);
    owner.removeComponent(script);
    owner.emit('score', 10);
    expect(script.calls).toEqual([]);
  });
});
