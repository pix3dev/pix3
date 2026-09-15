import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachComponentDefinitions } from './component-hydration';
import { ScriptRegistry } from './ScriptRegistry';
import { NodeBase } from '../nodes/NodeBase';

/**
 * The error channel has to stay worth reading.
 *
 * The editor compiles project scripts asynchronously, so every scene that opens before the first
 * compile reaches `attachComponentDefinitions` with `user:*` types the registry has never heard of.
 * That is the designed path — the definitions are parked and attached on registration — but it used
 * to log `console.error` per component, so opening a project produced a dozen errors that meant
 * nothing. Those are captured by `agent-introspection` and surfaced by the `read_errors` tool, which
 * is what an agent consults to decide whether something is broken. Teaching it that the error
 * channel is mostly noise is how a real failure gets skipped.
 */
describe('attaching component definitions before scripts compile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parks an unregistered type without writing to the error channel', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const node = new NodeBase({ id: 'game-root', name: 'GameRoot', type: 'Group' });
    attachComponentDefinitions(
      node,
      [{ id: 'c1', type: 'user:GameRules', enabled: true, config: {} }],
      new ScriptRegistry()
    );

    expect(node.pendingComponents).toHaveLength(1);
    expect(node.pendingComponents[0].type).toBe('user:GameRules');
    expect(errorSpy, 'a pending component is not an error').not.toHaveBeenCalled();
    // It is still reported — as what it is.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('pending');
  });

  it('still reports an unknown type as an error for callers that expect one', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // `AddComponentOperation` / `AutoloadService` reach the registry directly: there, a missing type
    // means the user asked for something that does not exist, and staying quiet would hide it.
    const created = new ScriptRegistry().createComponent('user:NeverRegistered', 'c1');

    expect(created).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
