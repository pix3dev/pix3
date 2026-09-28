import { describe, expect, it } from 'vitest';

import {
  compileCharacter,
  defaultLoopForState,
  scanNumberedSequences,
  type CharacterCompileSpec,
} from './character-compiler';

const px = (path: string, width = 100, height = 100) => ({ path, width, height });

describe('scanNumberedSequences', () => {
  it('groups by directory + stem, sorts numerically and reports gaps and duplicates', () => {
    const scan = scanNumberedSequences([
      px('Goblin/Sword/idle0010.png'),
      px('Goblin/Sword/idle0002.png'),
      px('Goblin/Sword/idle0001.png'),
      px('Goblin/Sword/attack_03.png'),
      px('Goblin/Sword/attack_003.png'),
      px('Goblin/Sword/attack_1.png'),
      px('Goblin\\Bow\\run 0001.png', 100, 120),
      px('Goblin/Bow/run 0002.png'),
      px('cover.jpg', 573, 378),
    ]);

    expect(scan.unnumbered.map(f => f.path)).toEqual(['cover.jpg']);
    expect(scan.sequences.map(s => s.key)).toEqual([
      'Goblin/Bow/run',
      'Goblin/Sword/attack',
      'Goblin/Sword/idle',
    ]);

    const idle = scan.sequences[2];
    expect(idle.frames.map(f => f.number)).toEqual([1, 2, 10]);
    expect(idle.gaps).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(idle.duplicates).toEqual([]);

    const attack = scan.sequences[1];
    expect(attack.frames.map(f => f.number)).toEqual([1, 3, 3]);
    expect(attack.duplicates).toEqual([3]);
    expect(attack.gaps).toEqual([2]);

    const run = scan.sequences[0];
    expect(run.frames[0].path).toBe('Goblin/Bow/run 0001.png'); // backslashes normalized
    expect(run.mixedSizes).toEqual(['100x120', '100x100']);
  });
});

const GOBLIN: CharacterCompileSpec = {
  name: 'Goblin',
  slug: 'goblin',
  defaultVariant: 'sword',
  defaultState: 'idle',
  clips: [
    { variant: 'sword', state: 'idle', frames: [px('S/idle1.png'), px('S/idle2.png')] },
    { variant: 'sword', state: 'attack', frames: [px('S/att1.png')], fps: 15 },
    { variant: 'bow', state: 'idle', frames: [px('B/idle1.png')], loop: true },
    { variant: '', state: 'die', frames: [px('die1.png'), px('die2.png')] },
  ],
};

describe('compileCharacter', () => {
  it('emits a managed sprite folder, <variant>.<state> clips and a prefab with the component', () => {
    const out = compileCharacter(GOBLIN);

    expect(out.animationPath).toBe('sprites/goblin/goblin.pix3anim');
    expect(out.prefabPath).toBe('prefabs/Goblin.pix3scene');
    expect(out.animation.clips.map(c => c.name)).toEqual([
      'sword.idle',
      'sword.attack',
      'bow.idle',
      'die',
    ]);
    expect(out.frameFiles).toEqual([
      { sourcePath: 'S/idle1.png', targetPath: 'sprites/goblin/sword_idle_0001.png' },
      { sourcePath: 'S/idle2.png', targetPath: 'sprites/goblin/sword_idle_0002.png' },
      { sourcePath: 'S/att1.png', targetPath: 'sprites/goblin/sword_attack_0001.png' },
      { sourcePath: 'B/idle1.png', targetPath: 'sprites/goblin/bow_idle_0001.png' },
      { sourcePath: 'die1.png', targetPath: 'sprites/goblin/die_0001.png' },
      { sourcePath: 'die2.png', targetPath: 'sprites/goblin/die_0002.png' },
    ]);
    const idle = out.animation.clips[0];
    expect(idle.frames[1].texturePath).toBe('res://sprites/goblin/sword_idle_0002.png');
    expect(idle.frames[1].sourceSize).toEqual({ width: 100, height: 100 });
    expect(idle.fps).toBe(12);
    expect(idle.loop).toBe(true);
    expect(out.animation.clips[1].fps).toBe(15);
    expect(out.animation.clips[1].loop).toBe(false); // attack is one-shot by default
    expect(out.animation.clips[3].loop).toBe(false); // die too

    expect(out.prefabYaml).toContain('type: core:CharacterVisual2D');
    expect(out.prefabYaml).toContain('type: AnimatedSprite2D'); // the root IS the sprite
    expect(out.prefabYaml).not.toContain('Group2D');
    expect(out.prefabYaml).toContain('variant: sword');
    expect(out.prefabYaml).toContain('state: idle');
    expect(out.prefabYaml).toContain('animationResourcePath: res://sprites/goblin/goblin.pix3anim');
    expect(out.prefabYaml).toContain('currentClip: sword.idle');
    expect(out.prefabYaml).toContain('sizeMode: native');
    expect(out.prefabYaml).not.toMatch(/[&*]a\d/); // no YAML anchors/aliases
    // Source paths never leak into published files.
    expect(out.prefabYaml).not.toContain('S/idle1.png');
    expect(out.animationJson).not.toContain('S/idle1.png');
  });

  it('is deterministic and warns instead of guessing about fps/loop and mixed sizes', () => {
    const a = compileCharacter(GOBLIN);
    const b = compileCharacter(GOBLIN);
    expect(b.prefabYaml).toBe(a.prefabYaml);
    expect(b.animationJson).toBe(a.animationJson);
    expect(a.warnings).toContain('sword.idle: fps defaulted to 12.');
    expect(a.warnings).toContain('sword.idle: loop defaulted to true.');
    expect(a.warnings).not.toContain('sword.attack: fps defaulted to 12.');

    const mixed = compileCharacter({
      ...GOBLIN,
      clips: [{ variant: 'sword', state: 'idle', frames: [px('a1.png'), px('a2.png', 90, 100)] }],
    });
    expect(mixed.warnings.some(w => w.startsWith('sword.idle: frames differ in size'))).toBe(true);
  });

  it('refuses input that cannot become a valid bundle', () => {
    expect(() => compileCharacter({ ...GOBLIN, clips: [] })).toThrow(/at least one clip/);
    expect(() =>
      compileCharacter({
        ...GOBLIN,
        clips: [
          { variant: 'sword', state: 'idle', frames: [px('a.png')] },
          { variant: 'sword', state: 'idle', frames: [px('b.png')] },
        ],
      })
    ).toThrow(/duplicate clip "sword.idle"/);
    expect(() =>
      compileCharacter({ ...GOBLIN, defaultVariant: 'staff', defaultState: 'idle' })
    ).toThrow(/default pair staff\/idle has no clip/);
    expect(() =>
      compileCharacter({ ...GOBLIN, clips: [{ variant: 'sword', state: 'idle', frames: [] }] })
    ).toThrow(/has no frames/);
    expect(() => compileCharacter({ ...GOBLIN, slug: '../goblin' })).toThrow(/plain folder name/);
  });

  it('treats attack/die/hit as one-shot and everything else as looping by default', () => {
    expect(defaultLoopForState('idle')).toBe(true);
    expect(defaultLoopForState('run')).toBe(true);
    expect(defaultLoopForState('Attack')).toBe(false);
    expect(defaultLoopForState('die')).toBe(false);
  });
});
