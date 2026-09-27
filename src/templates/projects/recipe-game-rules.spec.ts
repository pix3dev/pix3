import { describe, expect, it } from 'vitest';

import { Group2D, Script, type PropertySchema } from '@pix3/runtime';

import { GameRules as ArenaRules } from './recipe-arena-2d/files/scripts/GameRules';
import { GameRules as BlankRules } from './recipe-blank-2d/files/scripts/GameRules';
import { GameRules as BouncerRules } from './recipe-bouncer-2d/files/scripts/GameRules';
import { GameRules as TapperRules } from './recipe-tapper-2d/files/scripts/GameRules';

/**
 * `GameRules.finish()` freezes the `freezeNodes` SUBTREES, not just the listed nodes' own
 * components: a spawner's instances live under it, and a script inside a spawned prefab (the arena
 * recipe's "chaser" extension) kept crawling over the result card when only the spawner itself was
 * frozen (trial 2026-09-27, D5). `resetRun()` revives exactly what `finish()` switched off.
 */

class Crawler extends Script {
  static getPropertySchema(): PropertySchema {
    return { nodeType: 'Crawler', properties: [] };
  }
}

type Rules = Script & { finish(won: boolean): void; resetRun(): void };

const RECIPES: ReadonlyArray<[string, new (id: string, type: string) => Rules]> = [
  ['recipe-arena-2d', ArenaRules],
  ['recipe-tapper-2d', TapperRules],
  ['recipe-bouncer-2d', BouncerRules],
  ['recipe-blank-2d', BlankRules],
];

describe('recipe GameRules: finish() freezes what the spawners spawned', () => {
  for (const [id, RulesClass] of RECIPES) {
    it(`${id}: a script on a spawned instance stops on game over and resumes on reset`, () => {
      const root = new Group2D({ id: 'game-root', name: 'Game Root' });
      const spawner = new Group2D({ id: 'spawner-x', name: 'Spawner X' });
      const instance = new Group2D({ id: 'chaser-1', name: 'Chaser' });
      const nested = new Group2D({ id: 'chaser-1-eye', name: 'Eye' });
      root.adoptChild(spawner);
      spawner.adoptChild(instance);
      instance.adoptChild(nested);

      const own = new Crawler('spawner-own', 'user:Crawler');
      const chaser = new Crawler('chaser', 'user:Crawler');
      const eye = new Crawler('eye', 'user:Crawler');
      const authoredOff = new Crawler('off', 'user:Crawler');
      authoredOff.enabled = false;
      spawner.addComponent(own);
      instance.addComponent(chaser);
      instance.addComponent(authoredOff);
      nested.addComponent(eye);

      const rules = new RulesClass('rules', 'user:GameRules');
      rules.config = { ...rules.config, freezeNodes: 'spawner-x' };
      root.addComponent(rules);

      rules.finish(false);
      expect([own, chaser, eye].map(c => c.enabled)).toEqual([false, false, false]);

      rules.resetRun();
      expect([own, chaser, eye].map(c => c.enabled)).toEqual([true, true, true]);
      // A component the author left disabled stays disabled.
      expect(authoredOff.enabled).toBe(false);
      rules.onDetach?.();
    });
  }
});
