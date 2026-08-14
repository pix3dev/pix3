import { describe, expect, it } from 'vitest';
import { Script } from './ScriptComponent';
import { isInteractive, type InteractionDescriptor } from '../fw/interactive';

/**
 * The third source of interactions (after the engine controls and the game's debug provider): a
 * script component. The contract is structural, so a component opts in by implementing the pair —
 * nothing to register and nothing to import — and the discovery walk that lists interactive nodes
 * picks it up from `node.components`.
 *
 * The rule the controls follow holds here too: the invocation goes through the same path a real
 * interaction drives, so a broken path fails instead of a shortcut reporting success.
 */
class Collectible extends Script {
  collected = 0;
  /** Stands in for the game-side gate a real component would consult (an inventory, a cooldown). */
  available = true;

  constructor() {
    super('collectible-1', 'user:Collectible');
  }

  getInteractions(): InteractionDescriptor[] {
    return [
      {
        name: 'collect',
        description: 'Pick the gem up',
        args: [{ name: 'count', type: 'number', defaultValue: 1 }],
      },
    ];
  }

  invokeInteraction(name: string, args?: Record<string, unknown>): boolean {
    if (name !== 'collect' || !this.available) return false;
    const count = typeof args?.count === 'number' ? args.count : 1;
    this.collected += count;
    return true;
  }
}

describe('Script components as an interaction source', () => {
  it('satisfies the Interactive contract by implementing the pair', () => {
    expect(isInteractive(new Collectible())).toBe(true);
  });

  it('a component that declares nothing is not interactive', () => {
    class Plain extends Script {
      constructor() {
        super('plain-1', 'user:Plain');
      }
    }
    expect(isInteractive(new Plain())).toBe(false);
  });

  it('invokes by name, applies declared defaults, and refuses instead of throwing', () => {
    const component = new Collectible();

    expect(component.invokeInteraction('collect')).toBe(true);
    expect(component.collected).toBe(1);
    expect(component.invokeInteraction('collect', { count: 4 })).toBe(true);
    expect(component.collected).toBe(5);

    // Unknown name and a game-side refusal both come back as false — never an exception, because a
    // listing is a promise about this frame and the caller may be holding a stale one.
    expect(component.invokeInteraction('explode')).toBe(false);
    component.available = false;
    expect(component.invokeInteraction('collect')).toBe(false);
    expect(component.collected).toBe(5);
  });
});
