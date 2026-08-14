import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT_DIRECTORY } from '@/services/agent/game-bots';
import { ROUTINE_DIRECTORY } from '@/services/agent/game-routines';
import { REPORT_DIRECTORY } from '@/services/agent/game-run-protocol';
import { TRACE_DIRECTORY } from '@/services/agent/game-traces';

/**
 * The gameplay-testing harness must not be able to reach a shipped game (§5.3 of
 * `.plans/agent-gameplay-testing.md`, phase 8).
 *
 * The plan asked for "a spec proving there is no test code in the production bundle,
 * modelled on `strippable-runtime-modules.spec.ts`" — i.e. one that **recomputes the
 * facts from disk** rather than restating a decision. A declaration of intent would
 * pass forever; this fails the moment someone imports the harness from the runtime or
 * moves the policies into a directory the export collects.
 *
 * Two leak paths exist, and each gets its own recomputed check.
 *
 * 1. **Code.** A playable bundle's roots are the runtime package's own entry files
 *    plus the project's scripts. The runtime is a separate package with no `@/` alias,
 *    so the only way harness code could enter is a module under
 *    `packages/pix3-runtime/src` mentioning it — which is what the first test scans
 *    for, across the whole package rather than along one import chain, because a
 *    mention in a module a player *might* keep is already a mistake.
 *
 * 2. **Files.** Policies are TypeScript in the project's own tree, so the question is
 *    whether the export (and the editor's own script loader, which registers
 *    components into the live game) ever walks the directory they live in. It walks
 *    exactly `PROJECT_SCRIPT_DIRECTORIES`, read here out of `ProjectBuildService`, and
 *    the second test asserts every harness directory sits outside all of them. That is
 *    the invariant that makes a bot structurally incapable of registering itself as a
 *    game script component.
 *
 * What this spec deliberately does NOT claim: that a *user* cannot ship the files by
 * hand. `exportSettings.includeGlobs` is theirs, and a project that globs `design/**`
 * ships those bytes as assets. They are data either way — nothing loads or executes
 * them — and second-guessing an explicit include would be the wrong trade.
 */

const RUNTIME_SRC = path.resolve(__dirname, '../../../packages/pix3-runtime/src');
const PROJECT_BUILD_SERVICE = path.resolve(__dirname, 'ProjectBuildService.ts');

/**
 * Identifiers that only exist in the harness. Module names rather than a blanket
 * `agent` match: the runtime legitimately talks about game debug providers and
 * commands, which the agent tools consume, and a check that fired on the word would be
 * turned off within a week.
 */
const HARNESS_MODULES = [
  'game-bots',
  'GameBotHost',
  'pix3-test-bot',
  'GameTestService',
  'GameInputService',
  'game-monkey',
  'game-routines',
  'game-traces',
  'game-assertions',
  'game-control',
  'game-run-protocol',
  'AgentToolRegistry',
  'BotSession',
  'Pix3TestBot',
] as const;

const listRuntimeSources = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listRuntimeSources(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(entryPath);
    }
  }
  return found;
};

/** `path.relative` yields backslashes on Windows; every message here is written with `/`. */
const toModulePath = (absolutePath: string): string =>
  path.relative(RUNTIME_SRC, absolutePath).split(path.sep).join('/');

describe('no test harness in a production bundle', () => {
  it('is not mentioned anywhere in the runtime package', () => {
    const sources = listRuntimeSources(RUNTIME_SRC);
    // A guard that scanned nothing would pass forever. The runtime is hundreds of
    // modules; anything near zero means the walk broke, not that the package shrank.
    expect(sources.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const name of HARNESS_MODULES) {
        if (source.includes(name)) {
          offenders.push(`${toModulePath(file)} mentions ${name}`);
        }
      }
    }

    // The runtime is what a playable ships. A harness symbol reachable from it is a
    // harness symbol in the shipped game — which is the leak this whole check exists
    // for, and it cannot be argued away by "that module gets tree-shaken": the
    // measured floor of `.plans/playable-export-size.md` is that tree-shaking does not
    // reach anything a kept module value-imports.
    expect(
      offenders,
      'The runtime must stay unaware of the editor-side gameplay-testing harness. ' +
        'If a runtime module genuinely needs one of these concepts, the shared part belongs ' +
        'in the runtime under its own name (as `game-debug.ts` and `GameCommands.ts` already are), ' +
        'not as an import of the harness.'
    ).toEqual([]);
  });

  it('keeps every harness directory outside the directories the build collects scripts from', () => {
    const source = readFileSync(PROJECT_BUILD_SERVICE, 'utf8');
    const declaration = /const PROJECT_SCRIPT_DIRECTORIES = \[([^\]]*)\]/.exec(source);
    expect(
      declaration,
      'PROJECT_SCRIPT_DIRECTORIES could not be read out of ProjectBuildService — this guard is ' +
        'computing nothing until the pattern is fixed.'
    ).not.toBeNull();

    const scriptDirectories = [...(declaration?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
      match => match[1]
    );
    expect(scriptDirectories.length).toBeGreaterThan(0);

    const harnessDirectories = [
      BOT_DIRECTORY,
      ROUTINE_DIRECTORY,
      TRACE_DIRECTORY,
      REPORT_DIRECTORY,
    ];
    for (const harness of harnessDirectories) {
      for (const scripts of scriptDirectories) {
        expect(
          harness === scripts || harness.startsWith(`${scripts}/`),
          `${harness} sits inside "${scripts}", which the export collects as project scripts and ` +
            `the editor's script loader compiles into the live ScriptRegistry. Test policies would ` +
            `then be bundled into shipped games and registered as game components. Move the harness ` +
            `directory back out, or the leak is real rather than theoretical.`
        ).toBe(false);
      }
    }
  });

  it('keeps the policies where the bot host and the store agree they are', () => {
    // Cheap, and it is the failure that would silently disable the check above: a
    // constant renamed in one place and hardcoded in another makes the directory test
    // assert something about a path nothing uses.
    expect(BOT_DIRECTORY).toBe('design/tests/bots');
    const store = readFileSync(path.resolve(__dirname, '../agent/ProjectTraceStore.ts'), 'utf8');
    expect(store).toContain('BOT_DIRECTORY');
    expect(store).not.toMatch(/listDirectory\('design\/tests\/bots'\)/);
  });
});
