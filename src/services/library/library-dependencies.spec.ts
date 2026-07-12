import { describe, expect, it } from 'vitest';
import {
  collectResourceReferences,
  isSceneReference,
  isScriptReference,
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
