import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT_DTS_FILE_NAME, PIX3_TEST_BOT_DTS } from '@/services/agent/pix3-test-bot-dts';

/**
 * The declaration file a project gets is what a policy author — human or model —
 * reads to learn the API. Lesson 4 of the session that built this harness: **the thing
 * an agent copies from is the thing that must not drift**, and two examples written in
 * parallel had already diverged once, one of them teaching a call the design forbids.
 *
 * So this guard reads {@link ../agent/game-bots.ts} off disk and checks the declaration
 * against the real interface rather than against a list repeated here. Add a method to
 * `Pix3TestBot` and forget the `.d.ts`, and this fails.
 */

const GAME_BOTS = path.resolve(__dirname, 'game-bots.ts');

/** Member names of an interface, read out of the source. */
function interfaceMembers(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) return [];
  // Brace-matched rather than regexed to the next `}`: the body contains nested object
  // types (`{ x: number; y: number }`), and stopping at the first closing brace would
  // silently read half the interface and then "verify" it in full.
  let depth = 0;
  let end = start;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  const members = new Set<string>();
  // A method (`nodes(query: string)`) or a readonly property (`readonly frame: number`).
  for (const match of body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(?:]/gm)) {
    members.add(match[1]);
  }
  return [...members];
}

describe('pix3-test-bot.d.ts', () => {
  const source = readFileSync(GAME_BOTS, 'utf8');

  it('reads the contract off disk (the guard is computing something)', () => {
    const members = interfaceMembers(source, 'Pix3TestBot');
    // The plan specifies ~10 methods plus the frame counter. A parse that came back
    // with two members would make every check below vacuously true.
    expect(members.length).toBeGreaterThanOrEqual(11);
    expect(members).toContain('done');
  });

  it('declares every member of Pix3TestBot', () => {
    const missing = interfaceMembers(source, 'Pix3TestBot').filter(
      member => !PIX3_TEST_BOT_DTS.includes(member)
    );
    expect(
      missing,
      `${BOT_DTS_FILE_NAME} is missing ${missing.join(', ')}. It is the completion list a policy ` +
        'author sees, so a member absent from it is a member nobody will call.'
    ).toEqual([]);
  });

  it('declares every member of BotPolicy and BotNodeView', () => {
    for (const name of ['BotPolicy', 'BotNodeView'] as const) {
      const members = interfaceMembers(source, name);
      expect(members.length).toBeGreaterThan(2);
      const missing = members.filter(member => !PIX3_TEST_BOT_DTS.includes(member));
      expect(missing, `${BOT_DTS_FILE_NAME} is missing ${name}.${missing.join('/')}`).toEqual([]);
    }
  });

  it('states the timing contract, which is what makes a policy work at all', () => {
    // Not a style check: a policy written without knowing that actuators land on the
    // NEXT tick reads as a game that ignores input, and that is the single most
    // expensive misunderstanding available here.
    expect(PIX3_TEST_BOT_DTS).toContain('NEXT tick');
  });

  it('is valid as a standalone declaration file: globals, no imports', () => {
    expect(PIX3_TEST_BOT_DTS).toContain('declare interface Pix3TestBot');
    // An import would turn the file into a module, and its `declare interface`s would
    // stop being visible to the policy that sits next to it without importing anything.
    expect(PIX3_TEST_BOT_DTS).not.toMatch(/^\s*import\s/m);
    expect(BOT_DTS_FILE_NAME).toMatch(/\.d\.ts$/);
  });
});
