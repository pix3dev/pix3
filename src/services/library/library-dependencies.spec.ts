import { describe, expect, it } from 'vitest';
import {
  collectRelativeImports,
  collectResourceReferences,
  collectUserComponentTypes,
  isSceneReference,
  isScriptReference,
  resolveImportCandidates,
  stripResScheme,
} from './library-dependencies';

describe('collectResourceReferences', () => {
  it('extracts distinct res:// references from serialized scene text', () => {
    const yaml = [
      'root:',
      '  - type: Sprite2D',
      '    properties:',
      '      texture: { type: texture, url: res://images/hero.png }',
      '  - instance: res://prefabs/button.pix3scene',
      '    components:',
      '      - type: user:Foo',
      '        clip: res://audio/click.wav',
    ].join('\n');
    const refs = collectResourceReferences(yaml);
    expect(refs).toContain('res://images/hero.png');
    expect(refs).toContain('res://prefabs/button.pix3scene');
    expect(refs).toContain('res://audio/click.wav');
    expect(refs).toHaveLength(3);
  });

  it('strips trailing punctuation and quotes around a reference', () => {
    expect(collectResourceReferences('a: "res://x/y.png",')).toEqual(['res://x/y.png']);
    expect(collectResourceReferences('list: [res://a.png, res://b.png]')).toEqual([
      'res://a.png',
      'res://b.png',
    ]);
  });

  it('ignores a bare scheme with no path', () => {
    expect(collectResourceReferences('x: res://')).toEqual([]);
  });

  it('classifies scene and script references', () => {
    expect(isSceneReference('res://a/b.pix3scene')).toBe(true);
    expect(isSceneReference('res://a/b.pix3prefab')).toBe(true);
    expect(isSceneReference('res://a/b.png')).toBe(false);
    expect(isScriptReference('res://scripts/Foo.ts')).toBe(true);
    expect(isScriptReference('res://a/b.png')).toBe(false);
  });

  it('strips the res:// scheme', () => {
    expect(stripResScheme('res://a/b.png')).toBe('a/b.png');
    expect(stripResScheme('a/b.png')).toBe('a/b.png');
  });
});

describe('collectUserComponentTypes', () => {
  it('extracts distinct user: component class names, ignoring core: types', () => {
    const yaml = [
      'components:',
      '  - type: user:Enemy',
      '  - type: core:AnimationPlayer',
      '  - type: user:Enemy',
      '  - type: user:HealthBar',
    ].join('\n');
    expect(collectUserComponentTypes(yaml)).toEqual(['Enemy', 'HealthBar']);
  });

  it('handles multiple user: refs on one line', () => {
    expect(collectUserComponentTypes('a: user:Foo b: user:Bar')).toEqual(['Foo', 'Bar']);
  });

  it('returns nothing when there are no user: types', () => {
    expect(collectUserComponentTypes('type: core:Juice')).toEqual([]);
  });
});

describe('collectRelativeImports', () => {
  it('collects relative import/export specifiers and ignores bare packages/aliases', () => {
    const source = [
      "import { Script } from '@pix3/runtime';",
      "import * as THREE from 'three';",
      "import { Helper } from './lib/helper';",
      "import Config from '../config';",
      "export * from './shared/util';",
      "import './side-effect';",
      "const mod = await import('./lazy');",
      "import { Aliased } from '@/services/Foo';",
    ].join('\n');
    expect(collectRelativeImports(source)).toEqual([
      './lib/helper',
      '../config',
      './shared/util',
      './side-effect',
      './lazy',
    ]);
  });

  it('dedups repeated specifiers', () => {
    const source = "import { A } from './x';\nimport { B } from './x';";
    expect(collectRelativeImports(source)).toEqual(['./x']);
  });
});

describe('resolveImportCandidates', () => {
  it('offers extension + index candidates for an extensionless import', () => {
    expect(resolveImportCandidates('scripts/Enemy.ts', './lib/helper')).toEqual([
      'scripts/lib/helper.ts',
      'scripts/lib/helper.js',
      'scripts/lib/helper.mjs',
      'scripts/lib/helper/index.ts',
      'scripts/lib/helper/index.js',
    ]);
  });

  it('resolves parent-directory traversal from the importing file', () => {
    expect(resolveImportCandidates('scripts/enemies/Turret.ts', '../config')).toEqual([
      'scripts/config.ts',
      'scripts/config.js',
      'scripts/config.mjs',
      'scripts/config/index.ts',
      'scripts/config/index.js',
    ]);
  });

  it('uses the specifier verbatim when it already carries an extension', () => {
    expect(resolveImportCandidates('scripts/fx/Glow.ts', './glow.glsl')).toEqual([
      'scripts/fx/glow.glsl',
    ]);
  });
});
