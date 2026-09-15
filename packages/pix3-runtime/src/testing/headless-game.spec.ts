import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHeadlessGame, type HeadlessGame } from './index';

/**
 * The harness, exercised against a real game.
 *
 * This is the demonstration the recommendation rests on: the Carrom sample's whole rule engine,
 * physics solve and AI, driven from a spec in about a second, with no browser anywhere. Each
 * assertion below is one that a type-check, a lint, a YAML validation and a headless *parse* all
 * pass while the game is completely broken — which is exactly what happened when the sample's
 * striker placement had an inverted sign.
 */

const SAMPLE = resolve(process.cwd(), 'samples/Carrom');

/** Text project files, keyed project-relative. Art is skipped: nothing here asserts on pixels. */
function readProjectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(pix3scene|yaml|pix3anim|json)$/.test(entry)) continue;
      files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

async function bootCarrom(): Promise<HeadlessGame> {
  const [
    { GameController },
    { CarromAI },
    { Disc },
    { ShotInput },
    { AimGuide },
    { StrikerTrail },
  ] = await Promise.all([
    import('../../../../samples/Carrom/scripts/GameController'),
    import('../../../../samples/Carrom/scripts/CarromAI'),
    import('../../../../samples/Carrom/scripts/Disc'),
    import('../../../../samples/Carrom/scripts/ShotInput'),
    import('../../../../samples/Carrom/scripts/AimGuide'),
    import('../../../../samples/Carrom/scripts/StrikerTrail'),
  ]);

  const game = await createHeadlessGame({
    files: readProjectFiles(SAMPLE),
    scripts: { GameController, CarromAI, Disc, ShotInput, AimGuide, StrikerTrail },
    viewport: { width: 1080, height: 1920 },
  });
  await game.start('scenes/main.pix3scene');
  return game;
}

describe('headless harness — Carrom', () => {
  let game: HeadlessGame | null = null;

  afterEach(async () => {
    await game?.disposeAsync();
    game = null;
  });

  it('boots a real scene and reaches the game through its own debug provider', async () => {
    game = await bootCarrom();
    await game.step(1);

    const snapshot = game.snapshot();
    expect(snapshot, 'the sample registers a provider in onStart').not.toBeNull();
    // 9 white + 9 black + the queen: piece conservation is the invariant every later assertion
    // is measured against.
    expect(snapshot).toMatchObject({ whiteLeftOnBoard: 9, blackLeftOnBoard: 9 });
    expect(game.errors).toEqual([]);
  });

  it('runs a full-power break to a settled board, with energy that never rises', async () => {
    game = await bootCarrom();
    await game.step(1);

    // Take the opponent out of the run. Without this the AI answers the break with black's turn and
    // the board never stops — which is the game working correctly and the measurement being wrong.
    // Being able to say that in one line, with no input simulation, is the argument for
    // `scene.commands` being scaffolded into every template rather than treated as optional.
    expect(game.dispatch('ai.toggle', { enabled: false })).toBe(true);
    expect(game.dispatch('shoot', { angleDeg: 90, power: 1 })).toBe(true);

    // Sample energy across the solve rather than only at the end: a solver that injects energy
    // still settles eventually, so a settle-only assertion cannot tell the two apart.
    const energy: number[] = [];
    let settledAfterSec: number | null = null;
    for (let step = 1; step <= 24 && settledAfterSec === null; step += 1) {
      await game.run(0.25);
      const snapshot = game.snapshot() ?? {};
      energy.push(Number(snapshot.kineticEnergy ?? 0));
      if (snapshot.state === 'AIM' && step > 2) {
        settledAfterSec = step * 0.25;
      }
    }

    expect(Math.max(...energy), 'the strike put energy into the board').toBeGreaterThan(0);
    expect(settledAfterSec, 'a full-power break settles well inside 6 s').not.toBeNull();
    expect(settledAfterSec ?? Infinity).toBeLessThanOrEqual(4);

    const peak = energy.indexOf(Math.max(...energy));
    for (let i = peak + 1; i < energy.length; i += 1) {
      expect(
        energy[i],
        `energy rose at sample ${i} — the solve is adding energy`
      ).toBeLessThanOrEqual(energy[peak]);
    }
    expect(game.errors).toEqual([]);
  });

  it('keeps every piece inside the playfield across a strike', async () => {
    game = await bootCarrom();
    await game.step(1);
    game.dispatch('ai.toggle', { enabled: false });
    game.dispatch('shoot', { angleDeg: 90, power: 1 });

    let worst = 0;
    for (let i = 0; i < 24; i += 1) {
      await game.run(0.25);
      const discs = (game.snapshot()?.discs ?? []) as { x: number; y: number }[];
      for (const disc of discs) {
        worst = Math.max(worst, Math.abs(disc.x), Math.abs(disc.y));
      }
    }

    // The board half-width plus a disc radius. A tunnelling solver blows straight past this; the
    // measured worst case for this break is ~327.
    expect(worst).toBeLessThan(420);
    expect(game.errors).toEqual([]);
  });

  /**
   * The regression the harness was built for.
   *
   * `strikerLineY()` derived the placement line from the shooter's forward sign with the sign
   * inverted, putting each player's striker on the *opponent's* baseline, aimed off the board.
   * Every static gate passed — the authored coordinate in `main.pix3scene` was correct, and nothing
   * at load time calls the function — so the only evidence was motion.
   *
   * Note what the assertion has to be. "The shot eventually touches something" is **not** enough:
   * with the sign inverted the striker fires at the far cushion, rebounds, and drifts back through
   * the rack for six contacts, so a contact-count assertion passes on a completely unplayable game.
   * The property that actually distinguishes them is direction — a break launched from your own
   * baseline travels *toward* the centre of the board, and the bug sends it away.
   */
  it('launches the striker toward the rack, not away from it', async () => {
    game = await bootCarrom();
    await game.step(1);
    game.dispatch('ai.toggle', { enabled: false });

    const before = game.snapshot()?.striker as { y: number } | undefined;
    expect(before, 'the striker exists before the break').toBeDefined();

    game.dispatch('shoot', { angleDeg: 90, power: 0.9 });
    await game.step(4);
    const after = game.snapshot()?.striker as { y: number } | undefined;

    expect(
      Math.abs(after?.y ?? 0),
      'a break from the shooter own baseline closes on the centre of the board; ' +
        'growing distance means the striker was placed on the opposite baseline'
    ).toBeLessThan(Math.abs(before?.y ?? 0));

    // And it does connect. Necessary but, on its own, not sufficient — see the note above.
    await game.run(3);
    const strike = game.snapshot()?.lastStrike as { contacts?: number } | undefined;
    expect(strike?.contacts ?? 0, 'the break reaches the rack').toBeGreaterThan(0);
    expect(game.errors).toEqual([]);
  });
});
