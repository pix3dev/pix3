import { describe, expect, it } from 'vitest';
import {
  planSuggestedKeys,
  resolveMissingKey,
  scanSceneDefinitionText,
  scanScriptText,
  slugifyKey,
  type ScriptKeyHit,
} from './LocalizationExtractionService';

const SCENE_YAML = `
version: 1.0.0
root:
  - id: ui-root
    type: Group2D
    name: Root
    properties:
      width: 1920
    children:
      - id: btn-play
        type: Button2D
        name: Play Button
        properties:
          label: PLAY
      - id: btn-quit
        type: Button2D
        name: Quit Button
        properties:
          label: QUIT
          labelKey: menu.quit
      - id: lbl-empty
        type: Label2D
        name: Spacer
        properties:
          label: ""
      - id: nested-group
        type: Group2D
        name: Nested
        properties: {}
        children:
          - id: lbl-deep
            type: Label2D
            name: Deep Label
            properties:
              label: Hello
`;

describe('scanSceneDefinitionText', () => {
  it('finds label literals without a labelKey, recursively', () => {
    const hits = scanSceneDefinitionText(SCENE_YAML);
    expect(hits.map(h => h.nodeId)).toEqual(['btn-play', 'lbl-deep']);
    expect(hits[0]).toEqual({ nodeId: 'btn-play', nodeName: 'Play Button', literal: 'PLAY' });
  });

  it('returns nothing for broken YAML or missing root', () => {
    expect(scanSceneDefinitionText(':::not yaml{')).toEqual([]);
    expect(scanSceneDefinitionText('version: 1.0.0')).toEqual([]);
  });
});

describe('scanScriptText', () => {
  it('finds tr-family string-literal keys with line numbers', () => {
    const source = [
      `const a = this.tr('menu.play');`,
      `label.setTextKey("hud.gold", { amount });`,
      `const s = loc.trSprite('btn.skin');`,
      `banner.setText(this.trPlural('wave.failed', n));`,
      `const dyn = this.tr(someVariable); // not a literal — skipped`,
      'const tpl = this.tr(`shop.item.${id}.name`); // interpolated — skipped',
    ].join('\n');
    const hits = scanScriptText(source);
    expect(hits).toEqual([
      { fn: 'tr', key: 'menu.play', line: 1 },
      { fn: 'setTextKey', key: 'hud.gold', line: 2 },
      { fn: 'trSprite', key: 'btn.skin', line: 3 },
      { fn: 'trPlural', key: 'wave.failed', line: 4 },
    ]);
  });
});

describe('resolveMissingKey', () => {
  const strings = new Map([
    ['menu.play', 'Play'],
    ['wave.failed.other', '{count} waves failed'],
  ]);
  const sprites = new Set(['btn.skin']);
  const hit = (fn: ScriptKeyHit['fn'], key: string): ScriptKeyHit => ({ fn, key, line: 1 });

  it('checks the right section per call kind', () => {
    expect(resolveMissingKey(hit('tr', 'menu.play'), strings, sprites)).toBeNull();
    expect(resolveMissingKey(hit('tr', 'menu.quit'), strings, sprites)).toBe('menu.quit');
    expect(resolveMissingKey(hit('trSprite', 'btn.skin'), strings, sprites)).toBeNull();
    expect(resolveMissingKey(hit('trSprite', 'btn.other'), strings, sprites)).toBe('btn.other');
  });

  it('resolves trPlural through suffix keys and reports .other when absent', () => {
    expect(resolveMissingKey(hit('trPlural', 'wave.failed'), strings, sprites)).toBeNull();
    expect(resolveMissingKey(hit('trPlural', 'enemy.count'), strings, sprites)).toBe(
      'enemy.count.other'
    );
  });
});

describe('planSuggestedKeys', () => {
  const scene = (hits: Array<{ nodeId: string; nodeName: string; literal: string }>) => [
    { scenePath: 'scenes/menu.pix3scene', extractable: true, hits },
  ];

  it('slugs node names into keys', () => {
    const [item] = planSuggestedKeys(
      scene([{ nodeId: 'a', nodeName: 'Play Button', literal: 'PLAY' }]),
      new Map()
    );
    expect(item.suggestedKey).toBe('play.button');
  });

  it('shares one key between identical literals', () => {
    const items = planSuggestedKeys(
      scene([
        { nodeId: 'a', nodeName: 'Ok A', literal: 'OK' },
        { nodeId: 'b', nodeName: 'Ok B', literal: 'OK' },
      ]),
      new Map()
    );
    expect(items[0].suggestedKey).toBe(items[1].suggestedKey);
  });

  it('reuses an existing key whose value matches, suffixes on conflict', () => {
    const existing = new Map([
      ['play.button', 'PLAY'],
      ['quit.button', 'Something else'],
    ]);
    const items = planSuggestedKeys(
      scene([
        { nodeId: 'a', nodeName: 'Play Button', literal: 'PLAY' },
        { nodeId: 'b', nodeName: 'Quit Button', literal: 'QUIT' },
      ]),
      existing
    );
    expect(items[0].suggestedKey).toBe('play.button'); // same value → reuse
    expect(items[1].suggestedKey).toBe('quit.button.2'); // taken with other value → suffix
  });
});

describe('slugifyKey', () => {
  it('normalizes names to dot-separated slugs', () => {
    expect(slugifyKey('Play Button')).toBe('play.button');
    expect(slugifyKey('  HUD — Gold!  ')).toBe('hud.gold');
    expect(slugifyKey('***')).toBe('');
  });
});
